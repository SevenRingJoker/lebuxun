# P1③ 多 Provider / 模型管理 — 实施计划

> 对应《项目结构说明.md》7.1 表第 3 行 / 7.2 ③。
> 日期：2026-09-29

## 一、研究结论（代码事实）

| 现状 | 位置 | 结论 |
|------|------|------|
| AiProvider 统一接口（health/listModels/chat/chatStream/abort） | `src/main/ai/types.ts` | 扩展点现成，新供应商实现接口即可 |
| 供应商注册中心，`PROVIDERS` 数组 + `ai-providers.json`（enabled/defaults 持久化） | `src/main/ai/providerRegistry.ts` | 目前只有 `new OllamaProvider()` 一个实例；无自定义端点配置 |
| 唯一实现 OllamaProvider | `src/main/ai/providers/ollamaProvider.ts` | `inferCapabilities` 按模型名启发式推断能力；**无 usage 统计**（Ollama 响应自带 prompt_eval_count/eval_count，被丢弃） |
| 路由打分用 ModelCapabilities（reasoning/code/speed/contextWindow/costTier） | `src/main/ai/router.ts` | 云端模型需要真实能力矩阵，不能靠名字猜 |
| IPC：ai:listProviders / listModels / refreshModels / setProviderEnabled | `src/main/handlers/aiScheduling.ts` | 无供应商配置（baseUrl/Key）读写通道、无用量统计通道 |
| 前端：模型下拉按供应商 optgroup 分组 | `ChatPanel.vue` 274 行 + `stores/chat.ts` modelGroups | 新供应商自动出现在下拉，无需改；但无设置入口 |
| 无 API Key 存储、无 token/成本统计 | — | 本计划核心新增 |

## 二、方案设计

### 1. OpenAI 兼容 Provider（覆盖 OpenAI / DeepSeek / llama.cpp / 任意兼容端点）
- 新增 `src/main/ai/providers/openaiCompatibleProvider.ts`
- **工厂函数** `makeOpenAICompatibleProvider(cfg)`：入参 `{ id, displayName, baseUrl, headers }`，一个配置一个实例
- 原生 `fetch` + SSE 流解析（`data: {...}` / `[DONE]`），**不引入 openai SDK**（主进程 CJS 打包对 ESM SDK 互操作有坑，且少一个依赖）
- 流式带 `stream_options: { include_usage: true }`，末 chunk 的 usage 经新增的 `onUsage` 回调上报
- 非流式 `chat()` 透传 `tools`（OpenAI function calling 格式），返回 `toolCalls`
- health：GET `{baseUrl}/models`（带鉴权头）；listModels：同端点解析清单

内置预设（注册进 registry）：
| id | displayName | baseUrl | 鉴权 |
|----|-------------|---------|------|
| openai | OpenAI | https://api.openai.com/v1 | Bearer Key |
| deepseek | DeepSeek | https://api.deepseek.com/v1 | Bearer Key |
| llamacpp | llama.cpp（本地） | http://127.0.0.1:8080/v1 | 无 |

- 另支持用户自定义端点（id 形如 `custom-<n>`，名字可改）

### 2. Anthropic Provider
- 新增 `src/main/ai/providers/anthropicProvider.ts`（id `anthropic`，baseUrl https://api.anthropic.com）
- `POST /v1/messages`，头 `x-api-key` + `anthropic-version`
- SSE 事件流解析（`content_block_delta` → onChunk；`message_delta` usage → onUsage）
- health：GET /v1/models；system 消息合并进 Anthropic 的顶层 `system` 字段

### 3. API Key 安全存储
- 新增 `src/main/ai/keyStore.ts`：Electron `safeStorage.encryptString`（Windows DPAPI）→ 密文 base64 存 `userData/ai-keys.json`
- safeStorage 不可用时降级明文存储并带 `plaintext: true` 标记（UI 提示）
- 读侧 `getKey(providerId)` 在 app ready 后可用；Key 永不出现在渲染进程明文回显（只回掩码 `sk-***abc`）

### 4. 模型能力矩阵 + 价格表
- 新增 `src/main/ai/modelCapabilities.ts`
- `PRESET_CAPABILITIES: Record<string, ModelCapabilities>`：deepseek-chat / deepseek-reasoner / gpt-4o / gpt-4o-mini / gpt-4.1 / claude-sonnet / claude-haiku 等常见模型的真实能力（contextWindow / function calling / 推理）
- `PRICE_TABLE`（$/1M tokens，in/out 分开）：deepseek / gpt / claude 主流档位；未收录模型 cost=0 标记 unknown
- Ollama 的 `inferCapabilities` 迁移到本文件共用（llama.cpp 本地模型同样按名字启发式）

### 5. 用量统计（token / 成本）
- 新增 `src/main/ai/usageStats.ts`：`record(modelId, {tokensIn, tokensOut})` → 按模型价格折算成本，按日聚合，持久化 `userData/ai-usage.json`
- 数据来源：provider 通过回调/返回值上报 usage（Ollama：chunk 的 prompt_eval_count/eval_count；OpenAI 兼容：stream usage / 非流式 usage；Anthropic：message_start/message_delta usage）；无 usage 时按字符数÷4 保守估算并标记 estimated
- `types.ts` 扩展：`AiStreamCallbacks` 加可选 `onUsage?`；`chat()` 返回值加 `usage?`

### 6. providerRegistry 扩展
- `ProviderConfig` 增加自定义供应商定义：`custom: Array<{id,name,baseUrl}>`；加载时动态实例化注册
- 新增 `updateProviderConfig()` / Key 读写接线；Ollama 保持常驻

### 7. IPC 与前端
- `aiScheduling.ts` 新通道：
  - `ai:getProviderSettings` → 供应商列表（含 baseUrl、Key 掩码、enabled、health）
  - `ai:saveProviderSettings`（baseUrl/enabled/自定义增删 + Key 变更）→ 保存后自动 refreshModels
  - `ai:testProvider`（连通性测试）
  - `ai:getUsageStats` / `ai:resetUsageStats`
- `preload/index.ts` + `api.d.ts` 同步补类型
- 新增 `src/renderer/src/components/ModelSettings.vue`：应用内弹窗（复用 cp-glass 风格），三个区块：
  1. 供应商卡片列表：启用开关、健康状态点、baseUrl 输入、API Key 输入（保存即加密，掩码回显）、测试连接按钮
  2. 新增自定义供应商表单
  3. 用量统计：按模型分组的 token in/out、估算成本、今日/累计，清零按钮
- `ChatPanel.vue` 头部加「模型管理」齿轮按钮打开弹窗
- `stores/chat.ts`：保存设置后调用 `refreshModels` 并重载 modelGroups

## 三、文件清单

| 操作 | 文件 |
|------|------|
| 新增 | `src/main/ai/providers/openaiCompatibleProvider.ts` |
| 新增 | `src/main/ai/providers/anthropicProvider.ts` |
| 新增 | `src/main/ai/keyStore.ts` |
| 新增 | `src/main/ai/modelCapabilities.ts` |
| 新增 | `src/main/ai/usageStats.ts` |
| 新增 | `src/main/ai/usageStats.test.ts` |
| 新增 | `src/main/ai/sseParse.test.ts`（SSE 解析纯函数测试） |
| 新增 | `src/renderer/src/components/ModelSettings.vue` |
| 修改 | `src/main/ai/types.ts`（onUsage / usage 类型） |
| 修改 | `src/main/ai/providerRegistry.ts`（动态注册 + 配置扩展） |
| 修改 | `src/main/ai/providers/ollamaProvider.ts`（usage 上报 + 能力函数迁移引用） |
| 修改 | `src/main/ai/scheduler.ts`（usage 记账接线，3 处调用点） |
| 修改 | `src/main/handlers/aiScheduling.ts`（4 个新 IPC） |
| 修改 | `src/preload/index.ts` + `src/renderer/src/api.d.ts`（通道类型） |
| 修改 | `src/renderer/src/components/ChatPanel.vue`（入口按钮） |
| 修改 | `src/renderer/src/stores/chat.ts`（刷新联动） |
| 修改 | `项目结构说明.md`（7.1 第 3 行 ✅ + 目录树/机制索引同步） |

## 四、实施步骤

1. `modelCapabilities.ts` + 迁移 `inferCapabilities` → 单测覆盖
2. `keyStore.ts`（safeStorage 加解密 + 降级）
3. `openaiCompatibleProvider.ts`（SSE 解析抽纯函数）→ `sseParse.test.ts`
4. `anthropicProvider.ts`
5. `usageStats.ts` → `usageStats.test.ts`
6. `types.ts` / `providerRegistry.ts` / `ollamaProvider.ts` / `scheduler.ts` 接线
7. `aiScheduling.ts` IPC + preload + api.d.ts
8. `ModelSettings.vue` + `ChatPanel.vue` 入口 + chat store 联动
9. typecheck + 全量单测
10. 重启 dev → CDP 冒烟：打开模型管理弹窗、确认供应商卡片渲染、开关 ollama、用量面板
11. 更新《项目结构说明.md》并汇报

## 五、验证方式

- `npm run typecheck`：tsconfig.node.json 全绿（web 侧仅遗留 main.ts 已知报错）
- `node node_modules\vitest\vitest.mjs run`：现有 146 例 + 新增（SSE 解析 / usageStats / 能力推断）全绿
- CDP 探针（端口 9341）：主窗口截图确认 ModelSettings 弹窗渲染正常、模型下拉出现新供应商分组；探针用完即删

## 六、风险与对策

| 风险 | 对策 |
|------|------|
| Electron CJS 打包下全局 fetch/SSE 兼容性 | Node 18+ 原生 fetch（Electron 22+ 自带）；SSE 手写解析不依赖 eventsource |
| safeStorage 在 dev 未 ready | 调用前判 `isEncryptionAvailable`，降级明文 + 标记 |
| 云端 Key 无效导致路由反复失败 | health 失败 → 模型标 unavailable，route() 已过滤不可用模型 |
| 工具循环对云端模型的 tool_calls 格式差异 | OpenAI 兼容返回标准 tool_calls，toolCall.ts 已有结构化解析；Anthropic 暂只做对话/流式，tool 模式标注后续增强 |
| 主进程/preload 改动需完全重启 dev | 验证阶段先 taskkill electron 再重启 |
