# ② Git / Checkpoint / Diff 实施计划

对照《项目结构说明.md》7.2 节第②项（P0）：AI 改文件可 diff 预览、逐文件接受/拒绝、运行前 checkpoint、一键回滚、查看提交历史。

## 一、代码研究结论

- git CLI 可用：本机 `git version 2.47.0.windows.2`。采用 spawn 直调 git（与 builtinTools.ts bash 同一方式），不引第三方依赖。
- IPC 注册范式：[index.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/index.ts#L163-L168) 集中 register*Handlers；[fs.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/fs.ts) 是 `ipcMain.handle + OpResult` 范式，照搬。
- Monaco 已在渲染进程可用（EditorPanel 使用），DiffEditor 直接 `monaco.editor.createDiffEditor`，无需新依赖。
- AI 任务发起入口在 [chat.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/stores/chat.ts) sendWithTools：自动 checkpoint 放在前端编排（发起前 await IPC），不耦合 scheduler。
- 任务结束后 chat.ts 已有 scheduleWorkspaceRefresh 刷新机制，同处挂 git status 刷新。
- 权限层（①）已落地：DiffViewer 的"还原文件"是用户手动操作，走 fs/git 专用 IPC，不经 Agent 权限闸。

**仓库策略（重要边界）**：不静默 `git init`（避免侵入用户项目）。工作区非仓库时，前端显示"初始化 Git 仓库"按钮，用户显式点击才 init；未初始化时 checkpoint 不可用，diff/还原也不可用，UI 明确提示。

## 二、文件与模块

**新增：**

- `src/main/handlers/git.ts`：git CLI 封装 + 可单测纯函数
  - `runGit(root, args, {input})`：spawn git，-c core.quotepath=false（中文路径）、必要时 -c user.name/user.email 兜底，返回 {code, stdout, stderr}
  - `isRepo(root)`、`initRepo(root)`
  - `status(root)` → `GitChange[] { path, status: 'modified'|'added'|'deleted'|'untracked'|'renamed', staged: boolean }`，用 `git status --porcelain=v1 -z` 解析（纯函数 `parsePorcelain` 导出单测）
  - `diffFile(root, path, status)`：tracked 文件 `git diff HEAD -- <path>`；untracked 文件用 `git diff --no-index -- /dev/null <path>`（退出码 1 为正常差异）；deleted 文件 `git diff HEAD -- <path>`
  - `createCheckpoint(root, label)`：`git add -A` 后 commit（message 加 `trae-checkpoint:` 前缀，清洗换行防注入）；无变更返回 {created:false, reason}，不产生空提交
  - `listCheckpoints(root)`：`git log --format=%H%x1f%h%x1f%an%x1f%ad%x1f%s -n 30`
  - `restoreFile(root, change)`：tracked `git checkout HEAD -- <path>`；untracked 新文件走删除（由前端二次确认后调用 fs:trash）；deleted 文件 `git checkout HEAD -- <path>` 恢复
  - `restoreCheckpoint(root, hash)`：`git reset --hard <hash>`（前端强确认弹窗）
  - `git.test.ts`：parsePorcelain 各状态码（M/A/D/??/R ）、message 清洗、参数边界
- `src/renderer/src/components/DiffViewer.vue`：cp-glass 模态（append-to-body 思路，fixed 遮罩）
  - 左栏改动文件列表（状态色点 + 路径），右栏 Monaco DiffEditor（HEAD 版本 vs 工作区）
  - 操作：还原此文件（红色，应用内确认弹窗）、关闭；底部：创建 checkpoint、回滚到 checkpoint（下拉选历史，强确认）
- `src/renderer/src/stores/git.ts`：isRepo、changes、checkpoints、loading；refresh()、open/close diff、restoreFile、createCheckpoint（带系统通知式反馈消息，复用 chat push？独立轻提示即可）

**修改：**

- `src/main/index.ts`：注册 registerGitHandlers()
- `src/preload/index.ts` + `api.d.ts`：git 通道与 GitChange/GitCheckpoint 类型
- `stores/chat.ts`：autoCheckpoint 开关（默认开，localStorage 持久化）；sendWithTools 前若 isRepo 则 createCheckpoint('AI 任务前自动检查点')；结束后刷新 git store
- `ChatPanel.vue`：头部加"改动 N"按钮（N=changes.length，青色徽章）打开 DiffViewer；旁边加 checkpoint 开关小图标；非仓库时按钮置灰 + tooltip 提示先初始化

## 三、实施步骤

1. git.ts：runGit + 纯函数 parsePorcelain + status/diff/checkpoint/restore/init
2. git.test.ts，vitest 跑绿
3. IPC 注册（git.ts handler 区 + index.ts）
4. preload + api.d.ts
5. stores/git.ts
6. DiffViewer.vue（Monaco DiffEditor + 文件列表 + 还原/回滚/初始化）
7. ChatPanel.vue 入口按钮 + chat.ts 自动 checkpoint 编排
8. typecheck + 全量 vitest
9. 沙箱外重启 dev，冒烟：真实仓库中 AI 写文件 → status 出现改动 → diff 正确（含 untracked 新文件全文）→ 还原 → checkpoint 列表 → reset 回滚；非仓库显示初始化引导

## 四、依赖与注意事项

- 不新增 npm 依赖（git CLI + 内置 monaco）。
- 中文路径：core.quotepath=false + porcelain -z（NUL 分隔，路径含空格/换行安全）。
- 用户未配置 user.name/email 时 checkpoint 提交会失败：commit 命令内联 `-c user.name=TraeCode -c user.email=traecode@local`，不改用户全局配置。
- 还原 untracked 文件=删除文件，必须用应用内确认弹窗（遵循项目"禁用原生 confirm"约束），删除走回收站 fs:trash。
- reset --hard 强确认文案明确"丢弃检查点之后的全部改动"。
- `.trae/` 目录的 checkpoint 审计日志等也会被 add -A：检查现有 .gitignore 情况，若无建议不擅自改用户 ignore；checkpoint 提交信息与文档说明即可（保持范围克制）。
- diff 大文件截断（单文件 >200KB 不加载原文，提示"文件过大，仅终端查看"），防 Monaco 卡死。
- DiffViewer 用 fixed 定位遮罩，规避项目已知 cp-page z-index 问题（独立于 cp-page 树挂载在 App 根）。

## 五、验证

- `npm test`：git 纯函数单测 + 现有 128 例全绿
- typecheck 双配置（仅历史遗留 App.vue）
- dev 实机冒烟 5 条路径（见步骤 9）

## 六、风险

- **git 不可用（个别机器未装）**：isRepo 探测失败时 UI 显示"未检测到 git"，功能整体降级不报错。
- **reset 误操作**：强确认 + 回收站/检查点双保险（reset 前自动再建一个"回滚前"检查点）。
- **Monaco DiffEditor 双模型内存**：切换文件 dispose 旧 model，面板关闭 dispose editor。
- **porcelain 解析复杂场景**（rename、staged+worktree 双状态）：解析覆盖 R 与双码，拿不准的显示原始码不崩溃。
