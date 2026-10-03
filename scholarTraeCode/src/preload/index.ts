// Preload 桥接层：通过 contextBridge 把受控 IPC 能力暴露给渲染进程。
// 渲染进程使用 window.api.* 访问，禁止直接操作 Node API。
import { contextBridge, ipcRenderer } from 'electron'

// 文件系统操作的统一返回结构
type FsOpResult = { ok: boolean; path?: string; error?: string }

// 暴露给渲染进程的 API
const api = {
  // 当前操作系统平台（win32 / darwin / linux），用于标题栏控制按钮留白等平台差异
  platform: process.platform,

  // ---------- 文件系统 ----------
  fs: {
    selectWorkspace: (): Promise<string | null> =>
      ipcRenderer.invoke('fs:selectWorkspace'),
    // 校验路径是否存在且为目录（用于启动时恢复上次工作区）
    isDirectory: (path: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:isDirectory', path),
    // 系统「另存为」对话框，返回用户选择的完整路径（取消时 canceled: true）
    saveDialog: (defaultName?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean }> =>
      ipcRenderer.invoke('fs:saveDialog', defaultName),
    readDirTree: (root: string): Promise<unknown> =>
      ipcRenderer.invoke('fs:readDirTree', root),
    readFile: (path: string): Promise<string> =>
      ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:writeFile', path, content),
    // 在 parentDir 下新建文件（relName 支持相对子路径，如 src/a.ts）
    createFile: (parentDir: string, relName: string): Promise<FsOpResult> =>
      ipcRenderer.invoke('fs:createFile', parentDir, relName),
    // 在 parentDir 下新建文件夹
    createDirectory: (parentDir: string, relName: string): Promise<FsOpResult> =>
      ipcRenderer.invoke('fs:createDirectory', parentDir, relName),
    // 重命名（newName 仅允许单段名称）
    rename: (oldPath: string, newName: string): Promise<FsOpResult> =>
      ipcRenderer.invoke('fs:rename', oldPath, newName),
    // 移入系统回收站
    trash: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:trash', path),
    // 在系统资源管理器中定位
    showItem: (path: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:showItem', path),
    // 拖拽移动：把 srcPath 移动到 destDir 下（保持原名），root 为工作区根
    move: (root: string, srcPath: string, destDir: string): Promise<FsOpResult> =>
      ipcRenderer.invoke('fs:move', root, srcPath, destDir)
  },

  // ---------- LSP ----------
  // 两种语言服务器二选一：'ts' = typescript-language-server；'vue' = Volar Take Over
  // （同时处理 .vue 与 TS 全家桶）
  lsp: {
    // 探测工作区是否含 .vue 源文件（渲染端据此选择默认服务器）
    detectVue: (root: string): Promise<boolean> =>
      ipcRenderer.invoke('lsp:detectVue', root),
    start: (
      kind: 'ts' | 'vue'
    ): Promise<{ ok: boolean; already?: boolean; tsdk?: string; error?: string }> =>
      ipcRenderer.invoke('lsp:start', kind),
    write: (kind: 'ts' | 'vue', msg: string): void =>
      ipcRenderer.send('lsp:write', kind, msg),
    onMessage: (cb: (kind: 'ts' | 'vue', msg: string) => void): void => {
      ipcRenderer.on('lsp:message', (_e, kind: 'ts' | 'vue', msg: string) => cb(kind, msg))
    },
    stop: (kind: 'ts' | 'vue'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('lsp:stop', kind)
  },

  // ---------- MCP ----------
  mcp: {
    listTools: (): Promise<{ server: string; tools: unknown[] }[]> =>
      ipcRenderer.invoke('mcp:listTools'),
    callTool: (
      server: string,
      name: string,
      args: Record<string, unknown>
    ): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
      ipcRenderer.invoke('mcp:callTool', server, name, args),
    // 工作区变化后调用：filesystem 服务器重启并把该目录加入允许列表（AI 才能读写用户项目）
    setWorkspaceRoot: (root: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:setWorkspaceRoot', root),
    // ---- MCP 服务器管理 UI ----
    listServers: (): Promise<unknown[]> =>
      ipcRenderer.invoke('mcp:listServers'),
    addServer: (name: string, config: unknown): Promise<unknown> =>
      ipcRenderer.invoke('mcp:addServer', name, config),
    updateServer: (name: string, config: unknown): Promise<unknown> =>
      ipcRenderer.invoke('mcp:updateServer', name, config),
    removeServer: (name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:removeServer', name),
    toggleServer: (name: string, enabled: boolean): Promise<unknown> =>
      ipcRenderer.invoke('mcp:toggleServer', name, enabled),
    restartServer: (name: string): Promise<unknown> =>
      ipcRenderer.invoke('mcp:restartServer', name)
  },

  // ---------- 规则管理（用户级 / 项目级 / 目录级三层） ----------
  rules: {
    list: (workspace?: string | null, currentDir?: string | null): Promise<unknown[]> =>
      ipcRenderer.invoke('rules:list', workspace, currentDir),
    read: (workspace: string | null, path: string): Promise<{ ok: boolean; data?: string; error?: string }> =>
      ipcRenderer.invoke('rules:read', workspace, path),
    write: (
      workspace: string | null,
      scope: 'user' | 'project' | 'directory',
      name: string,
      content: string,
      dirPath?: string | null
    ): Promise<{ ok: boolean; data?: string; error?: string }> =>
      ipcRenderer.invoke('rules:write', workspace, scope, name, content, dirPath),
    delete: (workspace: string | null, path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('rules:delete', workspace, path),
    // 项目级规则启停（状态存 .trae/rules/.state.json）
    toggle: (workspace: string | null, name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('rules:toggle', workspace, name, enabled)
  },

  // ---------- 技能管理（.trae/skills/*.md，frontmatter 存 enabled） ----------
  skills: {
    list: (workspace?: string | null): Promise<unknown[]> =>
      ipcRenderer.invoke('skills:list', workspace),
    read: (workspace: string | null, name: string): Promise<{ ok: boolean; data?: string; error?: string }> =>
      ipcRenderer.invoke('skills:read', workspace, name),
    write: (
      workspace: string | null,
      name: string,
      description: string,
      enabled: boolean,
      content: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('skills:write', workspace, name, description, enabled, content),
    delete: (workspace: string | null, name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('skills:delete', workspace, name),
    toggle: (workspace: string | null, name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('skills:toggle', workspace, name, enabled)
  },

  // ---------- 笔记管理（agent-notes.json 只读查看 + 清空备份） ----------
  notes: {
    load: (workspace?: string | null): Promise<unknown> =>
      ipcRenderer.invoke('notes:load', workspace),
    clear: (workspace: string | null): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('notes:clear', workspace)
  },

  // ---------- Git / 检查点 / 差异 ----------
  git: {
    isRepo: (root: string): Promise<boolean> => ipcRenderer.invoke('git:isRepo', root),
    init: (root: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:init', root),
    status: (root: string): Promise<{ ok: boolean; data?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('git:status', root),
    diffFile: (root: string, change: unknown): Promise<unknown> =>
      ipcRenderer.invoke('git:diffFile', root, change),
    checkpointCreate: (root: string, label: string): Promise<unknown> =>
      ipcRenderer.invoke('git:checkpointCreate', root, label),
    checkpointList: (root: string): Promise<unknown> =>
      ipcRenderer.invoke('git:checkpointList', root),
    checkpointRestore: (root: string, hash: string): Promise<unknown> =>
      ipcRenderer.invoke('git:checkpointRestore', root, hash),
    fileRestore: (root: string, change: unknown): Promise<unknown> =>
      ipcRenderer.invoke('git:fileRestore', root, change),

    // SCM 源代码管理面板
    statusGrouped: (root: string): Promise<unknown> =>
      ipcRenderer.invoke('git:statusGrouped', root),
    stage: (root: string, paths: string[]): Promise<unknown> =>
      ipcRenderer.invoke('git:stage', root, paths),
    unstage: (root: string, paths: string[]): Promise<unknown> =>
      ipcRenderer.invoke('git:unstage', root, paths),
    commit: (root: string, message: string): Promise<unknown> =>
      ipcRenderer.invoke('git:commit', root, message),
    branchList: (root: string): Promise<unknown> =>
      ipcRenderer.invoke('git:branchList', root),
    checkoutBranch: (root: string, name: string): Promise<unknown> =>
      ipcRenderer.invoke('git:checkoutBranch', root, name),
    createBranch: (root: string, name: string): Promise<unknown> =>
      ipcRenderer.invoke('git:createBranch', root, name)
  },

  // ---------- 全局搜索/替换（ripgrep 引擎 + 可预览批量替换） ----------
  search: {
    // 内容搜索；root 为工作区根，params 含查询串/选项/glob
    query: (root: string, params: unknown): Promise<unknown> =>
      ipcRenderer.invoke('search:query', root, params),
    // 替换预览：返回每文件匹配计数与变更行 before/after
    replacePreview: (root: string, params: unknown): Promise<unknown> =>
      ipcRenderer.invoke('search:replacePreview', root, params),
    // 应用替换：params.selections 携带勾选文件与预览时刻计数（落盘前复核）
    replaceApply: (root: string, params: unknown): Promise<unknown> =>
      ipcRenderer.invoke('search:replaceApply', root, params)
  },

  // ---------- 终端（持久 shell，用户手动输入与 AI 调用共用） ----------
  terminal: {
    // 启动/重启 shell；cwd 不传则使用当前工作目录
    start: (cwd?: string): Promise<{ ok: boolean; cwd: string }> =>
      ipcRenderer.invoke('terminal:start', cwd),
    // 用户在终端框输入并执行一条命令
    run: (command: string): Promise<unknown> =>
      ipcRenderer.invoke('terminal:run', command),
    // 获取当前 shell 工作目录
    cwd: (): Promise<string> => ipcRenderer.invoke('terminal:cwd'),
    // 订阅终端事件（就绪/命令行/输出/退出/提示）
    onEvent: (cb: (ev: unknown) => void): void => {
      ipcRenderer.on('terminal:event', (_e, ev) => cb(ev))
    },
    // 后台任务：启动（长驻命令，不占终端队列）/列表/终止/按偏移追读输出
    taskStart: (command: string, cwd?: string): Promise<unknown> =>
      ipcRenderer.invoke('task:start', { command, cwd }),
    taskList: (): Promise<unknown> => ipcRenderer.invoke('task:list'),
    taskKill: (id: string): Promise<unknown> => ipcRenderer.invoke('task:kill', id),
    taskTail: (id: string, offset?: number): Promise<unknown> =>
      ipcRenderer.invoke('task:tail', { id, offset }),
    onTaskEvent: (cb: (ev: unknown) => void): void => {
      ipcRenderer.on('task:event', (_e, ev) => cb(ev))
    },
    /** s45 修复提案事件：命令失败且有可执行修复动作时推送 */
    onRepairProposals: (cb: (p: unknown) => void): void => {
      ipcRenderer.on('terminal:repairProposals', (_e, p) => cb(p))
    },
    // ---- 真 PTY 终端（多会话；xterm.js 渲染） ----
    // 创建 PTY 会话；参数缺省走平台探测 shell（Windows pwsh 7 优先）
    ptyCreate: (input?: {
      cwd?: string
      shell?: { kind: string; command: string; args: string[] }
      origin?: 'user' | 'ai'
      cols?: number
      rows?: number
    }): Promise<{ ok: boolean; info?: unknown; error?: string }> =>
      ipcRenderer.invoke('terminal:ptyCreate', input ?? {}),
    // 用户按键写入指定会话
    ptyWrite: (id: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:ptyWrite', id, data),
    // 会话行列调整（FitAddon 实测尺寸）
    ptyResize: (id: string, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke('terminal:ptyResize', id, cols, rows),
    // 关闭会话（树杀 + 主进程清理）
    ptyKill: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:ptyKill', id),
    // 列出全部会话
    ptyList: (): Promise<unknown[]> => ipcRenderer.invoke('terminal:ptyList'),
    // 订阅 PTY 输出（按 id 路由）
    onPtyData: (cb: (payload: { id: string; data: string }) => void): void => {
      ipcRenderer.on('terminal:ptyData', (_e, payload) => cb(payload))
    },
    // 订阅 PTY 退出（会话保留供回看，用户关 Tab 才销毁）
    onPtyExit: (cb: (payload: { id: string; code: number | null }) => void): void => {
      ipcRenderer.on('terminal:ptyExit', (_e, payload) => cb(payload))
    }
  },

  // ---------- s45 修复动作执行/回滚（用户确认卡片后调用） ----------
  repair: {
    run: (workspace: string, command: string): Promise<unknown> =>
      ipcRenderer.invoke('repair:run', workspace, command),
    rollback: (workspace: string, hash: string): Promise<unknown> =>
      ipcRenderer.invoke('repair:rollback', workspace, hash)
  },

  // ---------- s46 自动回归结果事件 ----------
  test: {
    onAutoRun: (cb: (r: unknown) => void): void => {
      ipcRenderer.on('test:autoRun', (_e, r) => cb(r))
    }
  },

  // ---------- s47 一键打包流水线 ----------
  build: {
    start: (mode: 'dir' | 'dist'): Promise<unknown> =>
      ipcRenderer.invoke('build:start', mode),
    status: (): Promise<{ running: boolean }> => ipcRenderer.invoke('build:status'),
    openRelease: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('build:openRelease'),
    onLog: (cb: (p: { text: string }) => void): void => {
      ipcRenderer.on('build:log', (_e, p) => cb(p))
    },
    onDone: (cb: (r: unknown) => void): void => {
      ipcRenderer.on('build:done', (_e, r) => cb(r))
    }
  },

  // ---------- Ollama（健康检测，供状态灯使用；聊天走统一调度层） ----------
  ollama: {
    health: (): Promise<{ ok: boolean; version?: string; error?: string }> =>
      ipcRenderer.invoke('ollama:health')
  },

  // ---------- 调试（Node.js，CDP） ----------
  debug: {
    start: (cfg: { kind: 'launch'; entry: string; port?: number } | { kind: 'attach'; port: number; host?: string }): Promise<unknown> =>
      ipcRenderer.invoke('debug:start', cfg),
    stop: (): Promise<unknown> => ipcRenderer.invoke('debug:stop'),
    setBreakpoints: (file: string, lines: number[]): Promise<unknown> =>
      ipcRenderer.invoke('debug:setBreakpoints', { file, lines }),
    control: (action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'): Promise<unknown> =>
      ipcRenderer.invoke('debug:control', { action }),
    state: (): Promise<unknown> => ipcRenderer.invoke('debug:state'),
    onEvent: (cb: (ev: unknown) => void): void => {
      ipcRenderer.on('debug:event', (_e, ev) => cb(ev))
    }
  },

  // ---------- 3.3 通用 DAP（Python debugpy / Go dlv） ----------
  dap: {
    start: (cfg: unknown): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('dap:start', cfg),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dap:stop'),
    setBreakpoints: (file: string, lines: number[]): Promise<unknown> =>
      ipcRenderer.invoke('dap:setBreakpoints', { file, lines }),
    control: (action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'): Promise<unknown> =>
      ipcRenderer.invoke('dap:control', { action }),
    state: (): Promise<unknown> => ipcRenderer.invoke('dap:state'),
    evaluate: (expression: string): Promise<{ ok: boolean; result?: string; error?: string }> =>
      ipcRenderer.invoke('dap:evaluate', expression)
  },

  // ---------- 验证锁（manifest 编辑与手动触发） ----------
  validation: {
    // 单条规则执行（rule + ctx 快照 → 结果）
    runRule: (
      rule: unknown,
      ctx?: { createdFiles?: string[]; executedCommands?: Record<string, string>; workspace?: string } | null
    ): Promise<unknown> => ipcRenderer.invoke('validation:runRule', rule, ctx ?? null),
    // 整 manifest 执行（manifest + ctx 快照 → summary）
    runValidation: (
      manifest: unknown,
      ctx?: { createdFiles?: string[]; executedCommands?: Record<string, string>; workspace?: string } | null
    ): Promise<unknown> => ipcRenderer.invoke('validation:runValidation', manifest, ctx ?? null),
    // 解析文本/对象为 manifest（不合法返回 null）
    parseManifest: (raw: unknown): Promise<unknown> => ipcRenderer.invoke('validation:parseManifest', raw),
    // 格式化 summary 为强制继续消息（allPassed 时返回 null）
    formatMessage: (
      summary: unknown,
      ctx?: { createdFiles?: string[]; executedCommands?: Record<string, string>; workspace?: string } | null
    ): Promise<string | null> => ipcRenderer.invoke('validation:formatMessage', summary, ctx ?? null),
    // 取当前会话 manifest + ctx 快照（任务未运行时 ctx 为 null）
    getCurrent: (): Promise<{ manifest: unknown; ctx: unknown }> =>
      ipcRenderer.invoke('validation:getCurrent'),
    // 前端编辑后写回 manifest（影响下一次收尾校验）
    setCurrent: (manifest: unknown): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('validation:setCurrent', manifest)
  },

  // ---------- 插件系统 ----------
  plugin: {
    list: (): Promise<Array<{
      id: string
      name: string
      version: string
      description?: string
      author?: string
      enabled: boolean
      providerCount: number
      mcpServerCount: number
      commandCount: number
      dir: string
    }>> => ipcRenderer.invoke('plugin:list'),
    setEnabled: (pluginId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('plugin:setEnabled', pluginId, enabled),
    getMcpServers: (): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('plugin:getMcpServers'),
    getCommands: (): Promise<Array<{ pluginId: string; pluginName: string; id: string; title: string; keybinding?: string; icon?: string }>> =>
      ipcRenderer.invoke('plugin:getCommands'),
    reload: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('plugin:reload')
  },

  // ---------- 自动更新（electron-updater） ----------
  updater: {
    getStatus: (): Promise<{ version: string; isPackaged: boolean }> =>
      ipcRenderer.invoke('updater:getStatus'),
    check: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('updater:check'),
    download: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('updater:download'),
    install: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('updater:install'),
    onChecking: (cb: () => void): void => {
      ipcRenderer.on('updater:checking', () => cb())
    },
    onAvailable: (cb: (info: { version: string; releaseNotes?: unknown }) => void): void => {
      ipcRenderer.on('updater:available', (_e, info) => cb(info))
    },
    onNotAvailable: (cb: (info: { version: string }) => void): void => {
      ipcRenderer.on('updater:not-available', (_e, info) => cb(info))
    },
    onDownloading: (cb: (p: { percent: number; bytesPerSecond: number; total: number; transferred: number }) => void): void => {
      ipcRenderer.on('updater:downloading', (_e, p) => cb(p))
    },
    onDownloaded: (cb: (info: { version: string }) => void): void => {
      ipcRenderer.on('updater:downloaded', (_e, info) => cb(info))
    },
    onError: (cb: (e: { message: string }) => void): void => {
      ipcRenderer.on('updater:error', (_e, e) => cb(e))
    }
  },

  // ---------- 主题（同步到原生窗口） ----------
  theme: {
    apply: (theme: 'light' | 'dark' | 'blue'): void =>
      ipcRenderer.send('theme:apply', theme)
  },

  // ---------- AI 统一调度层（多供应商 / 自动路由 / 超时回退 / 上下文工程） ----------
  ai: {
    // ---- 供应商与模型 ----
    listProviders: (): Promise<
      { id: string; name: string; enabled: boolean; ok: boolean; version?: string; error?: string }[]
    > => ipcRenderer.invoke('ai:listProviders'),
    listModels: (): Promise<unknown[]> => ipcRenderer.invoke('ai:listModels'),
    refreshModels: (): Promise<unknown[]> => ipcRenderer.invoke('ai:refreshModels'),
    setProviderEnabled: (providerId: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('ai:setProviderEnabled', providerId, enabled),
    // ---- 模型管理（设置页） ----
    getProviderSettings: (): Promise<unknown[]> => ipcRenderer.invoke('ai:getProviderSettings'),
    setProviderKey: (providerId: string, key: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:setProviderKey', providerId, key),
    addCustomProvider: (def: {
      name: string
      baseUrl: string
    }): Promise<{ ok: boolean; provider?: unknown; error?: string }> =>
      ipcRenderer.invoke('ai:addCustomProvider', def),
    removeCustomProvider: (providerId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:removeCustomProvider', providerId),
    testProvider: (providerId: string): Promise<{ ok: boolean; version?: string; error?: string }> =>
      ipcRenderer.invoke('ai:testProvider', providerId),
    getUsageStats: (): Promise<unknown> => ipcRenderer.invoke('ai:getUsageStats'),
    resetUsageStats: (): Promise<boolean> => ipcRenderer.invoke('ai:resetUsageStats'),
    // ---- 统一聊天调度 ----
    chatStream: (params: {
      model?: string
      messages: any[]
      taskType?: string
      currentFile?: string | null
      workspace?: string | null
      useTools?: boolean
      timeoutMs?: number
    }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('ai:chatStream', params),
    chatWithTools: (params: {
      model?: string
      messages: any[]
      taskType?: string
      currentFile?: string | null
      workspace?: string | null
      timeoutMs?: number
    }): Promise<{ ok: boolean; content?: string; error?: string; model?: string }> =>
      ipcRenderer.invoke('ai:chatWithTools', params),
    // 停止当前 AI 任务（主循环 + 子代理级联中止）
    stopChat: (): Promise<{ ok: boolean; stopped?: boolean }> =>
      ipcRenderer.invoke('ai:stopChat'),
    // ---- ㊜ 断点续跑：恢复列表 / 继续 / 放弃（放弃时可选回滚任务前检查点）----
    listRecoverableTasks: (workspace: string) =>
      ipcRenderer.invoke('ai:listRecoverableTasks', workspace),
    resumeTask: (workspace: string, taskId: string): Promise<{
      ok: boolean
      content?: string
      error?: string
      model?: string
      blocked?: boolean
    }> => ipcRenderer.invoke('ai:resumeTask', workspace, taskId),
    abandonTask: (
      workspace: string,
      taskId: string,
      rollback: boolean
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:abandonTask', workspace, taskId, rollback),
    // ---- ㊜ 1b 运行门：暂停 / 继续 / 放弃（放弃时可选回滚任务前检查点）----
    pauseTask: (): Promise<{ ok: boolean; phase: string }> =>
      ipcRenderer.invoke('ai:pauseTask'),
    resumePausedTask: (): Promise<{ ok: boolean; phase: string }> =>
      ipcRenderer.invoke('ai:resumePausedTask'),
    abortRunningTask: (
      workspace: string | null,
      taskId: string,
      rollback: boolean
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:abortRunningTask', workspace, taskId, rollback),
    // s48 从此步重跑：指定任务与轮次，走快照恢复链路
    rerunFromStep: (
      workspace: string,
      taskId: string,
      round: number
    ): Promise<{ ok: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke('ai:rerunFromStep', workspace, taskId, round),
    // s49 单卡片回滚：中止运行 + 恢复任务前检查点（保留快照）
    rollbackCard: (
      workspace: string,
      taskId: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:rollbackCard', workspace, taskId),
    // s50 看板卡片 → 角色 Agent 编排
    dispatchFromCards: (
      workspace: string,
      cards: Array<{ sid: string; title: string; role?: string }>
    ): Promise<{ ok: boolean; report?: string; error?: string }> =>
      ipcRenderer.invoke('ai:dispatchFromCards', workspace, cards),
    // ---- 内联 AI（Tab 补全 / Cmd+K 改写）----
    // 与 ai:chatStream 隔离的事件通道，requestId 用于过滤并发请求
    inlineStream: (params: {
      requestId: string
      model?: string
      messages: any[]
      taskType?: string
      currentFile?: string | null
      workspace?: string | null
      timeoutMs?: number
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:inlineStream', params),
    stopInline: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('ai:stopInline'),
    // ---- 代码库索引与检索 ----
    // 模型可见工具清单（内置 + 已连接 MCP）
    listTools: (): Promise<Array<{ server: string; name: string; description: string }>> =>
      ipcRenderer.invoke('ai:listTools'),
    indexStatus: (root: string): Promise<{ files: number; updatedAt: string | null; scanning: boolean }> =>
      ipcRenderer.invoke('ai:indexStatus', root),
    ensureIndex: (root: string, force = false): Promise<{
      ok: boolean
      total?: number; added?: number; updated?: number; removed?: number
      truncated?: boolean; throttled?: boolean; error?: string
    }> => ipcRenderer.invoke('ai:ensureIndex', root, force),
    searchIndex: (params: { root: string; query: string; limit?: number }): Promise<Array<{
      relPath: string; score: number; symbol?: string; symbolLine?: number
    }>> => ipcRenderer.invoke('ai:searchIndex', params),
    getContext: (params: {
      root: string
      query: string
      currentFile?: string | null
      maxChars?: number
    }): Promise<string> => ipcRenderer.invoke('ai:getContext', params),
    // ---- 持久化笔记（跨会话知识记忆） ----
    loadNotes: (workspace: string): Promise<unknown> =>
      ipcRenderer.invoke('ai:loadNotes', workspace),
    saveNotes: (workspace: string, note: unknown): Promise<boolean> =>
      ipcRenderer.invoke('ai:saveNotes', workspace, note),
    // ---- 聊天会话持久化（多会话/按工作区隔离） ----
    listSessions: (workspace: string | null): Promise<unknown[]> =>
      ipcRenderer.invoke('ai:listSessions', workspace),
    loadSession: (workspace: string | null, id: string): Promise<unknown> =>
      ipcRenderer.invoke('ai:loadSession', workspace, id),
    saveSession: (
      workspace: string | null,
      data: { id?: string; title?: string; createdAt?: number; messages: unknown[] }
    ): Promise<{ ok: boolean; id: string | null }> =>
      ipcRenderer.invoke('ai:saveSession', workspace, data),
    deleteSession: (workspace: string | null, id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('ai:deleteSession', workspace, id),
    sessionToMarkdown: (workspace: string | null, id: string): Promise<string> =>
      ipcRenderer.invoke('ai:sessionToMarkdown', workspace, id),
    // ---- 2.3 图片附件：落盘（返回路径）/ 读取（返回 data URL）----
    saveAttachment: (input: {
      workspace: string
      mimeType: string
      /** base64，不含 data: 前缀 */
      data: string
    }): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('ai:saveAttachment', input),
    readAttachment: (
      path: string,
      workspace?: string
    ): Promise<{ ok: boolean; dataUrl?: string; error?: string }> =>
      ipcRenderer.invoke('ai:readAttachment', path, workspace),
    // ---- Agent 执行轨迹（录制回放） ----
    listTraces: (): Promise<Array<{
      file: string
      taskId: string
      startTime: string
      model: string
      status: 'running' | 'completed' | 'aborted' | 'error'
      rounds: number
    }>> => ipcRenderer.invoke('trace:list'),
    loadTrace: (file: string): Promise<any> =>
      ipcRenderer.invoke('trace:load', file),
    // ---- 事件订阅 ----
    onChatChunk: (cb: (chunk: string) => void): void => {
      ipcRenderer.on('ai:chatChunk', (_e, chunk: string) => cb(chunk))
    },
    onChatDone: (cb: (info: { model: string }) => void): void => {
      ipcRenderer.on('ai:chatDone', (_e, info) => cb(info))
    },
    onChatError: (cb: (err: string) => void): void => {
      ipcRenderer.on('ai:chatError', (_e, err: string) => cb(err))
    },
    onChatFallback: (cb: (p: { from: string; to: string; reason: string }) => void): void => {
      ipcRenderer.on('ai:chatFallback', (_e, payload) => cb(payload))
    },
    // ---- 内联 AI 事件（Tab 补全 / Cmd+K 改写）----
    // 与 chatStream 隔离的事件通道，所有 payload 携带 requestId 供渲染端过滤
    // 返回 unsubscribe 函数：provider/widget 卸载时清理监听，避免泄漏
    onInlineChunk: (cb: (p: { requestId: string; delta: string }) => void): (() => void) => {
      const handler = (_e: unknown, payload: { requestId: string; delta: string }): void => cb(payload)
      ipcRenderer.on('ai:inlineChunk', handler)
      return () => ipcRenderer.removeListener('ai:inlineChunk', handler as any)
    },
    onInlineDone: (cb: (p: { requestId: string; model: string }) => void): (() => void) => {
      const handler = (_e: unknown, payload: { requestId: string; model: string }): void => cb(payload)
      ipcRenderer.on('ai:inlineDone', handler)
      return () => ipcRenderer.removeListener('ai:inlineDone', handler as any)
    },
    onInlineError: (cb: (p: { requestId: string; err: string }) => void): (() => void) => {
      const handler = (_e: unknown, payload: { requestId: string; err: string }): void => cb(payload)
      ipcRenderer.on('ai:inlineError', handler)
      return () => ipcRenderer.removeListener('ai:inlineError', handler as any)
    },
    onInlineFallback: (
      cb: (p: { requestId: string; from: string; to: string; reason: string }) => void
    ): (() => void) => {
      const handler = (
        _e: unknown,
        payload: { requestId: string; from: string; to: string; reason: string }
      ): void => cb(payload)
      ipcRenderer.on('ai:inlineFallback', handler)
      return () => ipcRenderer.removeListener('ai:inlineFallback', handler as any)
    },
    onToolCall: (cb: (payload: { name: string; args: Record<string, unknown> }) => void): void => {
      ipcRenderer.on('ai:toolCall', (_e, payload) => cb(payload))
    },
    onToolResult: (cb: (payload: { name: string; result: string }) => void): void => {
      ipcRenderer.on('ai:toolResult', (_e, payload) => cb(payload))
    },
    onModelCall: (cb: (payload: { model: string; phase: string }) => void): void => {
      ipcRenderer.on('ai:modelCall', (_e, payload) => cb(payload))
    },
    // TODO 子任务清单更新（Agent 自主任务规划，前端渲染清单项）
    onTodoUpdate: (cb: (todos: unknown[]) => void): void => {
      ipcRenderer.on('ai:todoUpdate', (_e, todos) => cb(todos))
    },
    // 子代理编排进度（并行派发/轮次/完成）
    onSubagentUpdate: (
      cb: (p: { current: number; total: number; phase: string; detail: string }) => void
    ): void => {
      ipcRenderer.on('ai:subagentUpdate', (_e, payload) => cb(payload))
    },
    // 任务收尾：计划-执行偏差报告（仅当前会话实时有效）
    onPlanDrift: (cb: (report: unknown) => void): void => {
      ipcRenderer.on('ai:planDrift', (_e, report) => cb(report))
    },
    // ㊜ 1b 运行门相位：started/pausing/paused/running（维护 live 任务态）
    onTaskControl: (
      cb: (payload: {
        taskId: string
        phase: 'started' | 'pausing' | 'paused' | 'running'
        preTaskCheckpoint?: { hash: string; label: string } | null
      }) => void
    ): void => {
      ipcRenderer.on('ai:taskControl', (_e, payload) => cb(payload))
    },
    // s48 执行时间线广播（步骤开始/回填后全量推送）
    onTimelineUpdate: (cb: (payload: unknown) => void): void => {
      ipcRenderer.on('ai:timelineUpdate', (_e, payload) => cb(payload))
    },
    // ---- 工具权限模式与审批 ----
    getPermissionMode: (): Promise<'readonly' | 'ask' | 'auto'> =>
      ipcRenderer.invoke('ai:getPermissionMode'),
    setPermissionMode: (mode: 'readonly' | 'ask' | 'auto'): Promise<boolean> =>
      ipcRenderer.invoke('ai:setPermissionMode', mode),
    onPermissionRequest: (
      cb: (req: {
        id: string
        tool: string
        target: string
        reason: string
        danger?: boolean
      }) => void
    ): void => {
      ipcRenderer.on('ai:permissionRequest', (_e, payload) => cb(payload))
    },
    respondPermission: (
      id: string,
      response: { decision: 'allow_once' | 'allow_always' | 'deny'; reason?: string }
    ): Promise<boolean> => ipcRenderer.invoke('ai:permissionResponse', id, response),
    // ㊝ bash 批量接受门弹层（payload 含门 id 与暂存摘要；应答走 api.staging.bashAcceptResponse）
    onBashAcceptRequest: (
      cb: (payload: {
        id: string
        summary: {
          total: number
          counts: { create: number; modify: number; delete: number; move: number }
          items: { path: string; kind: 'create' | 'modify' | 'delete' | 'move'; oldPath?: string | null }[]
        }
      }) => void
    ): void => {
      ipcRenderer.on('ai:bashAcceptRequest', (_e, payload) => cb(payload))
    }
  },
  // ===== ㊝ 变更事务暂存：AI 文件改动先入暂存，用户审阅接受后才落盘 =====
  staging: {
    /** 暂存摘要（列表与徽标计数）；返回 {enabled, summary} 包络 */
    get: (
      workspace: string
    ): Promise<{
      enabled: boolean
      summary: {
        total: number
        counts: { create: number; modify: number; delete: number; move: number }
        items: { path: string; kind: 'create' | 'modify' | 'delete' | 'move'; oldPath?: string | null }[]
      }
    }> => ipcRenderer.invoke('staging:get', workspace),
    /** 单文件 diff（Monaco DiffEditor 数据源） */
    diff: (
      workspace: string,
      path: string
    ): Promise<{
      original: string
      modified: string
      title: string
      hunks: Array<{
        id: string
        oldStart: number
        oldLines: number
        newStart: number
        newLines: number
        lines: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }>
        tailNewline?: boolean
      }>
    }> => ipcRenderer.invoke('staging:diff', workspace, path),
    /** 接受：paths 为相对路径数组或 'all'；hunkIds 可选（键=相对路径，值=hunk id）。
     *  冲突时整批不落盘，ok=false；partial=true 表示有逐 hunk 部分接受 */
    accept: (
      workspace: string,
      paths: string[] | 'all',
      hunkIds?: Record<string, string[]>
    ): Promise<{ ok: boolean; applied?: number; partial?: boolean; error?: string }> =>
      ipcRenderer.invoke('staging:accept', workspace, paths, hunkIds),
    /** 拒绝（丢弃）选中或全部暂存记录；hunkIds 可选以逐 hunk 丢弃 */
    reject: (
      workspace: string,
      paths: string[] | 'all',
      hunkIds?: Record<string, string[]>
    ): Promise<{ ok: boolean; dropped?: number; error?: string }> =>
      ipcRenderer.invoke('staging:reject', workspace, paths, hunkIds),
    /** s44 三档分类：路径 → { cls: direct/incidental/risky, reason } */
    classify: (
      workspace: string
    ): Promise<Record<string, { cls: 'direct' | 'incidental' | 'risky'; reason: string }>> =>
      ipcRenderer.invoke('staging:classify', workspace),
    getEnabled: (workspace: string): Promise<boolean> =>
      ipcRenderer.invoke('staging:getEnabled', workspace),
    setEnabled: (workspace: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('staging:setEnabled', workspace, enabled),
    /** bash 门应答：accept 时内部先把全部暂存落盘再放行 */
    bashAcceptResponse: (
      workspace: string,
      id: string,
      decision: 'accept' | 'reject'
    ): Promise<{ ok: boolean; released: boolean }> =>
      ipcRenderer.invoke('staging:bashAcceptResponse', workspace, id, decision),
    /** 暂存变化（staging 模块与 ai 事件桥两个来源都订阅，避免漏刷新） */
    onChanged: (cb: () => void): void => {
      ipcRenderer.on('staging:changed', () => cb())
      ipcRenderer.on('ai:stagingChanged', () => cb())
    }
  },

  // ===== s49 卡片式任务看板持久化 =====
  kanban: {
    get: (workspace: string): Promise<unknown> =>
      ipcRenderer.invoke('kanban:get', workspace),
    save: (workspace: string, cards: unknown): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('kanban:save', workspace, cards),
    reset: (workspace: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('kanban:reset', workspace)
  },

  // ===== s54–s56 学术/报告链路 =====
  scholar: {
    /** 读数据文件(CSV/JSON) → 渲染 SVG → 落盘 .trae/charts */
    renderChart: (
      workspace: string,
      dataFile: string,
      spec: unknown
    ): Promise<{
      ok: boolean
      path?: string
      relPath?: string
      rowCount?: number
      columns?: string[]
      error?: string
    }> => ipcRenderer.invoke('scholar:renderChart', workspace, dataFile, spec),
    /** SVG 字符串直接落盘 */
    saveChart: (
      workspace: string,
      title: string,
      svg: string
    ): Promise<{ ok: boolean; path?: string; relPath?: string; error?: string }> =>
      ipcRenderer.invoke('scholar:saveChart', workspace, title, svg),
    /** 导出报告 md/tex/doc */
    exportReport: (
      workspace: string,
      input: unknown,
      format: 'markdown' | 'latex' | 'doc'
    ): Promise<{ ok: boolean; path?: string; relPath?: string; error?: string }> =>
      ipcRenderer.invoke('scholar:exportReport', workspace, input, format),
    /** 读取文献库 .trae/references.bib */
    readBib: (workspace: string): Promise<{
      ok: boolean
      entries?: Array<{ type: string; key: string; fields: Record<string, string> }>
      text?: string
      error?: string
    }> => ipcRenderer.invoke('scholar:readBib', workspace),
    /** 保存文献库 */
    saveBib: (
      workspace: string,
      entries: unknown
    ): Promise<{ ok: boolean; path?: string; count?: number; error?: string }> =>
      ipcRenderer.invoke('scholar:saveBib', workspace, entries)
  },

  // ===== 3.1 内置浏览器预览（WebContentsView 嵌入主窗口） =====
  preview: {
    /** 打开/复用预览视图并加载 URL；bounds 为 CSS 像素相对窗口 content 区 */
    open: (url: string, bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('preview:open', url, bounds),
    /** 容器尺寸/位置变化后上报新 bounds（ResizeObserver 触发） */
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('preview:setBounds', bounds),
    /** 切走 Tab/折叠面板时临时隐藏（不销毁 webContents） */
    hide: () => ipcRenderer.invoke('preview:hide'),
    /** 导航控制：reload/back/forward/openDevTools/stop/close */
    control: (action: 'reload' | 'back' | 'forward' | 'openDevTools' | 'stop' | 'close') =>
      ipcRenderer.invoke('preview:control', action),
    /** 探活 localhost 候选端口；命中返回首个可用 URL */
    probeDevServer: (ports?: number[]) =>
      ipcRenderer.invoke('preview:probeDevServer', ports),
    /** 当前预览状态（是否打开 + URL） */
    isOpen: (): Promise<{ ok: boolean; open: boolean; url: string | null }> =>
      ipcRenderer.invoke('preview:isOpen'),
    /** 销毁预览视图 */
    close: () => ipcRenderer.invoke('preview:close'),
    /** 预览页导航后更新地址栏/前进后退按钮 */
    onNavigated: (cb: (url: string) => void): void => {
      ipcRenderer.on('preview:navigated', (_e, url: string) => cb(url))
    },
    /** 加载开始/结束（地址栏 loading 指示） */
    onLoading: (cb: (loading: boolean) => void): void => {
      ipcRenderer.on('preview:loading', (_e, loading: boolean) => cb(loading))
    },
    /** 加载失败（地址栏错误提示） */
    onLoadError: (cb: (error: string) => void): void => {
      ipcRenderer.on('preview:loadError', (_e, error: string) => cb(error))
    },
    // ---- 3.2 元素选择 ----
    /** 进入选择模式：注入脚本到预览页（悬停高亮 + 点击采集 + Escape 退出） */
    enterPickMode: () => ipcRenderer.invoke('preview:enterPickMode'),
    /** 退出选择模式 */
    exitPickMode: () => ipcRenderer.invoke('preview:exitPickMode'),
    /** 按元素 bounds 截图 */
    captureElement: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('preview:captureElement', bounds),
    /** 元素被选中后回调（含选择器/HTML/bounds/tagName/text） */
    onPicked: (cb: (data: { selector: string; outerHTML: string; bounds: { x: number; y: number; width: number; height: number }; tagName: string; text: string }) => void): void => {
      ipcRenderer.on('preview:picked', (_e, data) => cb(data))
    }
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
