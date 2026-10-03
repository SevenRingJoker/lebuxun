// 通用命令门控纯函数层（零 IO、数据驱动）。
//
// 把原 preflightBash 的硬编码脚手架正则 + npm 顺序锁，重构为三层数据表驱动：
//   1. 交互式/阻塞型命令特征识别 → verdict 'interactive'（经用户审批后走真 PTY）
//   2. 系统级破坏命令 → verdict 'deny'（永久拒绝，不走审批，AI 禁止操作）
//   3. 项目画像（ProjectProfile）驱动的顺序锁：checkCommandOrder 通用函数替代写死的
//      npm 分支；非 node 生态依赖图谱由 MANIFEST_GATE_PROFILES 派生（基于 ctx.createdFiles）
//
// 零 IO：依赖检查只看 ctx.createdFiles（已由 write 工具登记），不直接读盘，
// 保证纯函数可单测。调度器的 preflightBash 变薄壳委托本模块的 gateBashCommand。
import {
  NODE_GATE_PROFILE,
  MANIFEST_GATE_PROFILES,
  type ProjectProfile
} from '../../shared/projectProfiles'

/**
 * 门控判定：
 * - deny：永久拒绝（破坏命令/依赖顺序锁），不执行；
 * - interactive：交互式命令需用户审批，批准后在真 PTY 中启动；
 * - null：放行。
 */
export type BashGateVerdict =
  | { kind: 'deny'; message: string }
  | { kind: 'interactive'; message: string }
  | null

/** 门控上下文：调度器传入的当前执行状态 */
export interface BashGateContext {
  /** 是否为项目创建请求（决定是否启用依赖图谱与顺序锁） */
  isProjectCreation: boolean
  /** 已创建文件集合（write 工具登记的相对/绝对路径） */
  createdFiles: Set<string>
  /** 是否已成功执行 npm install */
  ranNpmInstall: boolean
  /** 是否已成功启动 dev server */
  ranServe: boolean
  /**
   * 磁盘/产物中 package.json 是否存在（调度器对工作目录做 existsSync 探测后显式传入）。
   * - false：任何场景下 npm install（npm init 除外）一律拦截——硬锁，不依赖 isProjectCreation；
   * - true：package.json 前置视为满足；
   * - undefined：未做磁盘探测（纯薄壳/测试/重规划过滤），回退「仅项目创建场景查 createdFiles」旧行为。
   */
  packageJsonExists?: boolean
  /**
   * 磁盘上 node_modules 是否存在（调度器探测后显式传入）。
   * - false 且未成功 install：任何场景下 npm run <script> 一律拦截；
   * - undefined：回退旧行为（仅项目创建场景按 ranNpmInstall 拦 serve/dev/start）。
   */
  nodeModulesExists?: boolean
  /**
   * package.json 内容级校验（调度器读盘后显式传入）：
   * - false：文件存在但无 dependencies/devDependencies（npm init -y 空壳）→ npm install 硬拦；
   * - true/undefined：有效或未探测（不拦）。
   */
  packageJsonHasContent?: boolean
}

/** 命中即拦截的规则 */
interface GateRule {
  /** 匹配正则（大小写不敏感由调用方保证或正则自带 i） */
  re: RegExp
  /** 拦截理由（返回给 AI 的错误文本） */
  reason: string
}

// ============ 1. 交互式/阻塞型命令特征（→ interactive，审批后走真 PTY） ============
// 这些命令需要键盘交互（选择 preset/确认覆盖/输入密码），管道 shell 会永久卡死；
// 真 PTY 中可由用户继续输入。
const INTERACTIVE_RULES: GateRule[] = [
  {
    re: /\bvue\s+create\b|@vue\/cli(\s+create)?\b|create-react-app\b|create-nuxt-app\b|create-next-app\b|create-svelte\b/i,
    reason: '交互式脚手架命令（vue create / create-react-app / create-nuxt-app 等）需要键盘选择 preset，仅能在真终端中运行。批准后将在内置 PTY 终端启动，用户可继续交互；也可改用 write 工具逐个写入文件。'
  },
  {
    // npm create / npm init 任意包（紧跟 token 不是 -y/--yes，-y 表示非交互初始化应放行）
    re: /\bnpm\s+(create|init)\s+(?!-y\b)(?!--yes\b)\S+/i,
    reason: 'npm create/init 脚手架命令需要交互式 preset 选择，仅能在真终端中运行。批准后将在内置 PTY 终端启动。'
  },
  {
    re: /\b(yarn|pnpm)\s+create\s+\S+/i,
    reason: 'yarn/pnpm create 脚手架命令需要交互式选择，仅能在真终端中运行。批准后将在内置 PTY 终端启动。'
  },
  {
    re: /\bdjango-admin\s+startproject\b|\brails\s+new\b|\bcomposer\s+create-project\b/i,
    reason: '该脚手架命令需要交互确认且会覆盖目录，仅能在真终端中运行。批准后将在内置 PTY 终端启动。'
  },
  {
    // apt install 不带 -y 会进入交互确认
    re: /\bapt(-get)?\s+install\b(?!.*\s-y\b)(?!.*\s--yes\b)/i,
    reason: 'apt install 缺少 -y 参数会进入交互确认，仅能在真终端中运行。批准后将在内置 PTY 终端启动，或添加 -y 后重试。'
  },
  {
    // git commit 不带 -m/-F 会打开编辑器
    re: /\bgit\s+commit\b(?!.*\s-m\b)(?!.*\s--message\b)(?!.*\s-F\b)(?!.*\s--file\b)/i,
    reason: 'git commit 缺少 -m 参数会打开编辑器，仅能在真终端中运行。批准后将在内置 PTY 终端启动，或使用 git commit -m "<消息>"。'
  }
]

// ============ 2. 系统级破坏命令（永久拒绝，不走审批，AI 禁止操作） ============
// 这些命令可能造成不可逆的系统破坏，AI 一律禁止执行，提示用户手动操作。
const DESTRUCTIVE_RULES: GateRule[] = [
  {
    re: /(^|\s)sudo\b/i,
    reason: '禁止执行 sudo 提权命令——AI 不应获取系统管理员权限。如需管理员操作，请用户手动执行。'
  },
  {
    // rm -rf 指向根路径/用户主目录/通配根（不可逆删除）
    re: /\brm\s+-[rf]*rf\b\s+(\/|~|\*|\/root|\/etc|\/usr|\/bin|\/sbin|\/boot|\/var|C:\\Windows|C:\\Program\s*Files)/i,
    reason: '禁止执行 rm -rf 删除系统根目录/用户主目录/通配路径——不可逆破坏。如需清理，请用户手动确认范围后操作。'
  },
  {
    re: /\bmkfs\b|\bdd\s+if=/i,
    reason: '禁止执行磁盘格式化/直接写盘命令（mkfs/dd if=）——不可逆破坏。请用户手动操作。'
  },
  {
    re: /\bsystemctl\s+(disable|stop|mask|reboot|poweroff)\b/i,
    reason: '禁止执行 systemctl 禁用/停止关键服务或关机命令——可能导致系统不可用。请用户手动操作。'
  },
  {
    re: /\b(iptables|firewall-cmd|ufw\s+(disable|reset))\b/i,
    reason: '禁止执行防火墙规则修改命令——可能切断网络连接。请用户手动操作。'
  },
  {
    re: /\b(shutdown|reboot|halt|poweroff)\b/i,
    reason: '禁止执行关机/重启命令。请用户手动操作。'
  },
  {
    re: /\breg\s+delete\s+HKLM|\bformat\s+\w:|\bdiskpart\b/i,
    reason: '禁止执行注册表删除/磁盘格式化/diskpart 命令——不可逆破坏。请用户手动操作。'
  },
  {
    // chmod -R 777 系统路径（破坏权限体系）
    re: /\bchmod\s+-R\s+777\b\s+(\/etc|\/usr|\/bin|\/sbin|\/boot|\/var|\/root|C:\\Windows)/i,
    reason: '禁止对系统路径执行 chmod -R 777——破坏系统权限体系。请用户手动操作。'
  }
]

// ============ 3. 项目画像驱动的通用顺序锁 ============
// checkCommandOrder 接收 ProjectProfile：任何生态的前置校验逻辑统一为
// 「init 命令要求 manifest 已创建；run 命令要求依赖已就绪」，不再有 if (isVue) 式硬编码。

/** checkCommandOrder 的判定输入（磁盘探测结果由调度器显式传入，保持本层零 IO） */
export interface CommandOrderOptions {
  /**
   * 磁盘/产物中 manifest 是否存在：
   * - false：任何场景下 init 命令一律拦截——硬锁；
   * - true：manifest 前置视为满足；
   * - undefined：未做磁盘探测，回退「仅项目创建场景查 createdFiles」。
   */
  manifestOnDisk?: boolean
  /**
   * manifest 内容是否有效（调度器读盘后显式传入，保持本层零 IO）：
   * - false：文件存在但内容无效（npm init -y 空壳 / 空 requirements.txt）→ init 命令硬拦；
   * - true/undefined：内容有效或未做内容探测（不拦）。
   */
  manifestHasContent?: boolean
  /** 磁盘上依赖目录（node_modules/venv）是否存在（语义同 manifestOnDisk） */
  depsOnDisk?: boolean
  /** 是否已成功执行依赖安装命令 */
  ranInit: boolean
  /** 是否为项目创建请求 */
  isProjectCreation: boolean
}

/**
 * 通用命令顺序锁：返回拦截文案；放行返回 null。
 * @param cmd 完整命令行
 * @param profile 当前项目画像（含命令匹配器与拦截文案）
 * @param createdFiles 已创建文件集合（write 工具登记）
 */
export function checkCommandOrder(
  cmd: string,
  profile: ProjectProfile,
  createdFiles: Set<string>,
  opts: CommandOrderOptions
): string | null {
  const command = (cmd || '').trim()
  if (!command) return null
  const cmdHead = command.split(/\s*[;&|]/)[0].trim()

  // ① 依赖安装命令：manifest 必须已创建且内容有效（磁盘探测优先，其次 createdFiles）
  if (profile.dependencyManifest && profile.initPattern?.test(command)) {
    if (opts.manifestOnDisk === false) return profile.manifestHint ?? null
    // 内容级校验：空壳 manifest（npm init -y 产物 / 空 requirements.txt）不放行安装
    if (opts.manifestHasContent === false) {
      return profile.manifestEmptyHint ?? profile.manifestHint ?? null
    }
    if (opts.manifestOnDisk === undefined && opts.isProjectCreation) {
      const hasManifest = Array.from(createdFiles).some((p) =>
        normPath(p).endsWith(profile.dependencyManifest)
      )
      if (!hasManifest) return profile.manifestHint ?? null
    }
  }

  // ② 运行命令：依赖必须就绪（已安装成功或依赖目录存在）
  const hitsRun = profile.runPattern?.test(command) || profile.primaryRunPattern?.test(command)
  if (hitsRun) {
    const depsReady = opts.ranInit || opts.depsOnDisk === true
    // 硬拦：依赖目录确认缺失（任何场景，仅限 runPattern 全集）
    if (!depsReady && opts.depsOnDisk === false && profile.runPattern?.test(command)) {
      return profile.runNotReadyHint?.(cmdHead) ?? null
    }
    // 软拦：未探测/依赖目录缺失时的项目创建场景，仅主运行命令（serve/dev/start）
    if (
      !depsReady &&
      opts.depsOnDisk !== true &&
      opts.isProjectCreation &&
      profile.primaryRunPattern?.test(command)
    ) {
      return profile.runSoftHint?.(cmdHead) ?? null
    }
  }
  return null
}

/**
 * 路径归一化：反斜杠转正斜杠，用于与 createdFiles 中的路径比较。
 * 注意：只做分隔符归一，不做大小写归一（跨平台文件名大小写敏感策略不同，
 * 此处保守处理，由调用方保证 createdFiles 写入时的路径规范）。
 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * 命令门控主入口。
 * @returns deny（永久拒绝）/ interactive（需审批后走 PTY）；null 表示放行。
 */
export function gateBashCommand(cmd: string, ctx: BashGateContext): BashGateVerdict {
  const command = (cmd || '').trim()
  if (!command) return null

  // 第一层：系统级破坏命令（最高优先级，永久拒绝）
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.re.test(command)) {
      return { kind: 'deny', message: `错误：${rule.reason}` }
    }
  }

  // 第二层：交互式/阻塞型命令（需用户审批，批准后在 PTY 中运行）
  for (const rule of INTERACTIVE_RULES) {
    if (rule.re.test(command)) {
      return { kind: 'interactive', message: `注意：${rule.reason}` }
    }
  }

  // —— 2.5 全局安装禁令：画像声明的全局安装命令一律硬拦（任何场景生效）——
  // 全局安装污染用户环境且依赖不落入项目本地（npm install -g 不匹配 initPattern，
  // 不会置 ranNpmInstall，但命令本身会真实执行成功）。话术层（S8 纪律/重试话术）
  // 已宣称「绝对禁止」，此处补齐门控硬约束，保持言行一致。
  for (const profile of [NODE_GATE_PROFILE, ...MANIFEST_GATE_PROFILES]) {
    const hit = profile.forbidGlobalInstall.find((g) => g && command.includes(g))
    if (hit) {
      return {
        kind: 'deny',
        message:
          `错误：【前置校验失败】禁止全局安装依赖（命中禁令：${hit}）。` +
          '全局安装会污染用户环境，且依赖不会进入项目本地目录，项目运行时仍然缺包。' +
          '请改用项目本地安装：在依赖声明文件（如 package.json）中声明依赖后执行本地安装命令。'
      }
    }
  }

  // 第三层：项目画像驱动的通用顺序锁（替代原写死的 npm 分支 + 依赖图谱）
  // —— 3a. node 生态（npm/yarn）：调度器显式磁盘探测时任何场景生效；未探测时回退项目创建旧行为 ——
  const nodeBlock = checkCommandOrder(command, NODE_GATE_PROFILE, ctx.createdFiles, {
    manifestOnDisk: ctx.packageJsonExists,
    manifestHasContent: ctx.packageJsonHasContent,
    depsOnDisk: ctx.nodeModulesExists,
    ranInit: ctx.ranNpmInstall,
    isProjectCreation: ctx.isProjectCreation
  })
  if (nodeBlock) return { kind: 'deny', message: nodeBlock }

  // —— 3a+. 清单生成器禁令（项目创建场景）：npm init -y 等生成空壳 manifest 的命令一律拦截，
  //         强制 write_file 写完整清单（空壳会让内容级校验与顺序锁失效）——
  if (ctx.isProjectCreation) {
    for (const profile of [NODE_GATE_PROFILE, ...MANIFEST_GATE_PROFILES]) {
      if (profile.banManifestGen?.re.test(command)) {
        return { kind: 'deny', message: profile.banManifestGen.hint }
      }
    }
  }

  // —— 3b. 非 node 生态依赖图谱（python/go/rust/java/docker，由画像注册表派生；
  //         仅项目创建场景，基于 createdFiles 零 IO 判定）——
  if (ctx.isProjectCreation) {
    for (const profile of MANIFEST_GATE_PROFILES) {
      if (profile.manifestRequiredPattern?.test(command)) {
        const hasFile = Array.from(ctx.createdFiles).some((p) =>
          normPath(p).endsWith(profile.dependencyManifest)
        )
        if (!hasFile && profile.manifestHint) {
          return { kind: 'deny', message: profile.manifestHint }
        }
        break
      }
    }
  }

  return null
}

/**
 * 兼容薄壳：把非 null verdict 折叠为消息文本（interactive 在重规划过滤等
 * 不支持异步审批的场景视同拦截文本），null 表示放行。
 */
export function gateBashMessage(cmd: string, ctx: BashGateContext): string | null {
  const verdict = gateBashCommand(cmd, ctx)
  return verdict ? verdict.message : null
}
