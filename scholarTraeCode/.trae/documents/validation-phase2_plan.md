# P1⑯ 验证锁二期增强 · 实施计划

> 创建：2026-09-30。在 P1⑯ 验证锁通用化（一期已交付）基础上做二期增强。
> 一期成果：`validation.ts` 纯函数层（四类验证器 + manifest + 聚合 + vueScaffold 预置）、`scheduler.ts` 薄壳 `validateProjectCreation`、537 单测全绿。

## 一、范围

用户全选 4 项二期增强：① IPC 暴露 validation API；② generatePlan 自动注入 manifest；③ 前端 UI 编辑 manifest；④ 重构 isTodoSatisfied/fileHintsOf。

### 1.1 各项要点

**① IPC 暴露 validation API**（前置项，③前端 UI 编辑依赖它）
- 新增 `src/main/handlers/validation.ts`：6 个 IPC 通道
  - `validation:runRule`（单条规则 + ctx 快照）
  - `validation:runValidation`（manifest + ctx 快照）
  - `validation:parseManifest`（解析文本/对象为 manifest）
  - `validation:formatMessage`（格式化 summary 为消息）
  - `validation:getCurrent`（取当前会话的 manifest，从 scheduler 状态）
  - `validation:setCurrent`（前端编辑后写回，影响下一次收尾校验）
- preload `src/preload/index.ts` 桥 `window.api.validation.*`
- `src/renderer/src/api.d.ts` 类型同步
- 注册点 `src/main/index.ts` 第 174 行附近 `registerValidationHandlers()`

**② generatePlan 自动注入 manifest**
- `PromptContext` 加字段 `artifactManifest?: ArtifactManifest | null`
- `generatePlan`（在 scheduler.ts 或独立 plan 生成模块）的 prompt 模板里加一段「产物清单声明」要求：让 reasoning 模型在 plan 文本末尾输出 ```manifest
{ id, rules: [{id, description, kind, path?, command?}] }
``` 代码块
- scheduler 解析 plan 文本提取该代码块，调用 `parseManifest`，成功则赋给 `ctx.artifactManifest`
- `validateProjectCreation` 重命名为 `validateTaskCompletion(ctx)`：优先用 `ctx.artifactManifest`，缺省回退 `vueScaffoldManifest`（仅项目创建场景），再缺省返回 null（无校验）
- 收尾分支（第 663 行）与 dedup stall 分支（第 837 行）改为调用 `validateTaskCompletion`
- 解析容错：plan 文本无 manifest 段、JSON 损坏、规则字段缺失时静默回退到 vueScaffold/null，不阻断主流程

**③ 前端 UI 编辑 manifest**
- `DebugPanel.vue` 左栏分段切换加「验证」段（或新建 `ValidationPanel.vue` 嵌入 DebugPanel）
- 显示当前 manifest（id + rules 表格：id/description/kind/path/command/severity）
- 编辑：增删规则、改字段、JSON 模式编辑器
- 保存：调用 `validation:setCurrent` 写回主进程，影响下一次收尾校验
- 手动触发：`validation:runValidation` 按当前 ctx 快照跑一次校验，展示 failed 列表
- 复用 `.modal-overlay` 样式，禁原生 confirm

**④ 重构 isTodoSatisfied/fileHintsOf**（独立项，风险最高）
- `fileHintsOf(content)` 改为从 manifest 的 fileExists 规则中提取 path 集合，与 Todo 文本做子串匹配
- `isTodoSatisfied(todo, ctx)` 改为：对匹配到的规则调用 `runRule(rule, vctx)` 判定
- 保留「批量任务要文件齐全」语义：一条 Todo 匹配多条规则时全部通过才算完成
- 保留 npm install/serve/mkdir 的命令类判断（走 commandExecuted 规则）
- 缺省 manifest（非项目创建）时回退到旧 fileHintsOf 硬编码逻辑，保兼容
- `autoUpdateTodos` 调用点不变

### 1.2 二期不做（仍保留）

- manifest 持久化到 `.trae/` 跨会话
- 跨任务模板库（manifest 复用）
- 前端 manifest 可视化拖拽编辑
- 验证锁失败时前端实时提示（进度条/红条）

### 1.3 依赖顺序

① IPC 暴露 → ② generatePlan 注入 → ③ 前端 UI 编辑 → ④ 重构 isTodoSatisfied

④ 独立可并行，但风险高放最后。

## 二、单测计划（目标 +35 例，537 → 572）

**① IPC 层**（5 例）：runRule/runValidation/parseManifest/formatMessage 的 IPC 调用往返（mock ctx）；getCurrent/setCurrent 状态读写。

**② generatePlan 注入**（12 例）：
- 解析 plan 文本中的 manifest 代码块（合法 JSON → manifest）
- 无 manifest 段 → null
- JSON 损坏 → null
- 规则字段缺失 → 跳过该规则
- 多个 manifest 代码块 → 取第一个
- manifest 段在 plan 中间/末尾均能解析
- validateTaskCompletion：ctx.artifactManifest 优先 → 用之；缺省 + isProjectCreation → vueScaffold；缺省 + 非项目创建 → null
- 收尾分支调用 validateTaskCompletion 行为等价（vueScaffold 场景）

**③ 前端 UI**：CDP 真窗冒烟覆盖，不配单测（Vue 组件逻辑薄）。

**④ isTodoSatisfied 重构**（18 例）：
- 有 manifest 时：fileExists 规则匹配 Todo 文本 → 走 runRule
- 多规则匹配 → 全部通过才算完成
- 命令类规则（npm install/serve/mkdir）→ 走 commandExecuted
- 缺省 manifest → 回退旧 fileHintsOf 硬编码
- 既有 5 例 isTodoSatisfied 单测全绿（行为等价）

## 三、验证三件套

1. typecheck 主进程 + 渲染进程零错
2. vitest 全量 537 → 572 全绿
3. CDP 真窗冒烟：
   - validation IPC 6 通道暴露且可调用
   - generatePlan 输出含 manifest 段时被正确解析（用 stub 模型输出固定 plan 文本）
   - 前端 ValidationPanel 渲染、编辑保存、手动触发校验
   - isTodoSatisfied 重构后项目创建场景 Todo 推进行为等价

## 四、同步双文档

- 《项目结构说明.md》7.1 表 P1⑯ 行更新二期状态、7.2 详细设计补二期段、文件树加 handlers/validation.ts + ValidationPanel.vue、单测 572
- 《日志.md》里程碑段补「P1⑯ 二期增强」、进度总览单测计数 572
