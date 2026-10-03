# P1⑦ 会话持久化 实施计划

## 一、现状研究（代码事实）

- `stores/chat.ts`：`messages = ref<ChatMessage[]>([欢迎语])` 纯内存，刷新/重启即丢；`ChatMessage = {role:'user'|'assistant'|'system'|'tool', content, toolName?, isStreaming?, isNotice?}`，无时间戳、无会话 id。
- `history()` 发送前已过滤 isNotice/tool/system；`clear()` 仅清空数组。
- 瞬态状态：`sending/progress/thinkingHint/todos/subagent/permission`——不属于会话内容，切换会话时必须重置。
- 持久化先例：`agent-notes.json` 走主进程 IPC 落工作区 `.trae/`；模型/权限配置走主进程 userData；前端少量开关用 localStorage。
- 已有 `fs:saveDialog(defaultName)` + `fs:writeFile(path, content)` IPC，导出 Markdown 可直接复用，无需新对话框。
- 工作区生命周期：`stores/workspace.ts` 的 `rootPath`（restoreWorkspace/selectWorkspace 两个入口），chat store 目前不感知工作区切换。
- ChatPanel 头部右侧按钮区（改动/检查点/权限三段/齿轮/状态点）是会话入口的天然位置；应用内弹窗模式（modal-overlay）已在 ModelSettings.vue/FileTree.vue 成熟使用，禁原生 confirm/alert。

## 二、目标与范围

1. 多会话：新建 / 切换 / 重命名 / 删除 / 自动标题（首条 user 前 20 字）
2. 自动持久化：消息落盘（1s 防抖 + 发送结束即时保存），重启/切工作区恢复上次会话
3. 按工作区隔离；无工作区时归入 `no-workspace` 分区
4. 会话历史弹窗：关键词搜索（标题+末条预览）、列表（时间/条数）、重命名、删除、导出 .md
5. 导出 Markdown（系统另存为对话框，复用 fs:saveDialog/fs:writeFile）
6. 主进程单测（CRUD/索引一致性/损坏容错/分区隔离）

**不在本次范围**：跨设备云同步、会话分支/fork、消息级编辑重发、把 tool 原始 JSON 全量入库（只存 toolName+摘要文本）、向量检索历史会话。

## 三、文件与模块

### 新增

| 文件 | 职责 |
|---|---|
| `src/main/ai/chatHistory.ts` | 会话存储核心：`resolveStoreDir(userDataRoot, workspace)`（wsKey=路径转 base64url，空=`no-workspace`）；`index.json` 元数据 + `<id>.json` 分文件；list/load/save/delete/purgeEmpty；纯函数 `deriveTitle()`、`buildIndexFromSession()`、`toMarkdown()` 供单测；损坏 index/会话文件容错跳过 |
| `src/main/ai/chatHistory.test.ts` | 约 12 例：首次保存生成 id+标题+索引、二次保存更新索引不新增、切换分区隔离、删除会话清文件、index 损坏重建、会话文件损坏跳过、空消息不写盘、toMarkdown 角色/工具/标题格式、deriveTitle 截断与去换行 |
| `src/renderer/src/components/SessionHistory.vue` | 会话历史弹窗（复用 modal-overlay/settings-modal 样式）：搜索框、新建按钮、会话列表（标题/相对时间或绝对时间/消息数/末条预览）、当前项高亮；行内操作 切换/重命名/导出/删除（删除走应用内确认） |

### 修改

- `src/main/handlers/aiScheduling.ts`：注册 4 通道（签名见下），存储根用 `app.getPath('userData')`（惰性获取，保持 vitest 安全）。
- `src/preload/index.ts` + `src/renderer/src/api.d.ts`：补 4 通道与 `UiSessionMeta`/`UiSessionData`/`UiSessionMessage` 类型。
- `src/renderer/src/stores/chat.ts`：
  - `ChatMessage` 加 `ts?: number`（仅 user/assistant 正式消息打点）
  - 新状态：`sessions: UiSessionMeta[]`、`currentSessionId: ref<string|null>`、`showHistory`
  - 新动作：`newSession()`、`switchSession(id)`、`renameSession(id,title)`、`deleteSession(id)`、`exportSession(id)`、`refreshSessions()`
  - 持久化：`persistCurrent()`（过滤 isStreaming/isNotice/欢迎语；首条 user 时 deriveTitle；1s 防抖），在 send/sendWithTools 完成与 onChatDone/onChatError 后触发
  - 初始化与工作区联动：onMounted 及 `watch(ws.rootPath)` → refreshSessions + 恢复 `localStorage['scholar:lastSession:'+root]`；切会话重置 todos/subagent/permission/progress/thinkingHint
- `src/renderer/src/components/ChatPanel.vue`：头部加「历史」按钮（时钟图标）+「新会话」按钮（＋图标）；挂 `<SessionHistory>`；当前会话标题作为副标题小字展示（可选，空间不足则只放 title）。
- 《项目结构说明.md》：7.1 第 7 行标 ✅，目录树/机制索引同步。

### 数据结构

```ts
// 主进程
interface StoredMessage { role: 'user'|'assistant'|'system'|'tool'; content: string; toolName?: string; ts: number }
interface SessionData { id: string; workspace: string | null; title: string; createdAt: number; updatedAt: number; messages: StoredMessage[] }
interface SessionMeta { id: string; title: string; createdAt: number; updatedAt: number; messageCount: number; preview: string }
// index.json: { version: 1, sessions: SessionMeta[] }
```

### IPC

- `ai:listSessions(workspace) → UiSessionMeta[]`（updatedAt desc）
- `ai:loadSession(workspace, id) → UiSessionData | null`
- `ai:saveSession(workspace, data) => { ok: true, id }`（upsert，重写 index）
- `ai:deleteSession(workspace, id) => { ok: true }`
- 导出走渲染进程：loadSession → `toMarkdown` 在主进程提供 `ai:sessionToMarkdown(workspace,id) → string`，前端拿字符串后复用 `fs:saveDialog` + `fs:writeFile`

## 四、实施步骤（依赖序）

1. **chatHistory.ts**：wsKey/目录解析、index 读写、upsert（文件+索引同事务语义：先写会话文件成功后再写 index）、delete、deriveTitle（首条 user，去换行，截 20 字，空则「未命名会话」）、preview（末条非 tool 消息截 60 字）、toMarkdown（# 标题/时间、`**用户**：`/`**助手**：`、工具引用块）。
2. **chatHistory.test.ts**：tmpdir 工厂注入 userDataRoot；约 12 例。
3. **IPC + preload + api.d.ts**：5 个通道（含 sessionToMarkdown）。
4. **chat store 接线**：消息 ts、currentSessionId 生命周期、persist 防抖、工作区 watch 恢复、new/switch/rename/delete/export、切换时瞬态重置。
5. **SessionHistory.vue + ChatPanel 两个头部按钮**：搜索/列表/操作/删除应用内确认；相对时间格式化函数放组件内（刚刚/N 分钟前/昨天/日期）。
6. 验证：双端 typecheck、全量 vitest（197 → 约 209）、重启 dev + CDP 冒烟（发两轮消息→历史文件落盘→历史弹窗列表→切换/重命名/删除→重启恢复→导出 md 内容）。
7. 更新《项目结构说明.md》并汇报。

## 五、依赖与注意点

- 存储放 **userData/chat-history/<wsKey>/** 而非工作区 `.trae/`：聊天含代码片段可能涉敏，不污染用户仓库、不需要 gitignore；wsKey 用 `Buffer.from(workspace).toString('base64url')`，无工作区为 `no-workspace`。
- 单会话消息上限 2000 条（超出丢弃最早的非 user 消息之外的策略：直接硬截断最早消息并在首条打省略标记），防止失控膨胀；单会话文件 JSON 写入用临时文件 rename 防半写。
- 欢迎语、isNotice、isStreaming 不入库；tool 消息存 toolName+content（content 已经是摘要/结果文本，单条截 2000 字）。
- 持久化防抖 1s；`sending` finally 与 onChatDone 双触发取并集（最后一次写入为准）；页面 unload 时同步 flush 一次（sendBeacon 不适用 IPC，用 beforeunload 内立即同步调用——Electron 中 IPC invoke 在 unload 不一定完成，故每轮 chunk 不存、仅在消息完成边界存，已足够）。
- 切工作区时当前未保存内容由防抖保证（watch rootPath 先 flush 旧分区再加载新分区）。
- 不引新依赖；时间格式化纯前端实现。
- vitest 安全：chatHistory 不 import electron，userDataRoot 参数注入；handler 内惰性 `app.getPath`。

## 六、验证

- `vitest run`：新增约 12 例，存量 197 例不回归。
- typecheck:main + typecheck:renderer 零错误。
- CDP 真窗冒烟（临时探针，用完即删）：
  1. 发 1 条消息并等待回复完成 → `ai:listSessions` 返回 1 条、title 为问题前缀、messageCount≥2
  2. userData 下存在 `chat-history/<wsKey>/index.json` 与 `<id>.json`
  3. 新建会话 → currentSessionId 变化、列表 2 条；重命名生效；删除后列表恢复
  4. reload 页面 → 自动恢复上次会话且消息完整
  5. `ai:sessionToMarkdown` 输出含标题/用户/助手角色分段
  6. 历史弹窗渲染与搜索过滤正常（截图）

## 七、风险与应对

- **写入频繁拖慢**：1s 防抖 + 仅在消息完成边界触发；流式 chunk 绝不逐条落盘。
- **index 与分文件不一致**（崩溃在两次写之间）：load/list 时以分文件实际存在为准做自愈重扫（发现孤儿文件补 meta、meta 指向缺失文件则剔除）。
- **切换会话瞬间流式事件写错会话**：切换在非 sending 时才允许（sending 中禁用切换/新建，按钮置灰），从根源杜绝。
- **删除当前会话**：自动 newSession 空态；localStorage lastSession 同步清除。
- **消息含特殊字符致 Markdown 混乱**：toMarkdown 对内容不做 HTML 转义（纯 .md 阅读），仅用角色分段与空行分隔。
