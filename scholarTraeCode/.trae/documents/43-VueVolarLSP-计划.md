# 1.4 Vue / Volar LSP 实施计划

> 来源：路线图 39 §1.4（P0）。目标：`.vue` 单文件组件获得补全/悬停/跳转/引用/重命名/格式化/代码操作与 template+script 诊断，与现有 TS LSP 不冲突，切换文件正常。
>
> 步骤沿用全局编号：**s18–s22**（承接 1.3 的 s11–s17）。

## 一、现状研究结论

**现有 LSP 链路（TS 单服务器）**
- 主进程 [handlers/lsp.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/lsp.ts)：spawn `typescript-language-server --stdio`（node 直跑 `lib/cli.mjs`），手工解析 Content-Length 帧；3 个 IPC：`lsp:start`（单例）/`lsp:write`/`lsp:stop`，回推通道 `lsp:message`。**当前是写死的单服务器、单通道模型**。
- 渲染端 [lspClient.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/lsp/lspClient.ts)：单例类，initialize → initialized → 单文档 didOpen/Change/Save/Close + 7 类能力请求；诊断按 **uri 字符串** 存 Map。
- [monacoLsp.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/lsp/monacoLsp.ts)：关闭 Monaco 内置 TS 服务，对 4 个语言 ID（typescript/javascript/typescriptreact/javascriptreact）注册 7 类 provider，诊断写 markers；跨文件跳转预建模型。语言表 `EXT_LANG` 无 vue。
- Monaco 侧**从未注册 vue 语言**，打开 .vue 当前按 plaintext 处理。

**Volar 探针实验（2026-10-02，s18，脚本/数据已验证）**

包：`@vue/language-server@2.1.10`（与本机 vue-tsc 同版本，bin `bin/vue-language-server.js`，依赖 `@volar/language-server`、`@vue/language-core`、`@vue/language-service`、`@vue/typescript-plugin`，纯 JS 无原生二进制）。

1. **initialize 必须携带初始化选项**：`initializationOptions.typescript.tsdk` 指向 **typescript 包的 `lib` 目录**（含 tsserver.js；传包根会报 `Can't find typescript.js`）。
2. **必须显式 `vue.hybridMode: false`**：默认 hybridMode=true 依赖外部 TS server 端 named pipe（VS Code 内置 TS 扩展场景），本应用不具备；false 走 `createTypeScriptProject` 全功能模式——**单服务器同时处理 .ts 与 .vue（官方 Take Over）**。
3. capabilities 覆盖现有 7 类（completion 含 resolveProvider 与 21 个 triggerCharacters、hover、definition、references、rename 含 prepareProvider、documentFormatting、codeAction 含 9 种 kinds），另含 signatureHelp/inlayHint/semanticTokens 等。
4. 诊断实测：`.ts` 收到「不能将 string 分配给 number」；`.vue` 同时收到 **template 跨块诊断**（模板中对 string 调 toFixed）与 script 诊断。→ Take Over 可行。
5. `.vue` script 内 completion 返回 1976 项；template 内 hover 返回 DOM 属性 markdown。
6. **URI 形式差异**：Volar 回推 `file:///d%3A/...`（盘符冒号被编码，vscode-uri 风格），我方 [pathToUri](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/shared/lsp/converter.ts#L21-L28) 经 `encodeURI` 产生 `file:///d:/...`（冒号不编码）。诊断 Map 按字符串索引会失配，**集成时必须归一化**（以 uriToPath→pathToUri 或直接以 path 为 key）。

**架构决策：Take Over 二选一（不双服务器常驻）**
- 工作区含 .vue（start 时扫描；或运行中打开 .vue 触发切换）→ 仅启动 vue-language-server，vue/ts/js/tsx/jsx 全部路由给它。
- 无 .vue → typescript-language-server，行为同现状。
- 理由：两服务器各跑一个 TS LS 实例约 2× 内存，且 .vue↔.ts 交叉类型可能不一致；路线图验收「不冲突」在二选一架构下天然满足。typescript-language-server 依赖保留，无 vue 的纯 TS 工作区启动更快更省。

**运行时 TypeScript 来源（打包要点）**
- typescript 当前在 devDependencies，electron-builder 不打入包；typescript-language-server 靠从用户工作区向上探测 typescript，生产环境无 TS 项目时无确定运行时；Volar 又必须显式 tsdk。
- s19 将 **typescript 移至 dependencies** 并加入 asarUnpack，主进程解析 asar 内 `typescript/lib` 作为 tsdk，两服务器均有确定 TS 运行时（体积代价约数十 MB 源码、压缩后个位数 MB）。

## 二、文件与模块

| 文件 | 改动 |
|------|------|
| [handlers/lsp.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/lsp.ts) | 重构：服务器描述表（id/resolveEntry/exts）、按 serverId 管理子进程与缓冲、IPC 加 serverId、消息回推带 serverId、tsdk 解析、vue 工作区探测 |
| handlers/lsp.test.ts（新建） | server 选择纯函数、扩展名路由、探测边界 |
| [lspClient.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/lsp/lspClient.ts) | 支持按 server kind 启动/切换；initialize 参数分支（vue 初始化选项）；诊断 key 归一化；切换时重启生命周期 |
| [monacoLsp.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/lsp/monacoLsp.ts) | providers 语言集加 vue；EXT_LANG 加 vue；markers 归一 |
| `renderer/lsp/vueLanguage.ts`（新建） | Monaco registerLanguage：Monarch 语法（template HTML 内嵌、script lang=ts/js、style CSS）+ configuration |
| [EditorPanel.vue](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/components/EditorPanel.vue) | 扩展名→语言 ID 加 .vue；LSP 启动/切换时机 |
| [preload/index.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/preload/index.ts)、api.d.ts | lsp.start/write 签名加 serverId；onMessage 回调带 serverId |
| [package.json](file:///d:/47.104.20.186/aiProject/scholarTraeCode/package.json) | typescript 移 dependencies；asarUnpack 加 typescript、@vue/language-server 及 @volar/*、@vue/language-core、@vue/language-service 等依赖链 |
| zh-CN.ts / en.ts | 必要的 vue LSP 相关文案（如 Problems 中来源标记，若现有键不足） |

## 三、实施步骤

- **s18**（本步 ✅）：安装 @vue/language-server@2.1.10；协议探针确认 tsdk/hybridMode/capabilities/双块诊断/Take Over/URI 差异；本计划文档。
- **s19** 主进程多服务器：
  - `LspServerKind = 'ts' | 'vue'`；服务器描述表：入口解析（tls 直跑 cli.mjs；vue 直跑 bin/vue-language-server.js + `--stdio`）、语言集合。
  - 子进程状态按 kind 各存一份（proc/buffer/sender）；IPC：`lsp:start(kind)`、`lsp:write(kind,msg)`、`lsp:stop(kind)`；回推 `lsp:message(kind,msg)`。
  - `resolveTsdk()`：require.resolve('typescript/package.json') → lib 目录（供渲染端 initialize 使用，经 start 返回值下发）。
  - `detectVueWorkspace(root)`：限深扫描（ripgrep 或受限 walk，超时/数量上限，失败默认 false=走 tls）。
  - package.json：typescript 移 dependencies + asarUnpack 补充。
  - 单测：chooseServerKind（有无 vue/扩展名）、路由表、扫描纯函数边界。
- **s20** 渲染端客户端：
  - LspClient 增加 kind 状态；`start(kind, root, applier)`：kind 不同或已运行时先停旧再启新；vue 时 initialize 携带 `{typescript:{tsdk}, vue:{hybridMode:false}}`（tsdk 来自 start 返回）。
  - 诊断存取统一经 `normalizeUri`（uriToPath→pathToUri）；openDoc 记录 kind。
  - 切换工作区/打开 .vue 的切换编排（EditorPanel 或 store）。
  - 单测：URI 归一化、初始化参数分支、路由合并。
- **s21** Monaco vue 语言与 providers：
  - vueLanguage.ts：Monarch（root 按 `<template>/<script>/<style>` 切入嵌入规则，script lang="ts"→typescript tokens，默认→javascript；样式→css；HTML 模板复用 html token 名）+ language configuration（括号/注释/自动闭合）。
  - `monaco.languages.register({id:'vue'})`；EXT_LANG.vue='vue'；7 类 provider 注册循环加 'vue'；ensureModel 支持 vue。
  - EditorPanel 打开 .vue 时语言判定、didOpen languageId='vue'。
- **s22** 验证与回写：
  - 全量 vitest（基线 1173 + 新增）、双端 typecheck、build。
  - CDP 真窗冒烟：.vue 补全/跳转（vue→ts、ts→vue）/模板+脚本诊断进 Problems/重命名跨文件/格式化；.ts 回归；vue/非 vue 工作区服务器切换；中文路径。
  - 文档回写：39（1.4 ✅）、本文件完成状态、项目结构说明、日志.md。

## 四、关键参数与语义约定

- Volar initialize（vue kind）：
  `initializationOptions: { typescript: { tsdk: '<typescript/lib 绝对路径>', disableAutoImportCache: false }, vue: { hybridMode: false } }`
- didOpen languageId：`.vue` → `'vue'`；其余同现状。
- 诊断 URI：服务端回推形式不保证与客户端一致，一律经 `normalizeUri` 归一后做 Map key；markers/provider 查询同步归一。
- 服务器切换 = 完整生命周期（stop 子进程 → 新 initialize），不做热迁移；切换时旧文档在新服务器重新 didOpen。
- 探测仅用于默认选 server；用户显式打开 .vue 即升级到 vue kind（即使扫描未命中）。

## 五、验证（s22）

- 单测基线 1173 只增不减；新增覆盖：扩展名路由、chooseServerKind、URI 归一、初始化参数分支。
- CDP 冒烟项同 s22 所列；磁盘与 DOM 双断言。
- 双端 typecheck 零错误、electron-vite build 通过；asarUnpack 后 vue-language-server 可从 asar.unpacked 正常启动（打包结构核查，必要时补 unpack glob）。

## 六、风险与应对

| 风险 | 应对 |
|------|------|
| @volar/@vue 传递依赖链在 asar 内动态 require 失败 | asarUnpack 覆盖整条链；s22 核查解包结构 |
| TS 5.9 与 Volar 2.1.10 兼容性 | 探针已实测通过；若后续问题可将 typescript 锁至 ~5.6 |
| 大工作区 vue 探测慢 | 限深/限量/超时，默认 false 不阻塞启动；打开 .vue 可触发切换 |
| 双 URI 形式致诊断丢失 | 归一化 + 单测固化 |
| 打开 .vue 触发重启 LSP 打断当前会话 | 切换仅在 server kind 变化时发生一次；切换中请求安全空返回（现有 provider 已有 ready 守卫） |

## 七、完成状态（s23，2026-10-02）

s18–s21 代码早已交付，但验证/回写长期缺失（路线图挂 ⬜）；s23 补齐 CDP 真窗冒烟、文档回写与环境清理，验收项 §五 全部通过。

**实现与原计划的差异**
1. **spawn 必须带 `ELECTRON_RUN_AS_NODE=1`**（计划未预见，s23 修复）：`process.execPath` 是 electron.exe，直接跑 vue-language-server 会静默退出码 1（无 stderr）；[handlers/lsp.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/lsp.ts) spawn env 补该变量，与既有 [handlers/mcp.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/mcp.ts) 同一约定。
2. 冒烟 fixture 必须建在能向上解析到 `node_modules/vue` 的位置（实际置于项目树 `scratch/smoke-vue-full`）；盘根目录模板虚拟程序无法构建、只有脚本诊断——非产品缺陷，真实 Vue 项目必装 vue。
3. Volar 诊断回推 URI 为 `file:///d%3A/...`（盘符小写、冒号编码），冒烟侧 normKey 统一小写盘符；产品侧归一化已在 s20 落实。

**最终验证**
- 双端 typecheck（tsc + vue-tsc）零错误。
- 全量单测：**1205 passed（47 文件，1 skipped）/ 5 E2E skipped**；1173 → 1205（+32）。
- CDP 真窗冒烟 **14/14 通过**：detectVue 二选一、start（tsdk 指向 typescript/lib）、initialize 五能力齐、App.vue 模板跨块诊断（toFixed）+脚本诊断、completion 1014 项、hover add 签名、definition vue→math.ts、rename 声明处跨 App.vue+math.ts、rename 使用方仅本地别名、formatting（edits=1）、中文路径 Panel.vue 诊断、Take Over 下 bad.ts 诊断、stop。
- 冒烟脚本：[scripts/cdp-test-vue-lsp.cjs](file:///d:/47.104.20.186/aiProject/scholarTraeCode/scripts/cdp-test-vue-lsp.cjs)（保留为回归资产）。

## 八、已知问题 / 后续

1. **从导入使用方 rename 走本地别名**：typescript-language-server 默认偏好硬编码 `providePrefixAndSuffixTextForRename: true`；Volar 经 `useAliasesForRenames`（默认 true）同样。从 .vue/.ts 使用位置 rename 被导入符号 → import 行别名化（`add as addAlias`）、声明文件不动；**跨文件重命名需从声明处发起**。已用直调 TS LanguageService API 双重位置实验与纯 TS LSP 对照确认，属上游 TS 5.9 行为、非本产品缺陷。后续若要产品级修复：typescript-language-server 支持 `initializationOptions.preferences` 覆盖（s23 已确认 mergeTsPreferences 入口），Volar 需客户端正确响应 `workspace/configuration` 的 preferences 段。
2. 冷启动首次 initialize 偶发超时，重试一次即成功（非确定缺陷）。
3. vue 服务器内存占用高于纯 tls（Take Over 架构的固有代价）；无 .vue 工作区仍走 typescript-language-server 不受影响。
