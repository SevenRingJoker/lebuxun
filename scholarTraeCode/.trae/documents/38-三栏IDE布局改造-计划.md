# 三栏 IDE 布局改造计划（需求对照落地）

## Context

用户给出「旧 UI → 目标 UI」对照表 + 8 项优先级清单，要求把主界面改造为标准三栏 IDE 布局。经现状核对（App.vue / FileTree / EditorPanel / ChatPanel / cyber.scss），**大部分骨架已具备**，真正缺口集中在 5 处：

| 需求项 | 现状 | 结论 |
|---|---|---|
| 三栏 flex + 两条拖拽 splitter | App.vue L76-114 已有 leftWidth/rightWidth + startDrag | ✅ 已具备 |
| 全局滚动禁用 + 区域独立滚动 | cyber.scss L107-121 `overflow:hidden`；各栏自滚 | ✅ 已具备 |
| 右 AI 面板折叠 + 输入框固定底部 + 面板头部 | ChatPanel `chatVisible`、flex column、messages 自滚 | ✅ 已具备 |
| 栏宽/折叠持久化 | 宽度写死 20/30，刷新丢失 | ❌ 补 localStorage |
| 左栏整体折叠 | 仅右侧有折叠 | ❌ 新增 |
| 左栏「资源管理器」标题行 | 现有 files/debug/validation/problems 分段（用户已确认：保留分段，files 段内加标题行） | ❌ 新增 |
| 多文件 Tab 栏 | 单 `currentFile`，点文件覆盖当前文档 | ❌ **核心改造** |
| 编辑器底部状态栏 | 无（行列/语言/编码） | ❌ 新增 |
| 编辑器空白态 | 有简单空态，文案增强为「未打开文件」 | ⚠️ 增强 |

用户已确认的交互范围：Tab 切换/关闭/空白态 + 脏标记与关闭确认 + 拖拽排序 + 中键关闭。

## 改造方案

### 1. workspace store 多 Tab 化（核心）— `src/renderer/src/stores/workspace.ts`

现状：`currentFile` / `currentContent` / `fileDirty` 单文件模型，被 chat store（contextAnchor）、EditorPanel、scheduler（经 preload 参数）引用。

**兼容策略（不破坏下游引用）**：
- 新增 `openTabs: ref<Array<{ path: string; content: string; dirty: boolean }>>`
- 保留 `currentFile`/`currentContent`/`fileDirty` 语义 = 当前激活 Tab 的工作副本；切 Tab 时双向同步快照（切走前把 currentContent/fileDirty 写回旧 Tab 快照，切到后从目标快照恢复）
- `openFile(path)`：已在 openTabs → 激活；不在 → 读盘后 push + 激活（替代现有直接覆盖逻辑）
- `closeTab(path)`：dirty → 返回需确认信号（UI 弹应用内确认：保存并关/不保存/取消）；关闭 active → 激活邻近 Tab；清空 → currentFile=null
- `closeOthers`/`closeAll` 不做（需求未提）
- `moveTab(from, to)`：数组重排，供拖拽排序
- `markSaved()`：保存成功后同步 Tab 快照 dirty=false

### 2. EditorPanel.vue — Tab 栏 + 状态栏 + 空白态

- **Tab 栏**（内嵌模板顶部，不新建组件文件）：横向滚动列表，每 Tab 显示文件名 + 脏点（●）+ ×；点击激活；×关闭（dirty 弹确认：保存/不保存/取消，复用应用内弹窗模式，禁原生 confirm）；`mousedown button===1` 中键关闭；HTML5 drag 拖拽排序调 `moveTab`；样式对齐现有 header（cp-glass + 蓝青激活下划线）
- **底部状态栏**（EditorPanel 最底部一行，TerminalPanel 之下/之上以现有挂载点为准）：左 `行 X，列 Y`（`editor.onDidChangeCursorPosition`），右 语言（复用现有语言选择器显示值）· `UTF-8`（项目读写均为 UTF-8，固定展示）· 保存状态
- **空白态**：`openTabs.length===0` 时编辑器区显示「未打开文件」+ 提示从左侧资源管理器选择

### 3. App.vue — 左栏折叠 + 布局持久化

- `fileTreeVisible` ref（默认 true），顶部工具栏/左栏边缘加折叠按钮；左栏与左 splitter 一并 `v-if`
- `leftWidth`/`rightWidth`/`fileTreeVisible`/`chatVisible` 持久化 localStorage（键 `layout.*`），启动读取、变更即写
- 拖拽逻辑不变（现有百分比制保留）

### 4. FileTree.vue — files 段标题行

- files 段顶部加一行：`资源管理器` 小标题 + 图标按钮组（迁移现有新建文件/新建文件夹/刷新按钮 + 新增「折叠全部」——对树展开状态做 collapseAll）
- debug/validation/problems 分段不动

### 5. 视觉统一

- 新 UI 元素全部复用 cyber.scss 现有 CSS 变量（--bg-*/--line/--cyan 等）与 cp-glass 风格；splitter hover/active 高亮已有则复用

## 不做

- Tab 溢出下拉菜单、Tab 预览（hover 悬浮预览）、关闭右侧/全部
- 状态栏扩展项（Git 分支、问题计数等，后续可叠加）
- 左栏分段重构、拖拽分割线改像素制

## 关键文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/stores/workspace.ts` | openTabs 快照模型 + openFile/closeTab/moveTab/markSaved |
| `src/renderer/src/components/EditorPanel.vue` | Tab 栏 + 状态栏 + 空白态（主要工作量） |
| `src/renderer/src/App.vue` | 左栏折叠 + layout 持久化 |
| `src/renderer/src/components/FileTree.vue` | files 段标题行 + 折叠全部 |
| `src/renderer/src/stores/chat.ts` | 仅确认 currentFile 引用语义不变（预期零改动） |

## 验证

1. `npm run typecheck`（main + renderer）
2. `npx vitest run`（基线 1025 例不得下降；若 renderer 已有 store 测试基建则补 openTabs/closeTab/moveTab 单测）
3. `npm run build`
4. CDP 轻量冒烟（纯 DOM，不走模型）：开 3 文件 → Tab 出现/切换/脏点 → 中键关 → dirty 关闭弹确认 → 全部关闭出空白态 → 拖宽左栏 + 折叠左右栏 → reload 后宽度/折叠态还原
5. 更新 `项目结构说明.md`（目录树/7.2 小节）与 `日志.md`（状态行 + 里程碑）
