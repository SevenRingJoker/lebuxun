# 1.3 SCM 源代码管理面板 实施计划

> 来源：路线图 39 §1.3（P0）。目标：左栏「源代码管理」Tab，VS Code 式暂存/取消暂存/提交/分支切换，支持中文路径，与现有检查点/回滚能力共存。
>
> 步骤沿用全局编号：**s11–s17**（承接 1.2 的 s1–s10）。

## 一、现状研究结论

**已有的 Git 能力（[handlers/git.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/git.ts)）**
- 底层 `runGit(root, args, withIdentity)`：spawn 本机 git，统一 `-c core.quotepath=false`，commit 类命令注入 `user.name=TraeCode` 兜底，不改用户全局配置。
- `parsePorcelain`（`status --porcelain=v1 -z`，rename 双 token）+ `classifyStatus`——**现状模型 [GitChange](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/git.ts#L15-L27) 把一个文件压平成单个 status + staged 布尔，无法表达「已暂存后又修改」（同一文件同时在两组）**。
- 单文件全量 diff（`diffFile`：patch + 新旧全文，200KB 上限，untracked 走 `--no-index`）、`restoreTrackedFile`（checkout HEAD）、createCheckpoint（add -A → commit，消息 `trae-checkpoint:` 前缀）、listCheckpoints、restoreCheckpoint（reset --hard）、cleanupTaskCreatedFiles（任务放弃精确清理）。
- IPC 八通道：isRepo/init/status/diffFile/checkpointCreate/checkpointList/checkpointRestore/fileRestore。

**渲染端现状**
- [stores/git.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/stores/git.ts)：refresh（isRepo+status+checkpointList）、discardChange（**已覆盖 tracked 还原 + untracked 走 fs.trash 回收站，SCM 的 discard 直接复用，不新增 IPC**）、notice 轻提示；IPC 参数已按 `{...toRaw()}` 脱 Proxy。
- [DiffViewer.vue](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/components/DiffViewer.vue)：fixed 遮罩、左侧改动+检查点、右侧 Monaco DiffEditor、自带应用内确认态；SCM 点击文件将**复用它做差异预览**（加预选路径），不新造 diff 组件。
- 左栏 Tab 在 [FileTree.vue](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/components/FileTree.vue#L18)：`files | search | debug | validation | problems`；图标式按钮行在 L638-660。
- AI 任务结束后 [chat.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/stores/chat.ts) 已有 4 处 `git.refresh()`，SCM 面板天然回刷。

**环境事实**
- 本机 git 2.47.0（支持 `git restore --staged` 与 `git switch`）；项目本体与测试工作区均**非 git 仓库**，冒烟需在临时目录建真仓库。
- 现有 [git.test.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/git.test.ts) 只测纯函数；真实 IO 用例新增到同文件，git 不可用时 `describe.skipIf` 跳过（CI 的 ubuntu/windows 均自带 git）。

## 二、文件与模块

**修改（主进程）**
- `src/main/handlers/git.ts`：
  - 新增 SCM 数据模型 `ScmItem` / `ScmGrouped`；纯函数 `groupChanges(changes)`（staged/unstaged/untracked 三组，同文件可进两组）。
  - `statusGrouped(root)`：status + 当前分支（symbolic-ref）+ hasHead（rev-parse --verify）。
  - `stagePaths(root, paths)` / `unstagePaths(root, paths)`（空数组=全部；restore --staged 失败回退 reset）。
  - `commitStaged(root, message)`（仅提交已暂存，空暂存报错，identity 兜底）。
  - `listBranches(root)` + 纯函数 `parseBranchList`（**实测 git 2.47 的 `git branch` 没有 `--porcelain` 选项，原计划名称 parseBranchPorcelain 已废弃**；改用 `git for-each-ref --format=%(refname:short) refs/heads` 拿列表，配合 symbolic-ref 的 currentBranch 标记当前项，识别 detached/unborn）。
  - `switchBranch(root, name)` / `createBranch(root, name)`（switch / switch -c）+ 纯函数 `isValidBranchName`。

- `src/main/handlers/git.test.ts`：纯函数新用例（分组/分支解析/分支名校验）+ tmpdir 真实仓库 IO 用例（skipIf）。

**修改（渲染端）**
- `src/preload/index.ts`：git 块补 7 通道。
- `src/renderer/src/api.d.ts`：补 UiScmItem/UiScmGrouped/UiBranchInfo 等类型。
- `src/renderer/src/stores/git.ts`：grouped/branchInfo 状态 + stage/unstage/commit/branch actions + `openViewerAt(path)`。
- `src/renderer/src/components/FileTree.vue`：leftTab 联合类型加 `'scm'`，按钮置于 **files 之后**（贴近 VS Code 布局），挂载 `<ScmPanel v-if="leftTab==='scm'" />`。
- `src/renderer/src/components/ScmPanel.vue`（**新建**）：分支头 + 提交框 + 三折叠分组 + 逐文件操作 + discard 应用内确认；点击文件 openViewerAt 复用 DiffViewer。
- `src/renderer/src/components/DiffViewer.vue`：支持 viewerInitialPath 预选。
- `src/renderer/src/locales/zh-CN.ts` + `en.ts`：新增 `scm` 命名空间。

## 三、实施步骤

- **s11（分组模型）**：ScmItem/ScmGrouped + `groupChanges` 纯函数 + `statusGrouped` + 纯函数单测。
- **s12（暂存操作）**：stagePaths/unstagePaths（含全部场景），主进程侧路径边界校验 + tmpdir 真实仓库单测。
- **s13（提交与分支）**：commitStaged、listBranches/parseBranchPorcelain、switchBranch/createBranch/isValidBranchName + 单测。
- **s14（接线）**：7 个新 IPC（git:statusGrouped/stage/unstage/commit/branchList/checkoutBranch/createBranch）+ preload + api.d.ts。
- **s15（store + Tab）**：git store 扩展 + FileTree 挂 scm Tab。
- **s16（ScmPanel + i18n）**：面板完整交互、DiffViewer 预选、中英双语。
- **s17（全量验证 + 文档回写）**：见 §五。

## 四、关键参数与语义约定

**分组规则**
- 暂存组：X ≠ 空格/`?`；工作区组：Y ≠ 空格/`?`；未跟踪：XY=`??` 单独一组。
- 同文件「暂存后再改」（如 `MM`）同时出现在暂存组（徽标 M=X）与工作区组（徽标 M=Y）；行 key 为 `path + rawCode + 组名`。
- rename/copy（R/C）携带 oldPath，徽标显示 R；徽标色：暂存组青色 `var(--accent)`、工作区组黄/红（M 黄 `#e2c08d`、D 红 `var(--danger)`）、未跟踪 U 绿色（`#73c991`），整体保持科技风底色。

**暂存/取消**
- stage：`git add -- <paths>`；全部：`git add -A`；主进程对每个相对路径 join(root) 后过 isWithinWorkspace，pathspec 数量上限 2000，全部经 `--` 分隔防参数注入。
- unstage：`git restore --staged -- <paths>`；失败回退 `git reset -q HEAD -- <paths>`（unborn 分支下 restore 可用、reset 不可用）。

**提交**
- commitStaged 只提交暂存区，**不做 add -A**（与 createCheckpoint 的区别）；消息复用 sanitize 规则（剥换行、≤200 字，默认占位「更新」）；空暂存/ nothing to commit 返回明确错误文案。
- 提交后自动 refresh + 文件树重载。

**分支**
- listBranches 走 `git for-each-ref refs/heads`（每行一个本地分支，按字典序；`git branch` 无 porcelain 选项），当前分支由 symbolic-ref 单独获取并在结果中标记 current；detached/unborn 时 current=null。仅本地分支（不含 remote）。
- switch：`git switch -- <name>`；create：先过纯函数 isValidBranchName 再 `git switch -c <name>`；校验规则对齐 git check-ref-format：禁开头 `-`/`/`、`..`、`~ ^ : ? * [ \`、空格、`@{`、结尾 `.`/`.lock`、连续 `//`、单字符 `@`、长度 >128。
- 切分支前工作区有冲突改动时 git 自行报错，原样透传，本地改动保留，不自动 stash。

**复用与边界**
- discard 全部走现有 discardChange（tracked → git:fileRestore；untracked → fs.trash），SCM 面板内做应用内二次确认，不弹原生 confirm。
- root 沿用 workspace 根（允许是仓库子目录，porcelain 路径与 cwd 对齐，现有代码已如此）；不做 push/pull/远程操作、不做 rebase/stash UI、不做逐 hunk（属 2.1）。

## 五、验证（s17）

- `npm run typecheck` 双端零错误。
- `npx vitest run`：新增用例在 **1111** 基线上只增不减（预期 +50 上下；测试文件数仍 45，追加进 git.test.ts），其余域不回归。
- `npm run build`。
- CDP 真窗冒烟（临时脚本放 scratch/，用完即删；在 tmpdir/临时目录建独立 git 仓库并在应用中打开）：
  1. 改文件/新建/删除 → 三组计数与字母正确；点击文件 DiffViewer 预选并渲染 diff。
  2. 单个 stage/unstage、组级全部暂存/取消；「暂存后再改」文件双组可见。
  3. 提交框空暂存按钮禁用态；提交后 checkpointList 与 ScmPanel 均刷新。
  4. 建分支 → 切换 → 切回；discard 走应用内确认并落盘核验；中文路径文件全链路。

## 六、风险与应对

- 分组后同文件双组的操作互相影响（如在工作区组 discard 会清掉暂存态差异）：discard 文案明确「将同时放弃已暂存改动」；unstage 不影响工作区内容，语义安全。
- 旧 git（<2.23）无 restore/switch：本机 2.47 满足；unstage 已带 reset 回退；switch 失败提示升级 git（不做全量回退实现）。
- 分支名/路径注入：纯函数白名单 + `--` pathspec + hash/格式校验 + 工作区边界四道防线。
- 网络盘 D: watcher 不触发：SCM 在面板挂载、每次变更后、AI 任务结束（既有钩子）三个时机 refresh，另保留手动刷新按钮。

## 七、完成状态（s17，2026-10-02）

s11–s17 全部交付，验收项 §五 全部通过。

**实现与原计划的差异（均已在正文同步）**
1. `git branch` 实测无 `--porcelain` 选项 → 分支列表改 `git for-each-ref refs/heads` + symbolic-ref 标记 current；parseBranchPorcelain 命名废弃。
2. s11 新增用例实际 **11 个**（groupChanges 10 + toScmItem 1；原 git.test.ts 五段为 22 测），交接摘要曾误记「12 个/文件 33」中「12」有误（22+11=33 总数无误）。
3. discard 未新开 IPC：ScmPanel 把 ScmItem 映射回旧扁平 UiGitChange（优先复用 changes 同路径项），复用现有 `discardChange`（tracked→git:fileRestore、untracked→fs.trash）。
4. 提交消息空值回落文案为「更新」（计划正文已写）；commit 输入为异步 IPC，UI 上用 committing 态防重复提交。

**最终验证**
- 双端 typecheck 零错误；electron-vite build 通过。
- 全量单测：**1173 passed（45 文件，1 skipped）/ 5 E2E skipped**；git.test.ts 由 22 → **84 测**（+62：s11 11、s12 13、s13 38）。
- CDP 真窗冒烟（独立临时 git 仓库）：三组计数与 M/D/U 字母、中文路径、单个/全部 stage·unstage、「暂存后再改」双组同现、提交（空暂存禁用态）落盘磁盘核验、分支新建/切换/切回、discard 应用内确认（取消保留/执行还原核验）、DiffViewer viewerInitialPath 预选渲染。

**冒烟期环境现象（非产品缺陷）**
- dev 启动后页面视口一度退化为 300×300（OS 窗口 rect 正常），导致 Monaco 零宽度不渲染、`Page.captureScreenshot` 请求挂起；将窗口最大化（ShowWindow SW_MAXIMIZE）后视口恢复 2560×1400，截图与 diff 均正常。云主机/会话合成器偶发现象，记此备查。

## 八、已知问题 / 后续

1. **`.trae/` 目录污染用户 git 状态**：应用把 code-index.json 等写入 `<workspace>/.trae/`，git 不跳过隐藏目录（与尊重 .gitignore 的 rg 不同），该目录会作为 untracked 出现在 SCM 面板；全部暂存（add -A）时也会被带入。当前无自动 .gitignore 处理。候选方案（需用户决策，不擅自改用户文件）：
   - 首次在仓库内生成 .trae 内容前，征得同意后向 .gitignore 追加 `.trae/`；
   - 或在 SCM 面板对 `.trae/` 条目做应用自身产物的视觉标记（仍如实显示 git 状态）。
2. 旧 git（<2.23）的 `switch` 无回退实现（unstage 的 reset 回退已做）；本机 2.47 满足，遇旧版给升级提示。
3. 逐 hunk 暂存、push/pull、stash UI 均按边界排除，属后续阶段（2.1 及以后）。
