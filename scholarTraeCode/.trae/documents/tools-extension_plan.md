# P1⑩ 工具扩展 实施计划

> 日期：2026-09-30
> 前置：P1⑨ 已完成（268 例单测全绿）。本项为路线图第 8 项。

## 一、现状与痛点

- `src/main/ai/builtinTools.ts` 固定 6 个内置工具（read/write/edit/bash/grep/glob），经 `mcpToolBridge.collectTools()` 与 MCP 工具合并喂给模型；调度器统一在 `permissionGate.check()` 过闸后执行。
- 缺高频能力：删除/移动/复制（MCP filesystem 未连接时不可用）、联网搜索/抓取、测试/构建脚本直跑、Git 操作、依赖版本查询。模型只能用 bash 拼凑，失败率高且难以审计。
- 权限层 `permissions.ts` 用三个集合分类（READ_ONLY/WRITE/COMMAND），未登记工具一律降级询问——新工具必须显式登记才能获得正确的模式行为。

## 二、目标（初版范围）

新增 8 个内置工具，全部不依赖 MCP、零 electron 依赖（保持纯 Node 可单测）：

| 工具 | 说明 | 权限分类 |
|------|------|----------|
| `delete` | 删除文件/目录——**移入工作区 `.trae/trash/<时间戳>-<名称>`**（可恢复，不硬删） | write |
| `move` | 移动/重命名（自动建父目录，跨设备回退 copy+delete） | write |
| `copy` | 递归复制文件/目录（fs.cp） | write |
| `web_fetch` | HTTP 抓取 URL，HTML 剥离为纯文本；超时 15s、大小 100KB、重定向 ≤3 | read |
| `web_search` | DuckDuckGo HTML 端点搜索（无需 API Key），解析标题/链接/摘要 | read |
| `run_script` | 运行工作区 package.json 中白名单脚本（test/lint/build/typecheck/check/compile 前缀），内部走 `npm run <script>` | command |
| `git` | 子命令白名单：status/diff/log/show/branch/add/commit/checkout/restore/stash list；禁 push/reset --hard/clean 等破坏性操作（白名单直接拒绝） | command |
| `npm_info` | 查询依赖包最新版本/描述/license——直连 registry.npmjs.org REST（纯 HTTP，不 spawn npm CLI） | read |

浏览器类操作不造轮子，仍走 MCP（playwright/puppeteer server）。

## 三、实施步骤

### 1. 纯函数层 + 单测

新文件 `src/main/ai/builtinToolsExt.ts`（零 electron）：

- **纯函数**（可单测）：
  - `stripHtml(html)` — 去 script/style/标签/实体，压缩空白
  - `parseSearchResults(html)` — DDG 结果解析（标题/链接/摘要，去广告锚点）
  - `isAllowedScript(name, scripts)` — 白名单正则 + 必须真实存在于 package.json scripts
  - `validateGitArgs(args)` — 子命令白名单 + 禁用旗标（--hard、--force、-f、push/submodule 等）
  - `parseNpmRegistry(json)` — latest 版本/描述/license 提取
- **工具执行体**：delete/move/copy（tmpdir 端到端单测）；web_fetch/web_search/npm_info 注入 fetcher 便于假 fetch 单测（沿用 embeddings.test.ts 假 fetcher 模式）；run_script/git 复用 spawn 模式（GBK 转码沿用 bash 工具做法）。
- `builtinTools.ts` 注册表合并：`BUILTIN_TOOLS = [...核心 6 个, ...EXTRA_TOOLS]`。

新测试文件 `src/main/ai/builtinToolsExt.test.ts`（目标 ≥20 例）。

### 2. 权限层接线（`permissions.ts`）

- READ_ONLY_TOOLS += `web_fetch`、`web_search`、`npm_info`
- WRITE_TOOLS += `delete`、`move`、`copy`（沿用工作区外写入硬拒、敏感文件硬拒）
- COMMAND_TOOLS += `run_script`、`git`；新增 `commandTextOf(name, args)` 合成命令文本（`npm run <script>` / `git <args>`），供 evaluate 危险检测与 signatureOf 复用
- `extractTargets` += delete(path)、move/copy(source/destination)

`permissions.test.ts` 追加分类用例（目标 ≥8 例）。

### 3. 验证三件套

1. 双端 typecheck 零错误
2. 全量 vitest（268 → 目标 ≥296 例，只增不减）
3. CDP 真窗冒烟：开 dev（换用新端口，避开 9341 历史残留），通过窗口内验证工具注册清单、delete→trash 落盘、git 白名单拒绝 push、run_script 白名单拦截 dev 等链路

### 4. 文档同步

- 《项目结构说明.md》：7.1 表格 P1⑩ 标 ✅、7.2 新增⑩小节、文件树补 builtinToolsExt、单测计数更新
- 《日志.md》：新增 P1⑩ 里程碑 + 进度总览 + 下一项（P1⑪ 子代理增强）

## 四、明确不做（二期）

- web_search 多引擎/API Key 配置（Google/Bing/Tavily）
- git 全量子命令（merge/rebase/push 等需独立权限设计）
- run_script 用户自定义白名单配置 UI
- 浏览器自动化工具（交给 MCP）
