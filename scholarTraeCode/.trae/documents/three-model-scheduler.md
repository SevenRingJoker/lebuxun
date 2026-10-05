# 三模型分时复用调度器实施计划

## Context

现有 `runWithTools` 是单模型工具循环：按候选模型列表轮流调用 `provider.chat`，PLANNER/EXECUTOR 无角色区分。显存 14.4GB 约束下，需要把「单一 provider+modelName」升级为「角色（PLANNER/EXECUTOR/CODER）→ 当前驻留模型」的分时复用通道，并引入 DAG 驱动执行、观察者干预、L3/L4 分层验证、虚拟工作区路径劫持。

已确认决策：全量四大模块；DAG 用独立 JSON；显存监控走 Ollama `/api/ps`。

## 总体架构

```
scheduleChatWithTools
   │  (三模型模式下 bypass 候选回退，固定走 ollama 三模型)
   ▼
runWithTools
   ├── taskDag.ts          ← Planner(14B) 产出 DAG JSON，驱动轮次
   ├── modelRegistry.ts    ← switchModel / safeSwitch（显存探测 + 降级链）
   │      └── vramMonitor.ts    ← /api/ps 探测
   ├── taskSnapshot.ts(扩展) ← 切换瞬间状态外化/恢复
   ├── virtualFs.ts        ← 路径劫持 + 角色定制 S1
   ├── observer.ts         ← failedReadPaths 连击 → 14B 诊断 → 必要时 Coder
   ├── semanticValidator.ts ← L2 后 Coder 检查依赖闭环
   └── runtimeValidator.ts  ← serve 后 HTTP 探测 → 失败交 14B 诊断
```

核心约束：同一时刻只允许一个模型驻留。所有切换经 modelRegistry 的 Promise 互斥锁：卸载（`keep_alive: 0`）→ `/api/ps` 确认释放 → 加载（warmup ping）。

## 新增/改动模块

### A 阶段：基础纯函数层（可并行）

1. **`src/main/ai/vramMonitor.ts`（新增）**
   - `probeVram()` / `hasEnoughVram(needBytes)` / `waitUntilUnloaded()`
   - `TOTAL_VRAM = 14.4GB` 常量；`/api/ps` 返回 `models[].size_vram`
   - 500ms 缓存；**探测失败按充足处理**（防抖，绝不阻塞调度）

2. **`src/main/ai/taskDag.ts`（新增，纯函数零 IO）**
   - Schema：`DagNode { id, action, args, dependencies, complexity }` / `TaskDag { version, targetDir, nodes }`
   - `parseTaskDag(text)` 容错返回错误文本（不抛）
   - `buildLayers`（Kahn 拓扑，参考 subagentDag 但按 string id 依赖）
   - `createDagState / readyNodes / markDone / markFailed`
   - `checkOrderViolation(state, toolName, args)`：write/edit 按 path 后缀匹配，bash 按 init/run 正则
   - `injectRepairSubgraph(dag, failedId, repairNodes)`：失败节点与其后继间插入修复节点
   - `serializeDagState / deserializeDagState`

3. **`src/main/ai/virtualFs.ts`（新增，纯函数）**
   - `resolveVfsPath(rawPath, workspace, targetDir)`：绝对路径越界返回 null；相对路径解析到 `workspace/targetDir`；`..` 上跳越界返回 null
   - `roleEnvironmentHint(role, targetDir)`：planner/executor/coder 三种 S1 附加段
   - `isThreeModelMode(availableModelIds)`：三个角色模型均在清单中

4. **`src/main/ai/modelRegistry.ts`（新增）**（依赖 vramMonitor）
   - `ModelRole = 'planner'|'executor'|'coder'`，`MODEL_MAP`：planner→qwen3:14b(~9GB)，executor→qwen3:8b(~5.2GB)，coder→deepseek-coder-v2:lite(~8.9GB)
   - `switchModel(role, opts)`：互斥串行（Promise 队列锁）；已在驻留直接返回；显存不足走降级链
   - `safeSwitch(role)`：失败自动走完整降级链直到 8B 兜底
   - `resolveFallback(spec)`：14B→8B-thinking；coder→8B-thinking；8B→null
   - `unloadCurrentModel()`：POST `/api/generate` `keep_alive: 0`；`waitUntilUnloaded` 确认
   - `warmupModel(spec)`：1-token ping，避免冷启动超时误判

### B 阶段：切换通道（串行依赖 A）

5. **`src/main/ai/taskSnapshot.ts`（扩展）** schema v1→v2
   - `SerializedPromptContext` 追加：`activeRole`、`dagState`、`observerState`、`lastToolResults`
   - 新增 `packForSwitch(ctx, convo, dagState, { tailRounds: 3 })` / `unpackAfterSwitch(bundle)`：切换时轻量外化，executor 上下文压缩到最近 3 轮在此实现

6. **`scheduler.ts` 集成第一批**
   - 三模型模式开关：`isThreeModelMode` 为真时候选列表固定为 `[MODEL_MAP.executor.modelId]`，bypass 现有候选回退
   - 新增 `generateDagPlan`（在 `generatePlan` 旁，scheduler.ts:423 附近）：`safeSwitch('planner')` → 提示词要求输出 ```dag 代码块 → `parseTaskDag`；失败回退现有 plan 文本模式
   - runWithTools 每轮模型调用前 `switchModel(currentRoundRole)`；切换前 `packForSwitch`，切换后 `unpackAfterSwitch`
   - 批次循环工具过滤：按 `readyNodes(dagState)` 收窄暴露工具；`checkOrderViolation` 挂在现有 targetDir 越界判定（scheduler.ts:1757）同一层级
   - 路径劫持：在 `coerceToolArgs`（scheduler.ts:1721）之后统一调 `resolveVfsPath` 改写 `args.path`，builtinTools 零改动
   - promptBuilder.ts 的 `PromptContext` 加 `roleHint?: string | null`，`s1Environment` 拼接（同 `stageNoticeText` 模式）

### C 阶段：质量层（彼此可并行，都依赖 B）

7. **`src/main/ai/observer.ts`（新增）**
   - `ObserverState { readFailures, triggerCount }`；`noteReadFailure` 达 3 次返回路径；`canTrigger` 防抖上限 2
   - `buildObserverPrompt(failedPath, failureTrace, ctxSummary)` / `parseObserverVerdict(text)`：返回 `{ kind: 'strategy'|'codefix', instruction, targetFiles? }`
   - 编排在 scheduler：黑名单拦截点（scheduler.ts:1882）`noteReadFailure`；触发后 `safeSwitch('planner')` → 打包轨迹 → 14B 诊断 → strategy 注入 convo 切回 executor；codefix 走 `safeSwitch('coder')`

8. **`src/main/ai/semanticValidator.ts`（新增）**
   - `checkDependencyClosure(files, packageJson)`：纯函数，提取 import/require 包名与 dependencies 求差集
   - `buildCoderRepairPrompt(issues, files)` / `parseCoderPatches(text)`：补丁用完整文件内容而非 diff
   - `validatePatches(patches, { workspace, targetDir })`：过 syntaxGuard + targetDir 边界；落盘走 staging 审阅通道（复用 scheduler.ts:2080 `commitStaged`）
   - 挂接点：`validateTaskCompletion`（scheduler.ts:1603/2386）返回 null 后追加 L3

9. **`src/main/ai/runtimeValidator.ts`（新增）**
   - `inferPort(cmd, vueConfigContent)`：vue.config.js devServer.port 缺省 8080，vite 5173
   - `probeDevServer({ port, timeoutMs, signal })`：轮询 fetch localhost 直到 200 或 30s 超时
   - `buildRuntimeDiagnosis(probe, serveOutput, files)`：失败时打包供 14B observer
   - 挂接点：`ctx.ranServe = true` 置位（scheduler.ts:2194）之后；失败走 observer 通道

10. **`scheduler.ts` 集成第二批**
    - complexity 路由：节点 `complexity==='high'` 且 action 为 write/edit → `safeSwitch('coder')` 执行该节点，完成后切回
    - observer/semantic/runtime 的失败信号统一走 replanner 的 `noteFailure` 通道

### D 阶段：收尾

11. E2E 联调（真实 Ollama + 三模型）；恢复路径验证（interrupted 快照 → resume → 角色/DAG 状态还原）
12. `ollamaProvider.ts` 导出 `HOST`（单行改动）

## 模块依赖关系

```
vramMonitor        无内部依赖
modelRegistry      → vramMonitor, ollamaProvider(HOST)
taskDag            无内部依赖（纯函数）
taskSnapshot(扩展)  → taskDag(类型), promptBuilder, validation, replanner（现有）
virtualFs          无内部依赖（纯函数）
observer           → taskDag(类型)；编排在 scheduler 调 modelRegistry
semanticValidator  → syntaxGuard, handlers/staging（薄壳）
runtimeValidator   无内部依赖
scheduler.ts       → 以上全部
promptBuilder.ts   ← virtualFs 的 roleEnvironmentHint 经 ctx.roleHint 传入
builtinTools.ts    零改动（路径劫持收敛在 scheduler）
```

无循环依赖：所有新模块在纯函数层，scheduler 是唯一编排者。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `/api/ps` 不可用/字段缺失 | 探测失败按充足处理；`waitUntilUnloaded` 10s 超时按成功；切换失败由降级链兜底到 8B |
| DAG JSON 解析失败 | `parseTaskDag` 容错；回退现有 plan 文本 + todoWrite 模式；提示词给完整 schema 示例 |
| Coder 补丁格式错误 | 补丁用完整文件内容；parse 失败走 replanner；validatePatches 过 syntaxGuard + targetDir 边界；落盘走 staging |
| 切换瞬间在途请求显存叠加 | 切换通道互斥锁；切换前 `provider.abort()` 终止在途；卸载后轮询确认 size_vram 归零 |
| 三模型与候选回退冲突 | 三模型模式 bypass 候选循环，单候选 `[executor.modelId]` |
| executor 压缩丢关键信息 | 保留 system + 首条 user + pinned 策略指令；createdFiles/dagState 在 ctx 独立存活 |
| 切换与暂停/恢复交叉 | snapshot v2 记录 activeRole/dagState；resume 先 safeSwitch 到快照角色 |
| 工具过滤导致模型困惑 | 只收窄不新增；拦截文案列出当前 ready 节点 |

## 测试策略

- **零改动复用**：planDrift/replanner/validation/subagentDag/bashGate/syntaxGuard 测试
- **需要更新**：`scheduler.test.ts` 保留旧签名兼容包装，旧用例零改动，新增三模型 describe 块；`taskSnapshot.test.ts` 加 v2 序列化用例
- **新增测试**：modelRegistry / vramMonitor / taskDag / virtualFs / observer / semanticValidator / runtimeValidator 各一份，mock fetch 覆盖 `/api/ps`、`/api/generate`、dev server 探测
- **E2E**：`p3e2e.test.ts` 追加三模型 smoke 用例，标记 skipUnless（需真实 Ollama）

## 验证方式

1. `npx vitest run` 全量单测（含新增 7 份）
2. `npx tsc --noEmit` 零错误
3. 手动 E2E：启动真实 Ollama，加载 qwen3:14b/qwen3:8b/deepseek-coder-v2:lite，发起「创建 Vue2 项目」任务，观察：
   - Planner 生成 DAG → 切 Executor 按序执行
   - 显存监控日志：`/api/ps` 切换前后 size_vram 归零/加载
   - 复杂节点自动切 Coder → 补丁落盘走 staging
   - serve 后 runtimeValidator 探测 localhost:8080 → 200
   - 失败路径：failedReadPaths 3 次 → observer 14B 诊断 → 注入策略指令

## 关键文件

新增：
- `src/main/ai/vramMonitor.ts`、`modelRegistry.ts`、`taskDag.ts`、`virtualFs.ts`、`observer.ts`、`semanticValidator.ts`、`runtimeValidator.ts`

改动：
- `src/main/ai/scheduler.ts`（+450 行集成，−30 候选循环分支化）
- `src/main/ai/taskSnapshot.ts`（schema v2，+80 行）
- `src/main/ai/promptBuilder.ts`（+15 行 roleHint）
- `src/main/ai/providers/ollamaProvider.ts`（+2 行导出 HOST）

估计代码量：实现 ~1910 行 + 测试 ~1410 行 ≈ 3300 行。
