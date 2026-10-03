# P1④ 代码库索引与检索 实施计划

## 一、现状研究（代码事实）

- `src/main/ai/context.ts`：`buildIndex(root)` 每次全量递归扫描（深度 6），正则抽取 import/符号，仅存预览前 80 行；`selectContext()` 用词集合重叠 + import 邻接打分。**纯内存态**，进程退出即失效。
- `src/main/handlers/aiScheduling.ts`：模块级 `indexCache = Map<root, FileIndexEntry[]>`；`ai:buildIndex` 手动建索引，`ai:getContext` 缓存缺失时全量重建——首次对话有明显卡顿，且外部改文件后缓存变陈旧。
- 渲染端 `stores/chat.ts` 的 `contextAnchor()`：当前文件内容（截 4000）+ `ai:getContext`（预算 6000）拼成 system 锚点，`send` / `sendWithTools` 两条路径都调用。
- 工作区生命周期：`stores/workspace.ts` 打开/恢复工作区时设置 `rootPath` 并调 `mcp:setWorkspaceRoot`——这是自动建索引的天然挂载点。
- 工程约定：无 better-sqlite3/chokidar 依赖；持久化一律用 `<workspace>/.trae/*.json`（agent-notes.json 模式）；Ollama 本机 `http://127.0.0.1:11434`，`ollama` npm 包 + 原生 fetch 均可用。
- 现状检索的三个硬伤：① 无持久化/增量；② 打分是词集合重叠（词频、IDF、中文全部缺失）；③ 无显式引用手段（@file/@symbol），用户无法精确控制注入。

## 二、目标与范围（本计划一次交付）

1. 持久化增量索引（mtime+size 判变，JSON 落盘，删除文件自动清理）
2. BM25 检索（含 CJK 二元分词）+ import 双向依赖图 + 符号命中加权
3. 可选 Ollama embedding 语义向量（自动探测 bge/nomic/e5/gte/embed 类模型），失败静默回退 BM25；混合打分
4. `@file` / `@symbol:名称` / `@codebase` 显式引用解析（纯函数，可单测）
5. 输入框 `@` 触发候选浮层（文件/符号，键盘可选）
6. IPC：索引状态 / 增量构建 / 搜索；工作区打开后后台自动建索引
7. 全量单测 + typecheck + CDP 冒烟；更新《项目结构说明.md》

**不在本次范围**：AST 级符号图（继续用正则抽取，增加行号与 kind）、fs.watch 实时监听（用每次 ensure 的 stat 快扫 + 5s 节流替代）、独立检索结果 UI 页。

## 三、文件与模块

### 新增

| 文件 | 职责 |
|---|---|
| `src/main/ai/codeParse.ts` | 从 context.ts 迁出的纯函数：SOURCE_EXT/IGNORE_DIRS（新增 `.trae`）、`extractImports/extractSymbols`（符号加 `{name,kind,line}`）、`parseFile(abs,rel,content)` 单文件解析 |
| `src/main/ai/indexer.ts` | `scanWorkspace(root)` stat 快扫；`loadIndex/saveIndex`（`.trae/code-index.json`，version 字段）；`ensureIndex(root,{force})` 增量合并（新增/更新/删除统计，5s 节流）；纯函数 `mergeIndex(old,scanned)` 供单测 |
| `src/main/ai/retrieval.ts` | CJK 感知 tokenizer（英文词 + 中文二元组）；BM25 打分；import 正/反向邻接；符号精确命中加权；`searchIndex(index,q,opts)`；`buildContext(index,q,currentFile,root,maxChars,mentions)` 预算拼接（mention 强制注入全文）；`parseMentions(text)` 抽取 @ 引用并从 query 剥离 |
| `src/main/ai/embeddings.ts` | `detectEmbedModel()`（复用 Ollama 客户端 list，名称启发式）；`embed(texts,model)` 走 `/api/embeddings`；cosine；向量存 `.trae/code-vectors.json`（仅变更文件补算）；`hybridSearch` 归一化融合（α 可配，默认 0.4）；任何异常回退纯 BM25 |
| `src/main/ai/indexer.test.ts` | 增量合并：新增/变更(mtime)/删除、损坏文件容错、IGNORE 目录 |
| `src/main/ai/retrieval.test.ts` | BM25 词频/IDF 排序、中文二元组命中、反向依赖、符号加权、mention 解析（@file 模糊匹配/`@symbol:x`/@codebase/剥离原文）、预算截断 |
| `src/main/ai/embeddings.test.ts` | cosine 计算、混合排序、embedding 服务异常时回退 BM25（注入假 fetcher） |
| `src/renderer/src/components/MentionPicker.vue` | `@` 候选浮层：文件路径 + 符号两组，↑↓/Enter/Tab/Esc，点击选中；选中向输入框插入 `@relPath` 文本 |

### 修改

- `src/main/ai/context.ts`：瘦身为兼容层，re-export codeParse/indexer/retrieval 的 `buildIndex/selectContext`（保持现有 import 不断）。
- `src/main/handlers/aiScheduling.ts`：删除 `indexCache` 全量逻辑；新增 `ai:indexStatus`、`ai:ensureIndex`、`ai:searchIndex`；`ai:getContext` 改为 ensureIndex（增量）→ parseMentions → hybridSearch/buildContext。
- `src/preload/index.ts` + `src/renderer/src/api.d.ts`：补 3 个通道与 `UiSearchHit`/`UiIndexStatus` 类型。
- `src/renderer/src/stores/workspace.ts`：设置 rootPath 后 fire-and-forget 调 `ai.ensureIndex`（不 await、不报错）。
- `src/renderer/src/stores/chat.ts`：`contextAnchor` 透传原文（mention 解析在主进程完成，渲染端不重复）。
- `src/renderer/src/components/ChatPanel.vue`：composer textarea 接入 MentionPicker（监听 `@` 触发、光标坐标定位浮层、选中插回 textarea 并同步 v-model）。
- 《项目结构说明.md》：7.1 第 4 行标 ✅，目录树/机制索引同步。

## 四、实施步骤（依赖序）

1. **codeParse.ts 迁移**：搬移正则抽取逻辑，符号升级为 `{name,kind,line}`（function/class/interface/type/const，Python def/class），IGNORE_DIRS 加 `.trae`；context.ts 改 re-export。
2. **indexer.ts**：索引 JSON schema（`{version,root,updatedAt,files:{relPath:{mtimeMs,size,imports,symbols,lang,preview,size}}}`）；stat 快扫 → 与磁盘比对 → 仅解析变更文件 → 写盘；文件数上限 3000 兜底。配套单测。
3. **retrieval.ts**：tokenizer（`/[a-z][a-z0-9_]*/g` + 中文相邻二元组）→ BM25(k1=1.5,b=0.75) → 图邻接/符号加分 → 预算拼接；parseMentions（匹配后用 relPath 子串消歧，多候选按路径分数取最优；`@symbol:name` 走符号表全局唯一定位，重名取与 query 其余词最相关文件）。配套单测。
4. **embeddings.ts**：探测模型 → 文件向量惰性补算（仅 mtime 变化者）→ 独立 vectors.json → hybridSearch；超时 10s、异常一律回退。配套单测（假 fetch 注入）。
5. **IPC 接线**：3 新通道 + getContext 改造；通道签名：
   - `ai:indexStatus(root) → {files, updatedAt, scanning}`
   - `ai:ensureIndex(root, force?) → {total, added, updated, removed}`
   - `ai:searchIndex({root,query,limit}) → [{relPath, score, symbol?}]`
6. **preload / api.d.ts / workspace store**：类型与自动建索引。
7. **MentionPicker.vue + ChatPanel 集成**：最小交互（@ 触发、键盘三件套、浮层随光标定位）。
8. **验证**：typecheck（main+renderer）、全量 vitest（预期 162 → 约 190+）、重启 dev + CDP 冒烟（@ 浮层出现、搜索命中、ensureIndex 返回增量统计、第二次调用 added=0）。
9. 更新《项目结构说明.md》并汇报。

## 五、依赖与注意点

- 不新增任何 npm 依赖（无 sqlite/chokidar），embedding 用原生 fetch 打 Ollama HTTP，与 openaiCompatibleProvider 的 SSE fetch 风格一致。
- `.trae/` 必须加入忽略目录，否则索引文件会被自引用扫描。
- 向量文件可能较大：每文件只对 `路径+符号+前 80 行预览` 编码；仅在探测到 embed 模型时生成；用户可删 vectors.json 无损回退。
- CJK 必须二元分组，否则中文问题（如"权限审批"）在英文标识符为主的代码库零命中。
- 索引写入放后台，首次建索引不阻塞打开工作区；getContext 遇索引未就绪走「快扫 + 仅 BM25」内存结果（等价现状兜底）。
- 测试沿用 vitest node 环境，electron import 惰性（与 usageStats 同款工厂模式：indexer 文件路径由参数传入，测试用 tmp 目录/内存）。

## 六、验证

- `node node_modules/vitest/vitest.mjs run`：新增 3 个测试文件，约 25-30 个用例全过，存量 162 例不回归。
- typecheck:main + typecheck:renderer 零错误。
- CDP 冒烟（临时探针，用完即删）：工作区打开后 `ai:indexStatus` 非空；`ai:searchIndex({query:'权限'})` 命中 permissions.ts；输入框输入 `@` 浮层渲染候选；二次 `ensureIndex` 增量为 0。

## 七、风险与应对

- **大工作区首次扫描慢**：深度 6 + 3000 文件上限 + 后台执行；只解析变更文件，二次后成本≈一次 stat 快扫。
- **embedding 模型占显存/拖慢**：默认不主动拉取模型，仅在用户本地已存在 embed 类模型时启用；10s 超时；任何失败永久降级当次会话为纯 BM25 并在 status 里标注。
- **@ 浮层与编辑器焦点冲突**：浮层不抢焦点（ tabindex=-1 ），Enter/Tab 由 textarea keydown 统一处理，Esc 关浮层；沿用应用内弹窗的远程桌面焦点经验但更轻量。
- **索引 JSON 损坏**：load 失败视同空索引全量重建（与 usageStats/agentNotes 容错一致）。
- **mention 路径写错（子串匹配多个）**：返回最高分候选；并列时取路径最短；找不到精确文件则忽略 mention 但不丢问题原文（parseMentions 剥离失败时保守保留）。
