# P1⑮ 上下文压缩策略 实施计划

> 日期：2026-09-30
> 前置：P1⑭ 设置/命令面板/快捷键已完成（基线 386 例单测全绿、双端 typecheck 零错）

## 一、现状痛点（已调研确认）

| 现状 | 位置 | 问题 |
|------|------|------|
| 字符硬编码阈值 | scheduler.ts L29 `COMPACT_THRESHOLD = 6000` | 8k 窗口模型勉强够用，128k 窗口（GPT-4o）过早压缩丢上下文，32k 窗口又偏晚 |
| 按字符计数 | contextCompactor.ts `totalChars`（字符数） | 中文 1 字≈1 token、英文约 4 字符/token，字符/4 对中文严重低估，长中文会话实际已超窗口才触发 |
| 系统提示词不参与预算 | compactIfNeeded 只收 `convo`（不含每轮重建的 S1-S11） | S1-S11 + 工具 schema 本身可达数千 token，历史预算虚高 |
| 中间消息粗暴截断 | 每条 `.slice(0, 500)` | 工具结果里的代码块（最有价值的部分）常被从中间切断 |
| 摘要无质量校验 | summarize 成功即采用 | 小模型摘要漏掉文件路径/命令时无补救，Agent 后续基于错误记忆操作 |

好底子：`resolveCapabilities(modelName).contextWindow` 已有全部模型窗口元数据（预设 8k~1M + 启发式）；`runWithTools` 持有 modelName 与当轮 `agentSystem`；`compactIfNeeded` 仅 scheduler 一处调用、无历史测试绑定，签名可直接重构。

## 二、目标

1. **Token 化计量**：CJK 感知的 token 估算（中文每字 1 token、ASCII 每 4 字符 1 token），消息计数含 toolCalls JSON。
2. **按模型窗口动态阈值**：阈值 = contextWindow × 0.75 − 当轮系统提示词 token − 输出预留（默认 1024），设 2048 下限；不再有全应用单一常量。
3. **中间历史智能节选**：tool 结果优先保留代码围栏块，其余首尾截断并标注；对话消息保留命令/路径行。
4. **摘要保留度校验 + 一次重试**：从原文提取关键事实（文件路径、shell 命令、成败结论词），摘要覆盖率不足 50% 时把事实清单拼入提示重试一次；再失败退化截断。

## 三、文件改动

### 1. 新增 `src/main/ai/tokenBudget.ts`（零 IO 纯函数层）

- `estimateTokensText(text)`：CJK（一-鿿/぀-ヿ/가-힯）每字 1 token，其余每 4 字符 1 token，向上取整；空串 0。
- `countMessagesTokens(messages)`：各消息 content + toolCalls（JSON.stringify，无 toolCalls 不计）合计。
- `computeHistoryBudget(contextWindow, systemTokens, opts?)`：`max(floorMin, round(window*ratio) - systemTokens - outputReserve)`；ratio 默认 0.75、outputReserve 1024、floor 2048，均可注入。
- `planCompaction(messages, keepRecent)`：抽出分段逻辑 → `{ systems, first, middle, recent }`；system 全保留；对话不足 keepRecent+1 条返回 null。
- `extractKeyFacts(text)`：返回 `{ paths: string[]; commands: string[] }`——路径（`[\w./\\:-]+\.\w{1-8}` 与盘符/`./`/`/`/`\` 开头串，去重）、命令（`npm run xxx`、`git xxx`、行首 `$ `/`>` 后内容，去重，限 20 条）。
- `retentionScore(facts, summary)`：路径与命令在摘要中出现（子串，路径取 basename 与全写两档）的比例；无事实时返回 1（不触发重试）。
- `truncateToolOutput(content, maxTokens)`：优先提取 ``` 围栏块（合计不超过预算的 70%），余量放非代码文本首尾；超预算插 `…[中间 N token 已截断]…` 标记。纯 token 预算按 estimateTokensText 计。
- `buildHistoryText(middle, perMsgTokens)`：逐条组装 `[role(name)]\n内容`，tool 消息走 truncateToolOutput、普通消息按行过滤保留含路径/命令/结论词的行后截断。

### 2. 新增 `src/main/ai/tokenBudget.test.ts`（约 26 例）

- estimateTokensText：空串/纯中文/纯英文/混合密度对比。
- countMessagesTokens：content 合计、toolCalls JSON 计入、无 toolCalls 不膨胀。
- computeHistoryBudget：32k 窗口正常值、128k 窗口放大、系统提示超大时命中 2048 下限、ratio/reserve 可覆盖。
- planCompaction：system 分离、对话太短返回 null、首条/最近/中间分段正确。
- extractKeyFacts：相对/绝对/中文路径、npm/git/`$` 命令去重、无事实文本返回空。
- retentionScore：全覆盖 1、部分覆盖区间、零覆盖 0、无事实视为 1。
- truncateToolOutput：短文本原样、长纯文本首尾+标记、长文本代码块优先保留。
- buildHistoryText：tool 消息带角色标签、超预算出现截断标记。

### 3. 重构 `src/main/ai/contextCompactor.ts`

- `compactIfNeeded(messages, summarize, opts: { historyBudgetTokens: number; keepRecent?: number; retry?: boolean })`：
  - countMessagesTokens ≤ budget → 原样返回；
  - planCompaction 分段；buildHistoryText 组装；
  - 首次摘要后 extractKeyFacts + retentionScore，<0.5 且 retry 非 false 时带「必须保留以下路径与命令」事实清单重试一次；
  - 摘要成功 → `[...systems, first, [历史摘要]msg, ...recent]`；失败/两次都不达标 → 退化截断（同现有行为）。
- 删除 totalChars/DEFAULT_THRESHOLD/KEEP_RECENT 常量（KEEP_RECENT 改默认参数 4）。

### 4. 接线 `src/main/ai/scheduler.ts`

- 删除 `COMPACT_THRESHOLD = 6000` 与字符阈值；import resolveCapabilities/estimateTokensText/computeHistoryBudget。
- L607 构建 `agentSystem` 后计算：
  - `systemTokens = estimateTokensText(agentSystem.content)`
  - `historyBudget = computeHistoryBudget(resolveCapabilities(modelName).contextWindow, systemTokens)`
  - `compactIfNeeded(convo, summarize, { historyBudgetTokens: historyBudget })`
- summarize 提示词要求路径/命令保留（重试时由 compactor 拼事实清单，scheduler 不改 summarize 签名）。

## 四、验证

1. 双端 typecheck 零错误。
2. 全量 vitest：386 → 约 412 例，只增不减。
3. CDP 真窗冒烟（新端口，临时探针用完即删）：
   - 超长中文对话（构造 > 窗口预算的消息历史）触发压缩：发往模型的消息中出现 `[历史摘要]`、首条 user 与最近 4 条保留。
   - 小窗口（通过能力函数验证 8k 与 128k 预算数值差异——纯函数已单测，CDP 侧只验证真实多轮会话不报错、压缩后 Agent 能继续工具调用）。
   - 回归：短会话不压缩（消息原样）、停止键/普通问答不受影响。

## 五、二期不做

- 真分词器（tiktoken/WASM gpt-tokenizer），当前 CJK 感知估算够用且零依赖。
- 按消息类型差异化保留（如错误堆栈完整保留、成功日志只留尾行）的更细策略。
- 压缩事件推送到前端进度条（目前压缩对用户静默，二期可加「正在压缩上下文」提示）。
