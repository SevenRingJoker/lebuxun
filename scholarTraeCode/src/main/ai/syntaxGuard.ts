// 写入前语法预检（纯检查层，零 IO）：AI 生成的代码在落盘前做语法级校验，
// 在源头拦截「语法错误代码直接写盘 → 验证锁只查文件存在 → 终端编译才报错」的断裂链路。
//
// 检查范围（刻意保持语法级，不做类型检查/作用域分析——按文件独立可判定，无误报）：
//   - .js/.mjs/.cjs/.jsx/.ts/.tsx/.mts/.cts → typescript.transpileModule 语法诊断
//   - .vue → vue/compiler-sfc parse（SFC 结构）+ <script> 块语法诊断（行号回偏到 SFC 全文）
//   - .json → JSON.parse（package.json 格式错误是 npm 秒退的最常见根因）
//
// 宽松策略（防误伤，宁可放行不阻断正常写入）：
//   - 空内容 / 超大内容（>200KB）/ 不可识别扩展名 → 跳过
//   - 检查器自身异常（依赖缺失等）→ 放行
// 返回约定：null = 通过或不适用；非 null = 以「错误：」开头的拒绝消息（与工具层文本错误约定一致，
// 调度器据此记 commandFailure 失败信号并回填给模型）。

// ============ 依赖懒加载（typescript / vue 体积大，仅在首次检查代码文件时加载） ============

type TsModule = typeof import('typescript')
let tsPromise: Promise<TsModule> | null = null
function loadTs(): Promise<TsModule> {
  if (!tsPromise) tsPromise = import('typescript')
  return tsPromise
}

/** vue/compiler-sfc 的最小结构面（避免绑死完整类型，缺失字段时兜底放行） */
interface SfcParseIssue {
  message: string
  loc?: { start?: { line?: number; column?: number } }
}
interface SfcScriptBlock {
  content: string
  lang?: string
  loc: { start: { line: number } }
}
interface SfcModule {
  parse: (
    source: string,
    options: { filename?: string; sourceMap?: boolean }
  ) => { errors: SfcParseIssue[]; descriptor: { script?: SfcScriptBlock | null; scriptSetup?: SfcScriptBlock | null } }
}
let sfcPromise: Promise<SfcModule> | null = null
function loadSfc(): Promise<SfcModule> {
  if (!sfcPromise) sfcPromise = import('vue/compiler-sfc') as Promise<SfcModule>
  return sfcPromise
}

// ============ 基础工具 ============

/** 可检查的扩展名集合（小写、含点） */
const CHECKABLE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.json'
])
/** 超大内容跳过检查（检查耗时与误报风险都不可控） */
const MAX_CHECK_CHARS = 200_000

/** 单条语法问题（行/列从 1 起） */
export interface SyntaxIssue {
  line: number
  column: number
  message: string
}

/** 文本偏移 → 行/列（1 起） */
export function lineColOf(content: string, offset: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(offset, content.length))
  const before = content.slice(0, safe)
  const lines = before.split('\n')
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 }
}

// ============ 分类型检查器 ============

/**
 * JS/TS 语法检查：transpileModule 只报语法诊断（TS1xxx），不做类型/作用域检查。
 * pseudoName 决定解析口径（.jsx/.tsx 按 JSX 解析、.ts 允许类型标注、.js 内写 TS 标注会报语法错——本就应拦）。
 */
export async function checkScriptLike(code: string, pseudoName: string): Promise<SyntaxIssue[]> {
  const ts = await loadTs()
  const out = ts.transpileModule(code, {
    fileName: pseudoName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      allowJs: true,
      // 恒用 Preserve：JsxEmit.None 不被 --jsx 选项接受（会注入一条伪 Error 诊断导致合法文件被误拒），
      // Preserve 对无 JSX 的文件无副作用，对 .tsx/.jsx 则保留 JSX 语法不报错
      jsx: ts.JsxEmit.Preserve
    },
    reportDiagnostics: true
  })
  const issues: SyntaxIssue[] = []
  for (const d of out.diagnostics ?? []) {
    if (d.category !== ts.DiagnosticCategory.Error) continue
    issues.push({
      ...lineColOf(code, d.start ?? 0),
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n')
    })
  }
  return issues
}

/** JSON 语法检查：解析失败时把 position 换算成行/列 */
export function checkJson(content: string): SyntaxIssue[] {
  try {
    JSON.parse(content)
    return []
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const m = message.match(/position (\d+)/i)
    const pos = m ? Number(m[1]) : 0
    return [{ ...lineColOf(content, pos), message }]
  }
}

/**
 * Vue SFC 检查：先 parse 整体结构（模板/标签闭合），再对 <script>/<script setup>
 * 内容做语法检查，行号回偏到 SFC 全文坐标。
 */
export async function checkVueSfc(content: string, name: string): Promise<SyntaxIssue[]> {
  const sfc = await loadSfc()
  const { errors, descriptor } = sfc.parse(content, { filename: name, sourceMap: false })
  const issues: SyntaxIssue[] = errors.map((e) => ({
    line: e.loc?.start?.line ?? 1,
    column: e.loc?.start?.column ?? 1,
    message: e.message
  }))
  const script = descriptor.script ?? descriptor.scriptSetup
  if (script && script.content.trim()) {
    const lang = (script.lang || 'js').toLowerCase()
    const pseudoExt = lang === 'tsx' ? '.tsx' : lang === 'ts' ? '.ts' : '.js'
    const sub = await checkScriptLike(script.content, `${name}.${pseudoExt}`)
    // script.loc.start.line 是 <script> 标签行，块内容首行 = 标签行 + 1，
    // 因此内容行号 L 对应全文行号 L + 标签行（不可再减 1，否则整体偏上 1 行）
    const baseLine = Math.max(0, script.loc.start.line)
    issues.push(...sub.map((i) => ({ line: i.line + baseLine, column: i.column, message: i.message })))
  }
  return issues
}

// ============ 主入口 ============

/**
 * 写入前语法预检。
 * @param filePath 目标文件绝对路径（按扩展名路由检查器）
 * @param content 即将写入的完整内容
 * @returns null = 通过 / 不适用 / 检查器异常放行；非 null = 「错误：」开头的拒绝消息
 */
export async function validateSyntaxBeforeWrite(filePath: string, content: string): Promise<string | null> {
  if (!filePath || !content || !content.trim()) return null
  if (content.length > MAX_CHECK_CHARS) return null
  const m = filePath.toLowerCase().match(/(\.[a-z0-9]+)$/)
  const ext = m ? m[1] : ''
  if (!ext || !CHECKABLE_EXTS.has(ext)) return null

  let issues: SyntaxIssue[]
  try {
    if (ext === '.json') {
      issues = checkJson(content)
    } else if (ext === '.vue') {
      issues = await checkVueSfc(content, filePath)
    } else {
      issues = await checkScriptLike(content, filePath)
    }
  } catch {
    // 依赖加载失败等检查器自身异常：放行，不阻断写入主流程
    return null
  }
  if (issues.length === 0) return null

  const first = issues[0]
  const more = issues.length > 1 ? `（共 ${issues.length} 处语法问题，仅显示第一处）` : ''
  return (
    `错误：语法预检未通过，文件未写入（${filePath}）\n` +
    `第 ${first.line} 行 第 ${first.column} 列：${first.message}${more}\n` +
    `请修复语法后重试；修改既有文件请优先用 edit 精准替换，避免整文件重写。`
  )
}
