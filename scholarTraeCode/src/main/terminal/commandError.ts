// 终端命令失败诊断纯函数层（零 IO）。
//
// 失败输出往往几十上百行，真正有用的是「错误关键行 + 尾部结论」。
// 本模块按语言/工具分类的规则注册表（Node/Python/Go/Rust/Docker/Git/系统级）
// 提取摘要与提示，同时供主进程 AI 工具结果附加诊断、前端「AI 修复」按钮构造 prompt 使用。
//
// severity 分级：
//   - 'auto'：AI 可自行尝试修复（如 go mod tidy、换端口、--legacy-peer-deps）
//   - 'manual'：需用户介入（安装缺失运行时、apt update、修文件属主等，AI 不应盲目 sudo）
import { detectProfileForCommand, type ProjectProfile } from '../../shared/projectProfiles'

export interface CommandErrorInfo {
  /** 一句话概述：首个命中的错误关键行 */
  summary: string
  /** 可执行的修复方向（去重，最多 3 条） */
  hints: string[]
  /** 输出尾部片段（结论通常在最后） */
  tail: string
  /** 处理分级：auto=AI 可自修，manual=需用户介入 */
  severity: 'auto' | 'manual'
}

/** 尾部片段保留字符数 */
const TAIL_LIMIT = 1500
/** 关键行/提示上限 */
const MAX_MATCH_LINES = 3
const MAX_HINTS = 3

interface ErrorRule {
  /** 关键行匹配（大小写不敏感） */
  re: RegExp
  /** 命中后给出的修复方向 */
  hint: string
  /** 处理分级：默认 auto（AI 可自修）；manual 需用户介入（禁 sudo 等） */
  severity?: 'auto' | 'manual'
}

// 规则顺序即优先级：先具体（缺命令/端口占用/运行时专属）后通用（编译错误）
const RULES: ErrorRule[] = [
  // —— 命令缺失：联动 ㉔ 环境探测，让 AI 先确认运行时是否安装 ——
  {
    re: /不是内部或外部命令|command not found|not recognized as an internal/i,
    hint: '命令不存在：先调用 probe_environment 确认该运行时是否安装；缺失时引导用户安装，勿盲目重试或乱装全局包',
    severity: 'manual'
  },
  // —— 权限不足：禁止 AI 引导 sudo，改走属主/目录方案 ——
  {
    re: /permission denied|operation not permitted|access is denied/i,
    hint: '权限不足：不要尝试 sudo；检查文件属主/只读属性，或切换到用户目录下的工作区操作',
    severity: 'manual'
  },
  // —— 端口占用 ——
  {
    re: /EADDRINUSE|address already in use|port is already allocated/i,
    hint: '端口被占用：结束占用进程（netstat -ano | findstr :端口 后 taskkill /PID；POSIX lsof -i :端口 后 kill）或更换端口'
  },
  // —— 文件/路径缺失 ——
  {
    re: /ENOENT[^\n]*/i,
    hint: '文件或路径不存在：核对路径拼写、大小写与当前工作目录'
  },
  {
    re: /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i,
    hint: '缺少模块：执行 npm install（或安装报错中指定的包），检查导入路径与包名'
  },
  // —— Node 生态 ——
  {
    re: /npm ERR! (?:enoent|code ENOENT)|couldn't read package\.json/i,
    hint: 'npm 找不到 package.json：确认命令在项目根目录执行'
  },
  {
    re: /npm ERR!.*ERESOLVE|unable to resolve dependency tree/i,
    hint: '依赖冲突：阅读 peer dependency 说明，可尝试 npm install --legacy-peer-deps'
  },
  {
    re: /npm ERR! code EACCES/i,
    hint: 'npm 权限错误：不要 sudo npm；改用 nvm 管理 Node，或修复 npm cache 目录属主（npm config get cache）',
    severity: 'manual'
  },
  {
    re: /npm ERR!|ELIFECYCLE/i,
    hint: 'npm 脚本失败：向上查找首个 npm ERR! 根因行；脚本本身的报错通常在它之前'
  },
  // —— 编译/语法 ——
  {
    re: /error TS\d{3,5}/i,
    hint: 'TypeScript 编译错误：按文件路径与行号定位，先修第一个 TS 错误（后续错误常由它引发）'
  },
  {
    re: /SyntaxError[^\n]*/i,
    hint: '语法错误：检查报错文件对应行的括号/引号/缩进与语言版本'
  },
  {
    re: /failed to compile|compilation failed|build failed/i,
    hint: '构建失败：查看第一条具体编译错误，修复后重新构建'
  },
  // —— Git ——
  {
    re: /fatal: not a git repository/i,
    hint: '不是 git 仓库：在项目根目录执行 git init，或切换到正确目录'
  },
  // —— Docker ——
  {
    re: /OOMKilled|out of memory|Killed\b/i,
    hint: '容器内存不足：调整 docker run/run 的 --memory 限制，或优化应用内存占用'
  },
  {
    re: /port is already allocated|Bind for .* failed/i,
    hint: 'Docker 端口映射冲突：更换宿主机端口（-p 宿主机端口:容器端口），或停掉占用该端口的容器'
  },
  // —— Python ——
  {
    re: /ModuleNotFoundError[^\n]*/i,
    hint: 'Python 缺模块：确认 venv 已激活（Windows venv\\Scripts\\activate / POSIX source venv/bin/activate），并执行 pip install -r requirements.txt'
  },
  {
    re: /IndentationError[^\n]*/i,
    hint: 'Python 缩进错误：检查报错行的空格/Tab 混用，统一为 4 空格缩进'
  },
  {
    re: /externally-managed-environment|error: externally-managed/i,
    hint: 'PEP 668 阻止全局 pip：请使用 python -m venv 创建虚拟环境后激活再安装，勿用 --break-system-packages',
    severity: 'manual'
  },
  {
    re: /Could not fetch URL|ReadTimeoutError|SSLError.*certificate|ECONNRESET.*registry/i,
    hint: 'pip 网络/SSL 错误：切换国内镜像源（pip install -i https://pypi.tuna.tsinghua.edu.cn/simple），或检查网络/代理'
  },
  // —— Go ——
  {
    re: /no required module provides package/i,
    hint: 'Go 缺少依赖：执行 go mod tidy 拉取缺失模块（模块路径在报错行中）'
  },
  {
    re: /go\.mod file not found|go: cannot find main module|see 'go help modules'/i,
    hint: '无 go.mod：在项目根目录执行 go mod init <模块名>'
  },
  {
    re: /\.go:\d+:\d+: undefined:/i,
    hint: 'Go 未定义符号：检查标识符拼写、包导入路径与首字母大小写（跨包引用须大写）'
  },
  {
    re: /missing go\.sum entry|go: go\.sum\.mod has error/i,
    hint: 'go.sum 缺失：执行 go mod tidy 补齐依赖校验和'
  },
  {
    re: /go: .*dial tcp|go: .*connection refused|GOPROXY.*disabled/i,
    hint: 'Go 模块下载失败：设置 GOPROXY 国内镜像（go env -w GOPROXY=https://goproxy.cn,direct）后重试'
  },
  // —— Rust ——
  {
    re: /error\[E0433\]/i,
    hint: 'Rust 解析失败（E0433）：use 路径错误或 crate 未声明——在 Cargo.toml [dependencies] 补齐后重新 cargo build'
  },
  {
    re: /error\[E\d{4}\]/i,
    hint: 'Rust 编译错误：按 error[Exxxx] 编号执行 rustc --explain <编号> 查看说明，先修第一个错误'
  },
  // —— Linux 系统级 ——
  {
    re: /error while loading shared libraries|cannot open shared object file/i,
    hint: '动态库缺失：用 ldd <可执行文件> 定位缺失的 .so，安装对应系统库（apt/yum install）',
    severity: 'manual'
  },
  {
    re: /E: Unable to locate package|No package .* available/i,
    hint: 'apt 找不到包：需用户手动执行 apt update 刷新索引后再装（AI 不执行 apt 类系统命令）',
    severity: 'manual'
  }
]

/**
 * 分析失败命令的输出。
 * @returns exitCode 为 0、或输出为空、或无任何规则命中时返回 null（调用方据此省略诊断段）
 */
export function analyzeCommandError(
  command: string,
  output: string,
  exitCode: number | null
): CommandErrorInfo | null {
  if (exitCode === 0) return null
  const text = (output || '').trim()
  if (!text) {
    return exitCode === null
      ? { summary: '命令执行超时', hints: ['命令可能进入交互等待或耗时过长：检查是否需要人工输入，或加大超时'], tail: '', severity: 'auto' }
      : {
          summary: `命令退出码 ${exitCode}（无输出）`,
          hints: ['无错误输出：用 echo %ERRORLEVEL%（POSIX 为 echo $?）确认，或拆分命令逐步排查'],
          tail: '',
          severity: 'auto'
        }
  }

  const lines = text.split(/\r?\n/)
  const matched: string[] = []
  const hints: string[] = []
  let severity: 'auto' | 'manual' = 'auto'
  let severitySet = false

  // 按规则优先级遍历：首个命中规则的 severity 决定整体分级
  for (const rule of RULES) {
    let ruleMatched = false
    for (const line of lines) {
      if (rule.re.test(line)) {
        const clean = line.trim()
        if (clean && !matched.some((m) => m === clean)) matched.push(clean)
        if (!hints.includes(rule.hint)) hints.push(rule.hint)
        ruleMatched = true
        if (matched.length >= MAX_MATCH_LINES && hints.length >= MAX_HINTS) break
      }
    }
    if (ruleMatched && !severitySet) {
      severity = rule.severity ?? 'auto'
      severitySet = true
    }
    if (matched.length >= MAX_MATCH_LINES && hints.length >= MAX_HINTS) break
  }

  const summary =
    matched[0] ||
    (exitCode === null
      ? '命令执行超时'
      : `命令退出码 ${exitCode}：${command.slice(0, 120)}`)
  const tail = text.length > TAIL_LIMIT ? text.slice(-TAIL_LIMIT) : text

  if (matched.length === 0 && hints.length === 0 && exitCode !== null) {
    // 未识别错误类型：仍给通用排查方向
    hints.push('查看输出尾部的错误行；可将完整报错交给 AI 或搜索引擎定位')
  }

  return { summary, hints: hints.slice(0, MAX_HINTS), tail, severity }
}

/** 把诊断格式化为附加给 AI 工具结果的文本段（无诊断返回空串） */
export function formatErrorForAi(info: CommandErrorInfo | null): string {
  if (!info) return ''
  const hintLines = info.hints.map((h) => `- ${h}`).join('\n')
  const severityTag = info.severity === 'manual' ? '【需用户介入】' : '【AI 可自修】'
  return `\n\n${severityTag}【诊断摘要】${info.summary}\n修复方向：\n${hintLines}\n【输出尾部】\n${info.tail}`
}

/**
 * 秒退判定阈值：非交互命令在该时长内非正常退出，几乎必然是前置条件缺失
 * （无 package.json / 未装依赖 / 脚本名拼错），而非真实运行失败。
 */
export const QUICK_EXIT_THRESHOLD_MS = 500

/** 秒退判定：耗时低于阈值且退出码非 0（exitCode=null 是超时/中止，不算秒退） */
export function isQuickExit(durationMs: number, exitCode: number | null): boolean {
  return typeof durationMs === 'number' &&
    durationMs >= 0 &&
    durationMs < QUICK_EXIT_THRESHOLD_MS &&
    exitCode !== null &&
    exitCode !== 0
}

/**
 * 构造秒退失败的「强制反思」前缀文本（以「错误：」开头，调度器据此记 commandFailure 并触发重规划）。
 * 非秒退返回 null。文案按项目画像生成（缺省按命令文本自动识别生态）：
 * 要求模型停止后续文件修改、优先补齐该生态的前置条件，防止盲目前进。
 */
export function formatQuickExitAdvice(
  command: string,
  exitCode: number | null,
  durationMs: number,
  profile?: ProjectProfile
): string | null {
  if (!isQuickExit(durationMs, exitCode)) return null
  const p = profile ?? detectProfileForCommand(command)
  const cmdHead = (command || '').split(/\s*[;&|]/)[0].trim().slice(0, 100) || '命令'
  const head =
    `错误：终端执行失败（耗时仅 ${Math.max(durationMs, 0)}ms，退出码 ${exitCode}）。` +
    `${cmdHead} 在 500ms 内非正常退出，属于典型的前置条件缺失秒退：`

  // node 生态：package.json / node_modules 专属指引
  if (p.id === 'node' || p.id === 'vue' || p.id === 'react') {
    return (
      head +
      '常见原因为工作目录缺少 package.json、依赖未安装（node_modules 不存在）或 package.json 格式/脚本名错误。\n' +
      '【强制反思】请立即停止后续的 read/edit 文件修改，不要继续给残缺文件打补丁：\n' +
      '1) 先用 read_text_file 核对 package.json 是否存在且 JSON 合法（不存在则用 write 完整生成）；\n' +
      '2) 执行 npm install 并确认成功（无 npm ERR / 退出码为 0）；\n' +
      '3) 前置条件全部满足后再重试该命令。'
    )
  }

  // 其他有 manifest 的生态：按画像字段生成等价指引
  if (p.dependencyManifest) {
    const configText = p.configFiles.length > 0 ? `，再写配置（${p.configFiles.join('、')}）` : ''
    const initText = p.initCommands[0] ?? '对应依赖安装命令'
    return (
      head +
      `常见原因为工作目录缺少 ${p.dependencyManifest}、依赖未安装或 ${p.dependencyManifest} 格式错误。\n` +
      '【强制反思】请立即停止后续的 read/edit 文件修改，不要继续给残缺文件打补丁：\n' +
      `1) 先用 write 工具完整生成 ${p.dependencyManifest}${configText}；\n` +
      `2) 执行 ${initText} 并确认成功（退出码为 0）；\n` +
      '3) 前置条件全部满足后再重试该命令。'
    )
  }

  // 通用兜底：识别不出生态时的强制反思
  return (
    head +
    '命令瞬间失败退出，通常是因为环境未初始化或命令拼写错误。请检查前置条件。\n' +
    '【强制反思】请立即停止后续的 read/edit 文件修改：\n' +
    '1) 核对命令拼写与当前工作目录；2) 确认所需运行时/依赖声明文件已就绪；3) 前置条件满足后再重试。'
  )
}

/**
 * 非零退出强制标记：exitCode !== 0 时在返回给 AI 的结果前置 [EXECUTION_FAILED] 标签，
 * 并附带输出尾部 10 行——强迫 LLM 停下来反思，而不是闭着眼睛往下跑。
 * 退出码 0 / null（超时或中止，已有专门文案）返回空串。
 */
export function analyzeExitCode(output: string, exitCode: number | null): string {
  if (exitCode === null || exitCode === 0) return ''
  const lines = (output || '')
    .trimEnd()
    .split(/\r?\n/)
    .filter((l) => l.trim())
  const tail = lines.slice(-10).join('\n')
  return (
    `[EXECUTION_FAILED] 命令以非零退出码 ${exitCode} 失败。请停下来分析失败原因后再决定下一步，` +
    '禁止不做分析继续后续文件修改。' +
    (tail ? `\n【输出尾部 10 行】\n${tail}` : '')
  )
}

/** 秒退熔断阈值：非零退出且耗时低于该值 → 致命错误（文件缺失/语法错误必然秒崩） */
export const FAST_FAIL_BREAKER_MS = 1000
/** 熔断标记：调度器在工具结果中识别此标记后立即中断当前批次并强制反思 */
export const FAST_FAIL_BREAKER_TAG = '[FAST_FAIL_BREAKER]'

/**
 * 秒退熔断器：exitCode 非零且 duration < 1000ms 时产出强中断指令。
 * 与 formatQuickExitAdvice（500ms 反思建议）的差异：本函数是「熔断」——
 * 结果带 FAST_FAIL_BREAKER_TAG 标记，调度器识别后立即中止当前工具批次，
 * 禁止模型继续执行任何后续命令，必须先 read_file / list_directory 定位修复。
 * 返回 null 表示未触发熔断。
 */
export function formatFastFailBreaker(
  command: string,
  exitCode: number | null,
  durationMs: number
): string | null {
  if (exitCode === null || exitCode === 0) return null
  if (durationMs >= FAST_FAIL_BREAKER_MS) return null
  const cmdHead = (command || '').split(/\s*[;&|]/)[0].trim().slice(0, 100) || '命令'
  return (
    `${FAST_FAIL_BREAKER_TAG}【致命错误】命令瞬间崩溃（耗时 ${Math.max(durationMs, 0)}ms，退出码 ${exitCode}）：${cmdHead}。\n` +
    '原因极大概率是文件缺失或语法错误。你被禁止继续执行任何后续命令。\n' +
    '请立刻使用 read_file 仔细阅读报错涉及的代码文件，或使用 list_directory 检查目录结构，修复源码后才可再次运行。'
  )
}
