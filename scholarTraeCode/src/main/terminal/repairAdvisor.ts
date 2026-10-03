// s45 失败分类与修复动作生成（纯函数层，零 IO）。
//
// 与 commandError.ts 的分工：
//   - commandError 面向「给 AI 的诊断摘要」（规则命中 + hints + severity）
//   - 本模块面向「交付闭环」：把失败归入四类（缺依赖/版本冲突/系统差异/代码错误），
//     并为前三类生成具体可执行的修复动作（装包/锁版本/换镜像源），
//     由渲染端修复确认卡片承载，用户确认后才执行。
//
// 四类语义：
//   missing-dep      缺依赖：Cannot find module / ModuleNotFoundError / no required module
//   version-conflict 版本冲突：npm ERESOLVE / peer dep / pip ResolutionImpossible
//   system           系统差异：命令不存在、权限不足、网络/镜像、动态库缺失
//   code             代码错误：TS 编译错、语法错、运行时 ReferenceError 等（不自动修，回 AI 改代码）
//   unknown          未识别（不给修复动作）

import { analyzeCommandError, type CommandErrorInfo } from './commandError'

export type FailureCategory = 'missing-dep' | 'version-conflict' | 'system' | 'code' | 'unknown'

export interface FailureReport {
  category: FailureCategory
  /** 提取出的主体（包名/命令名），无则 null */
  subject: string | null
  /** 一句话概述（复用 commandError 的摘要） */
  summary: string
  hints: string[]
  severity: 'auto' | 'manual'
}

export interface RepairAction {
  /** 稳定 id：卡片去重与留痕引用 */
  id: string
  kind: 'install-dep' | 'pin-version' | 'switch-mirror' | 'downgrade' | 'manual-step'
  /** 卡片按钮文案 */
  label: string
  /** 可执行命令；null 表示纯建议（仅展示，不执行） */
  command: string | null
  /** 补充说明（风险/前提） */
  note: string
  risk: 'low' | 'medium' | 'high'
}

interface CategoryRule {
  re: RegExp
  category: FailureCategory
  /** 从命中行提取主体（包名等）；无提取需求省略 */
  pick?: (line: string) => string | null
  severity?: 'auto' | 'manual'
}

/** 提取引号包裹的模块名：Cannot find module 'x' / No module named 'x' */
function pickQuoted(line: string): string | null {
  const m = line.match(/'([^']+)'/) ?? line.match(/"([^"]+)"/)
  return m ? m[1] : null
}

/** 提取 go 模块路径：no required module provides package github.com/x/y */
function pickGoPkg(line: string): string | null {
  const m = line.match(/provides package\s+(\S+)/)
  return m ? m[1] : null
}

/** 提取缺失命令名：'npm' 不是内部或外部命令 / bash: foo: command not found */
function pickCommandName(line: string): string | null {
  const win = line.match(/'([^']+)'\s*不是内部或外部命令/)
  if (win) return win[1]
  const posix = line.match(/(?:bash|sh|zsh):\s*(\S+):\s*command not found/)
  if (posix) return posix[1]
  const win2 = line.match(/(\S+)\s*not recognized as an internal/i)
  return win2 ? win2[1] : null
}

// 规则顺序即优先级：先具体后通用。同类别多条都可能命中，主体取首个非空。
const CATEGORY_RULES: CategoryRule[] = [
  // —— 缺依赖 ——
  {
    re: /Cannot find module|ERR_MODULE_NOT_FOUND/i,
    category: 'missing-dep',
    pick: pickQuoted
  },
  {
    re: /Can't resolve|Module not found/i,
    category: 'missing-dep',
    pick: pickQuoted
  },
  {
    re: /ModuleNotFoundError: No module named/i,
    category: 'missing-dep',
    pick: pickQuoted
  },
  {
    re: /no required module provides package/i,
    category: 'missing-dep',
    pick: pickGoPkg
  },
  // —— 版本冲突 ——
  { re: /ERESOLVE|unable to resolve dependency tree/i, category: 'version-conflict' },
  { re: /Conflicting peer dependency|peer dep/i, category: 'version-conflict' },
  { re: /ResolutionImpossible|dependency resolver/i, category: 'version-conflict' },
  // —— 系统差异 ——
  {
    re: /不是内部或外部命令|command not found|not recognized as an internal/i,
    category: 'system',
    pick: pickCommandName,
    severity: 'manual'
  },
  {
    re: /permission denied|operation not permitted|access is denied|code EACCES/i,
    category: 'system',
    severity: 'manual'
  },
  {
    re: /Could not fetch URL|ReadTimeoutError|SSLError|ECONNRESET|dial tcp|connection refused|GOPROXY/i,
    category: 'system'
  },
  {
    re: /error while loading shared libraries|cannot open shared object file/i,
    category: 'system',
    severity: 'manual'
  },
  {
    re: /E: Unable to locate package|No package .* available/i,
    category: 'system',
    severity: 'manual'
  },
  // —— 代码错误 ——
  { re: /error TS\d{3,5}/i, category: 'code' },
  { re: /SyntaxError|Unexpected token/i, category: 'code' },
  { re: /ReferenceError|TypeError(?!.*Cannot find)|is not defined/i, category: 'code' },
  { re: /failed to compile|compilation failed|build failed/i, category: 'code' }
]

/** 相对路径导入（./x ../x）缺模块属代码问题，不是缺包 */
function isRelativeSpecifier(s: string | null): boolean {
  return !!s && (s.startsWith('./') || s.startsWith('../') || s.startsWith('.'))
}

/** npm 包名归一：'lodash/fp' → lodash；'@scope/pkg/sub' → @scope/pkg */
export function npmPackageName(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** python 模块名 → 常见包名修正（模块名≠包名的高频案例） */
export function pypiPackageName(mod: string): string {
  const root = mod.split('.')[0]
  const ALIAS: Record<string, string> = {
    cv2: 'opencv-python',
    PIL: 'Pillow',
    sklearn: 'scikit-learn',
    yaml: 'PyYAML',
    bs4: 'beautifulsoup4'
  }
  return ALIAS[root] ?? root
}

/**
 * 分类一次命令失败。exitCode=0 返回 null。
 * summary/hints/severity 复用 commandError 的诊断结论，分类只决定卡片与修复动作。
 */
export function classifyFailure(
  command: string,
  output: string,
  exitCode: number | null
): FailureReport | null {
  const diag: CommandErrorInfo | null = analyzeCommandError(command, output, exitCode)
  if (!diag) return null
  const text = (output || '').trim()
  const lines = text ? text.split(/\r?\n/) : []

  let category: FailureCategory = 'unknown'
  let subject: string | null = null
  let severityOverride: 'auto' | 'manual' | null = null

  for (const rule of CATEGORY_RULES) {
    for (const line of lines) {
      if (!rule.re.test(line)) continue
      if (category === 'unknown') {
        category = rule.category
        severityOverride = rule.severity ?? null
      }
      if (!subject && rule.pick) {
        const p = rule.pick(line)
        if (p) subject = p
      }
      break // 每条规则只取首个命中行
    }
    if (category !== 'unknown' && subject) break
  }

  // 相对路径缺模块 → 归为代码错误（导入路径写错，不是缺包）
  if (category === 'missing-dep' && isRelativeSpecifier(subject)) {
    category = 'code'
    subject = null
  }

  return {
    category,
    subject,
    summary: diag.summary,
    hints: diag.hints,
    severity: severityOverride ?? diag.severity
  }
}

/**
 * 按分类生成修复动作。code/unknown 不给自动动作（回 AI 修代码路径）。
 * 动作原则：低风险可一键执行（装包/换镜像）；中风险给确认说明；纯建议 command=null。
 */
export function proposeRepairs(report: FailureReport): RepairAction[] {
  const out: RepairAction[] = []
  const { category, subject } = report

  if (category === 'missing-dep' && subject) {
    if (/^[\w@./-]+$/.test(subject) && subject.includes('/') && subject.startsWith('@')) {
      // @scope/pkg 形式：npm 包
      out.push({
        id: `npm-install:${subject}`,
        kind: 'install-dep',
        label: `npm install ${npmPackageName(subject)}`,
        command: `npm install ${npmPackageName(subject)}`,
        note: '安装缺失的 npm 包（写入 dependencies 需 --save 语义默认开启）',
        risk: 'low'
      })
    } else if (/^[a-zA-Z_][\w.-]*$/.test(subject) && !subject.includes('/')) {
      // 纯标识符（允许连字符：left-pad / is-odd 等高频 npm 命名）：python 模块或 npm 包。命令行决定生态。
      out.push({
        id: `pip-install:${subject}`,
        kind: 'install-dep',
        label: `pip install ${pypiPackageName(subject)}`,
        command: `pip install ${pypiPackageName(subject)}`,
        note: subject !== pypiPackageName(subject) ? `模块名 ${subject} 对应包名 ${pypiPackageName(subject)}` : '安装缺失的 Python 包',
        risk: 'low'
      })
      out.push({
        id: `npm-install:${subject}`,
        kind: 'install-dep',
        label: `npm install ${subject}`,
        command: `npm install ${subject}`,
        note: '若这是 Node 项目的依赖则选此项',
        risk: 'low'
      })
    } else if (subject.includes('/')) {
      // go 模块路径或 npm 子路径
      out.push({
        id: `npm-install:${subject}`,
        kind: 'install-dep',
        label: `npm install ${npmPackageName(subject)}`,
        command: `npm install ${npmPackageName(subject)}`,
        note: '安装缺失的 npm 包',
        risk: 'low'
      })
      out.push({
        id: `go-get:${subject}`,
        kind: 'install-dep',
        label: `go get ${subject}`,
        command: `go get ${subject}`,
        note: '若这是 Go 模块则选此项',
        risk: 'low'
      })
    }
  }

  if (category === 'version-conflict') {
    out.push({
      id: 'npm-legacy-peer',
      kind: 'pin-version',
      label: 'npm install --legacy-peer-deps',
      command: 'npm install --legacy-peer-deps',
      note: '绕过 peer 依赖冲突安装（不解决根本冲突，适合先跑起来）',
      risk: 'medium'
    })
    out.push({
      id: 'pin-version-advice',
      kind: 'pin-version',
      label: '锁定依赖版本（建议）',
      command: null,
      note: '在 package.json 中把冲突依赖固定到兼容版本（去掉 ^/~ 前缀），长期更稳',
      risk: 'low'
    })
  }

  if (category === 'system') {
    const text = report.summary + '\n' + report.hints.join('\n')
    if (/pip|PyPI|python/i.test(text) || /Could not fetch URL|ReadTimeoutError/i.test(text)) {
      out.push({
        id: 'pip-mirror',
        kind: 'switch-mirror',
        label: 'pip 切清华镜像源',
        command: 'pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple',
        note: '持久写入 pip 配置；之后 pip install 走国内镜像',
        risk: 'low'
      })
    }
    if (/go|GOPROXY/i.test(text)) {
      out.push({
        id: 'go-mirror',
        kind: 'switch-mirror',
        label: 'Go 切国内 GOPROXY',
        command: 'go env -w GOPROXY=https://goproxy.cn,direct',
        note: '持久写入 go env；之后 go mod 下载走国内镜像',
        risk: 'low'
      })
    }
    if (/npm ERR|npm/i.test(text)) {
      out.push({
        id: 'npm-mirror',
        kind: 'switch-mirror',
        label: 'npm 切淘宝镜像源',
        command: 'npm config set registry https://registry.npmmirror.com',
        note: '持久写入 npm 配置；之后 npm install 走国内镜像',
        risk: 'low'
      })
    }
    // 命令不存在：给安装引导（纯建议）
    if (report.subject) {
      out.push({
        id: `install-runtime:${report.subject}`,
        kind: 'manual-step',
        label: `安装 ${report.subject}（手动）`,
        command: null,
        note: `系统未安装「${report.subject}」：请从官网下载安装后重开终端；AI 不代装系统级运行时`,
        risk: 'low'
      })
    }
  }

  return out
}

/** 修复卡片事件的负载（主进程 → 渲染进程） */
export interface RepairProposal {
  /** 来源标识：bash=终端命令失败；test=自动回归失败 */
  origin: 'bash' | 'test'
  command: string
  cwd: string
  report: FailureReport
  actions: RepairAction[]
}

/** 给 AI 工具结果追加的修复建议文本（无可执行动作时返回空串） */
export function formatRepairForAi(p: RepairProposal): string {
  if (p.actions.length === 0) return ''
  const catLabel: Record<FailureCategory, string> = {
    'missing-dep': '缺依赖',
    'version-conflict': '版本冲突',
    system: '系统差异',
    code: '代码错误',
    unknown: '未识别'
  }
  const lines = p.actions
    .map((a) => (a.command ? `- 可执行：${a.command}（${a.note}）` : `- 建议：${a.label} — ${a.note}`))
    .join('\n')
  return `\n\n【修复建议·${catLabel[p.report.category]}】已向用户展示修复确认卡片，用户确认后才会执行：\n${lines}`
}
