# 三层模型治理体系 · 详细设计文档

> **状态**：待评审（未实施）
> **作者**：TraeCode
> **创建日期**：2026-10-05
> **关联项目**：scholarTraeCode（Electron + Vue3 + TS）
> **前置阅读**：[src/main/ai/adaptiveScheduler.ts](../../src/main/ai/adaptiveScheduler.ts) · [src/main/ai/modelRegistry.ts](../../src/main/ai/modelRegistry.ts) · [src/main/ai/providers/ollamaProvider.ts](../../src/main/ai/providers/ollamaProvider.ts)

---

## 0. 文档目的

本文件是 **破坏性重构** 的实施蓝图。目标：用三层架构（决策层 / 治理层 / 执行层）替换当前的"硬编码 + 自适应并存、双状态源、路由双轨"过渡形态。

**本文件只描述设计，不包含实施 commit。** 实施前需用户确认 §7  checklist 中每一步的范围。

---

## 1. 现状问题诊断

### 1.1 三个核心痛点

| # | 痛点 | 现状证据 | 已导致的线上问题 |
|---|------|---------|----------------|
| P1 | **模型知识分散** | 硬编码 `MODEL_MAP`/`qwen3:14b` 残留在旧路径；`adaptiveScheduler` 自适应画像又走一套 | `model not found`（历史）；切换路径选择混乱 |
| P2 | **状态双写** | `modelRegistry.current` + `currentRole_` 与 `ollamaProvider.currentModelName` + `currentNumCtx` + `currentRole_` 各自维护 | provider 同步失败时 chat 拿旧模型；UI 显示与真实驻留不一致 |
| P3 | **路由双轨** | [scheduler.ts L9](../../src/main/ai/scheduler.ts#L9) 仍 `import { classify, route } from './router'`；同时 `safeSwitch`/`switchModel` 走自适应路径 | 候选列表生成逻辑互相覆盖；`'auto'` 字面量穿到 wire payload |

### 1.2 现状架构图（简化）

```
┌────────────────────────────────────────────────────────────┐
│ scheduler.ts                                                │
│  ┌─ classify/route (旧 router.ts) ──┐                       │
│  │   生成候选列表 ['ollama:auto']    │                       │
│  └─→ safeSwitch / switchModel ──────┼─→ modelRegistry      │
│         (新自适应路径)               │     ├─ current       │
└──────────────────────────────────────┼─────┴─ currentRole_ │
                                       │                     │
                                       │  setCurrentModel ↓  │ (双写!)
                                       │                     │
                                       │     ollamaProvider  │
                                       │     ├─ currentModelName
                                       │     ├─ currentNumCtx
                                       │     └─ currentRole_
                                       └─────────────────────┘
```

问题：箭头双向、状态两存、决策两处。

---

## 2. 目标架构：三层职责分离

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  决策层 (Brain)                                              │
│  ─ AdaptiveScheduler (adaptiveScheduler.ts)                │
│     ├─ resolveModelForTask(taskType, context)  ★ 新增唯一入口 │
│     ├─ selectModelForRoleWithDiagnostics                   │
│     └─ ROLE_REQUIREMENTS (画像表)                           │
│                                                              │
│     职责：根据任务类型/角色 + 显存 → 给出 ModelChoice          │
│     不负责：模型加载、HTTP 调用、状态存储                       │
└──────────────────────────────┬──────────────────────────────┘
                               │ ModelChoice
                               ↓
┌─────────────────────────────────────────────────────────────┐
│  治理层 (Governor)  ★ 唯一状态源                              │
│  ─ ModelRegistry (modelRegistry.ts)                         │
│     ├─ current: ModelChoice | null          (唯一驻留记录)   │
│     ├─ currentRole_: ModelRole | null                        │
│     ├─ switchModel / safeSwitch / doSwitch                   │
│     ├─ unloadCurrentModel / warmupModel                      │
│     └─ getActiveModel()  ★ 新增：{ modelName, numCtx, role } │
│                                                              │
│  ─ ModelDiscovery (modelDiscovery.ts)                       │
│     └─ listOllamaModels / listLoadedModels / 画像           │
│                                                              │
│  ─ VRAMMonitor (vramMonitor.ts)                             │
│     └─ getTotalVram / getFreeVram / waitUntilUnloaded       │
│         ★ 收归所有显存探测，其它模块禁止直接调                │
│                                                              │
│     职责：模型发现、显存预算、生命周期（load/unload/switch）    │
│     不负责：任务分类、推理请求                                  │
└──────────────────────────────┬──────────────────────────────┘
                               │ 每次请求时主动查询
                               │ getActiveModel()
                               ↓
┌─────────────────────────────────────────────────────────────┐
│  执行层 (Hands)                                              │
│  ─ OllamaProvider (providers/ollamaProvider.ts)             │
│     ├─ chat({ messages, tools?, signal? })   ★ 删除 model 参 │
│     ├─ chatStream({ messages, signal? }, cb) ★ 删除 model 参 │
│     ├─ listModels / health / abort                           │
│     └─ ✘ currentModelName / currentNumCtx / currentRole_     │
│        ✘ switchingLock / setCurrentModel / switchToRole      │
│        (全部删除，状态上移到 Registry)                         │
│                                                              │
│     职责：HTTP 请求、Abort、流式解析                           │
│     不负责：选择哪个模型、当前驻留的是谁                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 单一数据流（关键不变量）

```
switchModel(role) ─→ Registry 写 current ─→ (无主动通知)
                                              │
chat(messages)  ─→ Provider 读 getActiveModel() ─→ 发请求
```

**核心变化**：从"Registry 推 → Provider 存"改为"Provider 拉 → Registry 是源"。Provider 不再持有任何模型状态，每次请求时现查。

---

## 3. 破坏性重构点（接口变更）

### 3.1 `AiProvider` 接口（types.ts L90-125）

**改前**：

```typescript
chat(params: {
  model: string          // ← 删除
  messages: AiMessage[]
  tools?: unknown[]
  signal?: AbortSignal
}): Promise<...>

chatStream(
  params: { model: string; messages: AiMessage[]; signal?: AbortSignal },  // ← 删除 model
  callbacks: AiStreamCallbacks
): Promise<...>
```

**改后**：

```typescript
chat(params: {
  messages: AiMessage[]
  tools?: unknown[]
  signal?: AbortSignal
}): Promise<...>

chatStream(
  params: { messages: AiMessage[]; signal?: AbortSignal },
  callbacks: AiStreamCallbacks
): Promise<...>
```

**理由**：模型选择是治理层职责，Provider 不应接受外部传入的模型名。这是消除 `'auto'` 字面量穿透到 wire 的根本手段。

### 3.2 `OllamaProvider` 字段裁剪

| 字段 | 处理 | 理由 |
|------|------|------|
| `currentModelName` | **删除** | 状态上移到 Registry |
| `currentNumCtx` | **删除** | 同上 |
| `currentRole_` | **删除** | 同上 |
| `switchingLock` | **删除** | 切换互斥由 Registry 的 `switchQueue` 统一负责 |
| `setCurrentModel()` | **删除** | 不再需要主动同步 |
| `switchToRole()` | **删除** | 改由 scheduler 直接调 `modelRegistry.switchModel` |
| `_doSwitchToRole()` | **删除** | 同上 |
| `getActiveModel()` | **删除**（从 Provider） | Provider 内部不需要这个方法；改为调用 `modelRegistry.getActiveModel()` |
| `electronOllama` / `healthy` / `inflight` / `shutdownRegistered` | **保留** | 这些是 Provider 自己的服务生命周期，与模型状态无关 |

### 3.3 `modelRegistry` 新增公开查询

```typescript
/**
 * 治理层唯一对外查询：返回当前驻留的模型快照。
 * Provider 每次发请求前必须调用此方法获取真实模型名与上下文。
 * 返回 null 表示当前无模型驻留（chat 应返回明确错误而非用 'auto'）。
 */
export function getActiveModel(): {
  modelName: string
  numCtx: number
  role: ModelRole
} | null {
  if (!current || !currentRole_) return null
  return {
    modelName: current.profile.name,
    numCtx: current.numCtx,
    role: currentRole_
  }
}
```

### 3.4 `ollamaProvider.chat` 新形态

```typescript
import { getActiveModel } from '../modelRegistry'

async chat(params: {
  messages: AiMessage[]
  tools?: unknown[]
  signal?: AbortSignal
}): Promise<{ ok: boolean; content?: string; toolCalls?: unknown[]; usage?: {...}; error?: string }> {
  const { controller, signal } = this.beginRequest(params.signal)
  try {
    await this.ensure()
    // 每次请求时向治理层查询当前驻留模型
    const active = getActiveModel()
    if (!active) {
      return {
        ok: false,
        error: '[TraeCode] 模型未驻留，请先调用 modelRegistry.switchModel(role)'
      }
    }
    const wireMessages = await toOllamaMessages(params.messages)
    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: active.modelName,                  // ← 来自治理层
        messages: wireMessages,
        tools: params.tools,
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { num_ctx: active.numCtx }       // ← 来自治理层
      })
    })
    // ... 后续响应处理不变
  } finally {
    this.inflight.delete(controller)
  }
}
```

`chatStream` 同构修改。

### 3.5 `modelRegistry.doSwitch` 简化

```typescript
async function doSwitch(
  target: ModelChoice,
  role: ModelRole,
  opts?: { signal?: AbortSignal }
): Promise<void> {
  if (current) {
    await unloadCurrentModel({ signal: opts?.signal })
  }
  const warm = await warmupModel(target, { signal: opts?.signal })
  if (!warm.ok) {
    throw new Error(`warmup ${target.profile.name} 失败：${warm.error}`)
  }
  current = target
  currentRole_ = role
  // ★ 删除：provider.setCurrentModel 同步块（不再需要）
}
```

### 3.6 `scheduler.ts` 路由统一

**新增** `adaptiveScheduler.resolveModelForTask`：

```typescript
/**
 * 决策层唯一对外入口：根据任务类型/角色 + 当前显存 → 给出最终 ModelChoice。
 * 内部完成：角色推断（若有 taskType→role 映射需求）→ 候选过滤 → 显存档位递减。
 * 
 * @param role 任务角色（planner/executor/coder/observer）
 * @param opts.signal 取消信号
 * @returns 选中模型 + 诊断信息；null 表示无可用模型
 */
export async function resolveModelForTask(
  role: ModelRole,
  opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<SelectionDiagnostics> {
  const freeVram = await getFreeVram(opts)
  return selectModelForRoleWithDiagnostics(role, freeVram, opts)
}
```

**scheduler.ts 改造点**：

| 位置 | 改前 | 改后 |
|------|------|------|
| L9 | `import { classify, route } from './router'` | **删除整个 import** |
| L260-270 `resolveCandidates` | 调 `route(taskType, models)` 生成候选 ID 列表 | **删除整个函数**；三模型模式下不再需要候选列表，直接调 `switchModel(role)` |
| L299-302 `scheduleChatStream` 顶部 | `classify(...)` + `resolveCandidates(...)` | 保留 `classify` 用于推断 role（如需要）；删除 `resolveCandidates` 调用，改为 `safeSwitch(inferredRole)` |
| L845 同样模式 | 同上 | 同上 |
| 工具调用循环 | 候选 fallback 循环 | 简化为单次调用；失败由 `safeSwitch` 内部的 executor 兜底处理 |

**保留 `classifyMutationTool`**：这是工具副作用分类，与模型路由无关，继续从 `./router` 导入（或迁移到独立模块）。

### 3.7 VRAMMonitor 收归

当前散落的显存探测调用：

- `ollamaProvider._doSwitchToRole` L349 调 `getFreeVram` —— **删除**（该方法整体删除）
- `modelRegistry.switchModel` L71 调 `getFreeVram` —— **保留**（治理层合法调用）
- `adaptiveScheduler.selectModelForRoleWithDiagnostics` 通过参数接收 `availableVram` —— **保留**（决策层不直接调 VRAMMonitor，由治理层注入）

**约束**：除 `modelRegistry.ts` 外，任何模块禁止 `import { getFreeVram } from './vramMonitor'`。在 `vramMonitor.ts` 顶部加注释明确此约定，并加 ESLint `no-restricted-imports` 规则（可选）。

---

## 4. 状态迁移路径

### 4.1 运行时状态对照表

| 状态 | 旧位置 | 新位置 | 迁移方式 |
|------|--------|--------|---------|
| 当前驻留模型名 | `ollamaProvider.currentModelName` + `modelRegistry.current.profile.name` | `modelRegistry.current.profile.name`（唯一） | Provider 启动时不再初始化；首次 chat 时若 `getActiveModel()` 返回 null，报错引导 scheduler 先 switch |
| 当前驻留 numCtx | `ollamaProvider.currentNumCtx` + `modelRegistry.current.numCtx` | `modelRegistry.current.numCtx`（唯一） | 同上 |
| 当前角色 | `ollamaProvider.currentRole_` + `modelRegistry.currentRole_` | `modelRegistry.currentRole_`（唯一） | 同上 |
| 切换互斥 | `ollamaProvider.switchingLock` + `modelRegistry.switchQueue` | `modelRegistry.switchQueue`（唯一） | Provider 不再有切换逻辑 |
| 在途请求 | `ollamaProvider.inflight` | 不变 | Provider 自身请求生命周期，与模型状态无关 |

### 4.2 启动时序

**改前**：
```
app ready → Provider 构造 → currentModelName=null → ... → 用户提问 → scheduler 调 switchToRole → provider._doSwitchToRole → 写 provider.currentModelName → 调 chat → 用 currentModelName 发请求
```

**改后**：
```
app ready → Provider 构造（无模型状态） → ... → 用户提问 → scheduler 调 modelRegistry.switchModel(role) → Registry 写 current → scheduler 调 provider.chat(messages) → Provider 调 getActiveModel() 读 → 发请求
```

---

## 5. 测试迁移方案

### 5.1 受影响测试清单（需逐一核对）

| 测试文件 | 当前用法 | 迁移方案 |
|---------|---------|---------|
| `providerAbort.test.ts` | mock `provider.currentModelName = 'x'` | 改为 mock `modelRegistry._setCurrentForTest({ profile: { name: 'x', ... }, numCtx: 8192 }, 'executor')` |
| `scheduler.test.ts` 系列 | 检查候选列表生成 | 删除候选列表断言；改为断言 `safeSwitch` 被以正确 role 调用 |
| `modelRegistry.test.ts` | 已存在 | 增加 `getActiveModel()` 测试用例 |
| `ollamaProvider.test.ts` | mock `setCurrentModel` | 删除相关 mock；改为通过 `_setCurrentForTest` 准备状态 |
| `threeModel.test.ts` | 三模型分时复用集成测试 | 走 `switchModel` + `chat` 完整链路，断言 wire payload 中无 `'auto'` |

### 5.2 新增测试用例

1. **`getActiveModel()` 单元测试**
   - 初始状态返回 null
   - `_setCurrentForTest` 后返回正确快照
   - `unloadCurrentModel` 后返回 null

2. **Provider 无驻留模型时的错误路径**
   - 未调用 `switchModel` 直接 `chat` → 返回 `{ ok: false, error: '模型未驻留...' }`
   - `chatStream` 同上

3. **端到端"无 auto 字面量"断言**
   - mock fetch，捕获 wire payload
   - 走完整 `switchModel('executor') → chat(...)` 链路
   - 断言 `payload.model !== 'auto'` 且 `payload.model === <真实模型名>`

4. **状态单源验证**
   - 切换模型后，Provider 内部无任何字段引用旧模型
   - 通过 `Object.keys(provider)` 反射断言不存在 `currentModelName` 等字段（可选，防回归）

---

## 6. 风险与回滚预案

### 6.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Provider 接口变更导致外部调用方编译错误 | 高 | 编译期暴露 | tsc 立即报错；逐调用点迁移 |
| 删除 `switchToRole` 导致 UI 模型状态栏失效 | 中 | UI 显示异常 | 同步改 `ai:listLoadedModels` / `ai:diagnoseRoleSelection` IPC 实现，改从 `modelRegistry` 读 |
| 候选列表删除后，网络故障 fallback 失效 | 中 | 单点失败 | `safeSwitch` 内部已有 executor 兜底；真实跨 provider fallback（如 Ollama → OpenAI）通过未来在 Registry 层实现，不在本次范围 |
| `getActiveModel()` 高频调用性能 | 低 | 可忽略 | 纯对象读取，O(1) |
| 测试大面积红 | 中 | 阻塞合入 | 按 §5.1 清单逐一迁移；先修编译错，再修断言错 |

### 6.2 回滚预案

每个阶段独立 commit，可单独 revert：

```
阶段一 commit: refactor(ai): unify model state in modelRegistry
  - 删除 provider 模型状态字段
  - provider.chat/chatStream 改从 registry 读
  - 新增 registry.getActiveModel()
  - 迁移相关测试

阶段二 commit: refactor(ai): unify routing through adaptiveScheduler
  - scheduler.ts 删除 classify/route 旧路径
  - 新增 adaptiveScheduler.resolveModelForTask
  - 删除 resolveCandidates

阶段三 commit: refactor(ai): consolidate vram monitoring
  - 收归 getFreeVram 调用
  - 删除 modelRegistry 重复的选择逻辑（如有）
  - 完善 VRAMMonitor 告警
```

**回滚触发条件**：
- 阶段一：集成测试失败率 > 5%，或线上出现"模型未驻留"误报
- 阶段二：`safeSwitch` 兜底路径在真实硬件上无法加载 executor 模型
- 阶段三：纯重构无功能变化，回滚仅限代码审查不通过

**回滚操作**：`git revert <commit-sha>`，不改其它 commit。每个阶段完成后跑 `npx tsc --noEmit && npx vitest run` 作为合入门禁。

---

## 7. 分阶段实施 Checklist

### 阶段一：统一状态源（最高优先级）

- [ ] 1.1 `modelRegistry.ts` 新增 `getActiveModel()` 公开方法
- [ ] 1.2 `modelRegistry.ts` 删除 `doSwitch` 中的 `provider.setCurrentModel` 同步块
- [ ] 1.3 `ollamaProvider.ts` 删除字段：`currentModelName` / `currentNumCtx` / `currentRole_` / `switchingLock`
- [ ] 1.4 `ollamaProvider.ts` 删除方法：`setCurrentModel` / `getActiveModel` / `switchToRole` / `_doSwitchToRole`
- [ ] 1.5 `ollamaProvider.ts` `chat` 改签名：删除 `model` 参数；方法体改从 `modelRegistry.getActiveModel()` 读
- [ ] 1.6 `ollamaProvider.ts` `chatStream` 同上
- [ ] 1.7 `types.ts` `AiProvider.chat` / `chatStream` 签名删除 `model` 参数
- [ ] 1.8 全代码库搜索 `\.chat\(\{[^}]*model:` 与 `\.chatStream\(\{[^}]*model:`，逐调用点迁移
- [ ] 1.9 迁移测试（按 §5.1）
- [ ] 1.10 新增 §5.2 测试用例 1、2、3
- [ ] 1.11 `npx tsc --noEmit` 零错误
- [ ] 1.12 `npx vitest run` 全量通过
- [ ] 1.13 手动验证：UI 模型状态栏、发起 chat、流式 chat、工具调用循环
- [ ] 1.14 commit

### 阶段二：统一路由

- [ ] 2.1 `adaptiveScheduler.ts` 新增 `resolveModelForTask(role, opts)` 入口
- [ ] 2.2 `scheduler.ts` 删除 `import { classify, route } from './router'`（保留 `classifyMutationTool`）
- [ ] 2.3 `scheduler.ts` 删除 `resolveCandidates` 函数
- [ ] 2.4 `scheduler.ts` `scheduleChatStream` / `scheduleChatWithTools` 改走 `safeSwitch(role)` 单路径
- [ ] 2.5 删除候选 fallback 循环（保留 `safeSwitch` 内部 executor 兜底）
- [ ] 2.6 删除 `nextCandidateAfterNetworkError`（如确认无其它调用）
- [ ] 2.7 同步迁移 `runWithDag` / `runObserverIntervention` / `runSemanticValidation` / `runRuntimeValidation` / `runCoderForNode` 的调用点
- [ ] 2.8 测试迁移
- [ ] 2.9 `npx tsc --noEmit` + `npx vitest run` 通过
- [ ] 2.10 commit

### 阶段三：技术债清理

- [ ] 3.1 全代码库 grep `qwen3:14b` / `qwen3:8b` / `qwen2.5` / `deepseek-coder-v2` / `MODEL_MAP` / `modelMap`，确认零残留（注释除外）
- [ ] 3.2 统一 `ModelProfile`（modelDiscovery）与 `RoleRequirement`（adaptiveScheduler）的能力字段定义
- [ ] 3.3 收归显存探测：grep `getFreeVram` / `listLoadedModels`，确保仅 `modelRegistry` 与 `vramMonitor` 内部调用
- [ ] 3.4 评估 `router.ts` 是否可删除整个文件（若 `classify` / `classifyMutationTool` 已无引用，或迁出）
- [ ] 3.5 `vramMonitor.ts` 增加显存低水位告警（可选，本阶段可暂缓）
- [ ] 3.6 新增 §5.2 测试用例 4（状态单源反射断言，可选）
- [ ] 3.7 `npx tsc --noEmit` + `npx vitest run` 通过
- [ ] 3.8 commit

### 收尾

- [ ] 4.1 更新 [project_memory.md](../../../.trae-cn/memory/projects/-d-git----p2-baf3e4a1976ee93ce6d9/project_memory.md)：移除"OllamaProvider 类需提供 setCurrentModel 公开方法"等过时约定
- [ ] 4.2 更新 [README.md](../../README.md)（若涉及架构图）
- [ ] 4.3 在 `documents/` 添加实施总结（after-action review），记录实际遇到的坑

---

## 8. 关键设计决策记录（ADR 摘要）

| 决策 | 选择 | 替代方案 | 理由 |
|------|------|---------|------|
| Provider 状态访问模式 | **拉模式**（每次请求查 Registry） | 推模式（Registry setCurrentModel 同步） | 消除双写；Provider 无需关心一致性；延迟可忽略（O(1) 对象读取） |
| 切换互斥位置 | **Registry `switchQueue`** | Provider `switchingLock` | 治理层唯一入口；Provider 不再参与切换 |
| 候选 fallback 策略 | **保留 `safeSwitch` 内部 executor 兜底** | 跨 provider 候选列表 | 当前仅 Ollama 单 provider；跨 provider 留待 Registry 未来扩展 |
| 接口破坏性 | **直接删除 `model` 参数，不留 deprecated** | 标记 `@deprecated` 渐迁 | 项目处于内部迭代期，无外部消费者；一次性 breaking 更彻底 |
| 任务分类 `classify` | **保留**（用于推断 role），但与路由解耦 | 完全删除 | `classify` 的 taskType→role 映射仍有价值；只是不再用于生成候选列表 |
| `router.ts` 去留 | **阶段三评估** | 立即删除 | `classifyMutationTool` 可能仍被引用；先观察阶段二完成后真实引用 |

---

## 9. 待用户确认的开放问题

1. **`classify` 的去留**：阶段二是否完全删除 `classify`？或保留它推断 role（planner/coder/observer），删除路由部分？倾向后者。
2. **跨 provider fallback**：当前仅 Ollama 单 provider。是否在本次重构中预留 `Provider:Registry` 接口（多 provider 注册中心），还是严格 YAGNI 等真实有第二个 provider 时再做？倾向后者。
3. **`router.ts` 文件去留**：阶段三如果 `classifyMutationTool` 仍被 scheduler 引用，是否将其迁移到独立模块（如 `mutationClassifier.ts`）后删除 `router.ts`？倾向迁移后删除。
4. **`ai:diagnoseRoleSelection` IPC 的语义**：当前实现可能依赖 provider 内部状态。重构后改为完全从 `modelRegistry` + `adaptiveScheduler` 读，是否影响 ChatPanel 模型状态栏的展示字段？需要前端联调。
5. **测试迁移的兼容窗口**：是否允许在阶段一保留旧测试（标记 `.skip`）以减少单 commit 大小？还是一次性全改？倾向一次性全改（破坏性重构的代价）。

---

## 10. 附录：核心文件改动速查

| 文件 | 改动类型 | 关键改动 |
|------|---------|---------|
| [src/main/ai/types.ts](../../src/main/ai/types.ts) | 修改 | `chat` / `chatStream` 删除 `model` 参数 |
| [src/main/ai/modelRegistry.ts](../../src/main/ai/modelRegistry.ts) | 修改 | 新增 `getActiveModel()`；删除 `doSwitch` 中的 provider 同步 |
| [src/main/ai/providers/ollamaProvider.ts](../../src/main/ai/providers/ollamaProvider.ts) | 重写 | 删除所有模型状态字段；`chat` / `chatStream` 改从 Registry 读 |
| [src/main/ai/adaptiveScheduler.ts](../../src/main/ai/adaptiveScheduler.ts) | 修改 | 新增 `resolveModelForTask()` |
| [src/main/ai/scheduler.ts](../../src/main/ai/scheduler.ts) | 大改 | 删除 `classify` / `route` 旧路径；删除候选列表；统一走 `safeSwitch` |
| [src/main/ai/router.ts](../../src/main/ai/router.ts) | 评估删除 | 阶段三决定 |
| [src/main/ai/vramMonitor.ts](../../src/main/ai/vramMonitor.ts) | 微调 | 顶部加调用约束注释 |
| [src/main/ai/modelDiscovery.ts](../../src/main/ai/modelDiscovery.ts) | 无改动 | 保持画像发现 |
| [src/main/index.ts](../../src/main/index.ts) | 无改动 | 全局错误捕获已就绪 |
| `src/main/ai/__tests__/providerAbort.test.ts` | 迁移 | mock 方式变更 |
| `src/main/ai/__tests__/scheduler*.test.ts` | 迁移 | 候选列表断言删除 |
| `src/main/ai/__tests__/modelRegistry.test.ts` | 新增用例 | `getActiveModel()` 测试 |

---

**文档结束。等待用户评审 §7 Checklist 与 §9 开放问题。**
