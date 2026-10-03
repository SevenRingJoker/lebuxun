# P1⑪ 子代理增强 实施计划

> 日期：2026-09-30
> 前置：P1⑩ 工具扩展已完成（基线 319 例单测全绿、双端 typecheck 零错）

## 一、现状痛点（已调研确认）

| 现状 | 位置 | 问题 |
|------|------|------|
| `Promise.all` 一次性全并行 | subagents.ts L67 | `MAX_SUBTASKS=4` 硬编码、无并发限流之外的编排 |
| 无依赖表达 | SubTaskSpec 仅 description/tools | 有依赖的子任务只能靠模型自觉串行派发，S7 协议第 4 条也写着「有依赖必须串行」 |
| 无超时 | runOne 最多 8 轮但单轮模型调用可无限挂起 | 一个卡死的子代理拖死整批 |
| 无取消 | 应用级没有 ai:stopChat IPC；ollamaProvider.abort() 是空实现 | 用户只能等任务自然结束；主任务异常时子代理空跑 |
| 无预算 | trackChatUsage 只记账不限流 | 子代理并行烧钱无闸门 |
| 结果简单拼接 | runSubagents 末尾 map+join | 无状态标注、无产物冲突检测 |

好底子：权限闸已接入子代理（gate.check 同闸）；`usageStats.estimateTokens`（字符÷4）可复用做预算计量；`ToolsEvents.onSubagent(current,total,phase,detail)` 事件通道已存在，前端子代理状态条不用改协议。

## 二、目标

1. **DAG 依赖编排**：`SubTaskSpec` 增加 `dependsOn?: number[]`（按下标引用前驱）；无依赖并行、有依赖等前驱完成；循环依赖/越界/自依赖在派发前拒绝并回报错误文本。
2. **独立超时**：每个子代理独立 `timeoutMs`（默认 5 分钟，spec 可覆盖），超时只中止该子任务并标注，其余继续。
3. **取消传播**：应用新增 `ai:stopChat` 停止通道（主循环 + 全部运行中子代理级联中止）；子代理循环每轮检查 AbortSignal。
4. **并发与预算可配**：`maxConcurrency`（默认 4，信号量限流，替代 Promise.all 一把梭）、`tokenBudget`（默认 200k，超预算停止派发新任务，运行中的让跑完当前轮后收尾）。
5. **结果合并策略**：汇总文本带状态徽标（✅完成/⏱超时/⛔取消/⏭跳过）；从工具执行记录提取 write/edit 目标路径，多子任务写同一路径时输出「⚠ 产物冲突」清单提醒主 Agent 裁决。

## 三、文件改动

### 1. 新增 `src/main/ai/subagentDag.ts`（零 electron 纯函数层）

- `validateSubTasks(tasks: {dependsOn?: number[]}[])`：越界/自依赖/重复依赖/环检测（Kahn 过程中残余入度非零即环）→ `{ ok: true } | { ok: false; error: string }`
- `buildDagLayers(count, deps: (number[]|undefined)[])`：Kahn 拓扑分层 → `number[][]`（同层可并行、层间串行）
- `raceWithControl<T>(p, { timeoutMs, signal })`：超时/中止竞态包装 → `{ status: 'ok'|'timeout'|'aborted', value? }`（纯 Promise 逻辑，setTimeout 注入不了就用真定时器，单测用短超时）
- `extractWrittenPaths(toolLog: {name,args}[])`：从执行记录提取 write/edit/move/copy 目标路径
- `findConflicts(perTaskPaths: string[][])`：路径交集 → 冲突清单
- `checkBudget(used, budget)`：是否超预算

### 2. 新增 `src/main/ai/subagentDag.test.ts`（约 25 例）

拓扑分层（链/扇出/菱形/混合）、环检测（自环/互环/多节点环）、越界与重复依赖、raceWithControl 三态、路径提取与冲突交集、预算检查。

### 3. 重构 `src/main/ai/subagents.ts`

- `SubTaskSpec` + `dependsOn?: number[]`、`timeoutMs?: number`
- `RunSubagentsParams` + `maxConcurrency?`、`tokenBudget?`、`signal?: AbortSignal`
- 编排主循环：先 validate（失败直接回报错文本，不派发）→ buildDagLayers → 逐层执行；层内信号量限流到 maxConcurrency；每个任务 `raceWithControl(runOne, { timeoutMs, signal })`；累计 usage 超 tokenBudget 则后续层不再派发（标注「预算耗尽」）
- `runOne`：每轮循环开头检查 `signal?.aborted` → 中止返回「已被用户中止」；模型调用失败/异常时 `provider.abort?.()` 尽力止损；回传 `{ text, usage, writtenPaths }` 供合并
- 汇总：状态徽标 + 冲突清单 + 未执行原因（依赖失败跳过/预算耗尽/被取消）

### 4. `src/main/ai/scheduler.ts` 接线

- `scheduleChatWithTools` / `runWithTools` 增加 `signal?: AbortSignal` 参数；主循环每轮开头检查，aborted 则跳出并返回「任务已被用户中止」
- `dispatch_subagents`：描述更新（dependsOn 用法与示例、并发/预算说明）；调用 runSubagents 透传 signal；inputSchema 每项增加 dependsOn/timeoutMs
- S7 编排协议第 4 条改写：「有依赖的子任务用 dependsOn 声明前驱下标，调度器自动保证顺序；无依赖的子任务会并行执行」

### 5. 停止通道（主任务 → 子代理级联）

- `handlers/aiScheduling.ts`：模块级 `currentChatAbort: AbortController | null`；`ai:chatWithTools` 进入时新建并存入、finally 清空；新增 `ipcMain.handle('ai:stopChat')` → `currentChatAbort?.abort()` + 各 provider `abort?.()`，返回 `{ ok, stopped }`
- preload `index.ts` / `index.d.ts` / 渲染端 `api.d.ts`：`ai.stopChat()`
- `ChatPanel.vue`：sending 中发送按钮变为「停止」按钮（复用现有 sending 状态），点击调 `window.api.ai.stopChat()`；chat store 增加 `stopSending()` 动作

### 6. 文档同步

《项目结构说明.md》7.1 表 P1⑪ 标 ✅、7.2 子代理小节重写、文件树加 subagentDag、单测计数更新；《日志.md》加里程碑 + 进度总览 8→9 + 下一项指向 P1⑭。

## 四、明确不做（二期）

- provider 级 HTTP 请求真中断（Ollama abort 需要改 provider 内部 fetch 接 AbortController，本期只做调度层 signal 检查 + abort() 尽力调用）
- 子代理嵌套派发（维持 BANNED_TOOLS 禁止）
- 子代理间实时通信/共享黑板
- 按子任务优先级调度

## 五、验证方案

1. 双端 `npm run typecheck` 零错误
2. `node node_modules\vitest\vitest.mjs run`：319 → 约 345 例全绿
3. CDP 真窗冒烟（临时探针用完即删）：
   - `ai:stopChat` IPC 存在且可调
   - 停止按钮在发送中出现、点击后任务中止（sending 复位）
   - dispatch_subagents 工具描述含 dependsOn
   - DAG 顺序：mock 场景验证 dependsOn 前驱先于后继执行（通过 onSubagent 事件序列）
   - 超时标注与预算标注文本出现
