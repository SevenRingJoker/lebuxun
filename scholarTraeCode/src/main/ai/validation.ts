// 验证锁框架（纯函数层）：任务无关的验证器注册表。
// 将原本硬编码在 scheduler.ts 中的「项目创建 5 项校验」抽出来，
// 抽象为可由 manifest（产物清单）声明的若干 ValidationRule。
// 零 IO、零 electron 依赖，可在 Node 单测环境直接运行。
//
// 设计参考：shellProbe.ts / dapCore.ts（纯函数 + 单测先例）。
// 接线点：scheduler.ts 中 validateProjectCreation 改为薄壳调用 runValidation + vueScaffoldManifest。
//
// 预置模板（vue/node/python/go/rust/docker）已迁入 validationTemplates.ts，
// 本文件重导出 vueScaffoldManifest 以兼容现有 import。

import { vueScaffoldManifest, resolveTemplateReference, AVAILABLE_TEMPLATE_IDS } from './validationTemplates'
export { vueScaffoldManifest, resolveTemplateReference, AVAILABLE_TEMPLATE_IDS }

/** 验证器种类：四类预置 + 自定义回调 */
export type ValidationKind = 'fileExists' | 'contentMatch' | 'commandExecuted' | 'custom'

/** 严重级别：block 阻止收尾，warn 仅记录不阻止 */
export type Severity = 'block' | 'warn'

/**
 * 单条验证规则。kind 决定取哪个参数。
 * - fileExists: 用 path 在 createdFiles 中做后缀匹配（兼容反斜杠/大小写）
 * - contentMatch: 二期 API 预留，本期 vueScaffold 不使用
 * - commandExecuted: 用 command 正则在 executedCommands 键集合中匹配，且结果不含失败标记
 * - custom: 用 check 回调，调用方自行决定通过与否
 */
export interface ValidationRule {
  id: string
  description: string
  kind: ValidationKind
  severity?: Severity
  /** fileExists / contentMatch：相对工作区路径或后缀匹配模式 */
  path?: string
  /** contentMatch：内容正则或字符串（二期预留） */
  pattern?: string | RegExp
  /** commandExecuted：命令文本或正则 */
  command?: string | RegExp
  /** custom：回调签名，返回 true 视为通过，false 视为未通过；可覆盖描述 */
  check?: (ctx: ValidationContext) => boolean | { passed: boolean; message?: string }
}

/** 产物清单：一组规则的容器 */
export interface ArtifactManifest {
  id: string
  rules: ValidationRule[]
}

/** 验证执行所需上下文（scheduler 侧适配填充） */
export interface ValidationContext {
  /** 已创建文件集合（含 MCP write_file 追踪） */
  createdFiles: Set<string>
  /** 已执行命令文本 → 结果文本（成功时空串，失败时含错误片段） */
  executedCommands: Map<string, string>
  /** 工作区根（仅用于消息展示，纯函数层不读磁盘） */
  workspace?: string
}

/** 单条验证结果 */
export interface ValidationResult {
  ruleId: string
  passed: boolean
  message: string
  severity: Severity
}

/** 聚合结果 */
export interface ValidationSummary {
  allPassed: boolean
  /** 仅未通过项（按声明顺序） */
  failed: ValidationResult[]
  /** 给模型的强制继续消息；allPassed 时为 null */
  message: string | null
  /** manifest id（用于 format 时识别 vueScaffold 等预置模板） */
  manifestId: string | null
}

/** 失败标记正则：文本错误 + npm 生命周期崩溃（ELIFECYCLE）+ 非零退出码（bash 首行「退出码 N」） */
const FAILURE_MARKERS = /npm error|npm ERR|ELIFECYCLE|错误|failed|不是内部或外部命令|退出码\s*[1-9]/i

/** 路径归一：反斜杠 → 正斜杠，再 lower（Windows 友好，与现状 fileHintsOf 一致） */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * 判断 createdFiles 中是否存在以指定 path 结尾的文件。
 * 兼容反斜杠与大小写（与现状 validateProjectCreation 第 1139-1141 行逐字等价）。
 */
function fileExistsInCreated(path: string, createdFiles: Set<string>): boolean {
  const target = normPath(path)
  for (const f of createdFiles) {
    const n = normPath(f)
    if (n.endsWith('/' + target) || n === target) return true
  }
  return false
}

/**
 * 判断 executedCommands 中是否存在匹配 command 正则/字符串的命令，且结果不含失败标记。
 * - 字符串：作为子串匹配（大小写不敏感）
 * - RegExp：用 test
 * 结果值为空串视为成功，非空串需不含 FAILURE_MARKERS。
 */
function commandSucceeded(
  command: string | RegExp,
  executedCommands: Map<string, string>
): boolean {
  const isMatch = (cmd: string): boolean =>
    typeof command === 'string'
      ? cmd.toLowerCase().includes(command.toLowerCase())
      : command.test(cmd)
  for (const [cmd, result] of executedCommands) {
    if (isMatch(cmd)) {
      // 命中后看结果：空串或不含失败标记视为通过
      if (result === '' || !FAILURE_MARKERS.test(result)) return true
    }
  }
  return false
}

/** 执行单条规则，返回结果 */
export function runRule(rule: ValidationRule, ctx: ValidationContext): ValidationResult {
  const severity: Severity = rule.severity ?? 'block'
  const fail = (message: string): ValidationResult => ({
    ruleId: rule.id,
    passed: false,
    message,
    severity
  })
  const pass = (): ValidationResult => ({
    ruleId: rule.id,
    passed: true,
    message: '',
    severity
  })

  switch (rule.kind) {
    case 'fileExists': {
      if (!rule.path) return fail(`规则 ${rule.id} 缺少 path 参数`)
      const ok = fileExistsInCreated(rule.path, ctx.createdFiles)
      return ok ? pass() : fail(rule.description)
    }
    case 'contentMatch': {
      // 二期 API 预留：纯函数层不读磁盘，contentMatch 需调用方在 ctx 中提供文件内容快照。
      // 本期 vueScaffoldManifest 不使用该 kind，仅作为占位与单测桩验证。
      if (!rule.path || !rule.pattern) return fail(`规则 ${rule.id} 缺少 path/pattern 参数`)
      return fail(rule.description)
    }
    case 'commandExecuted': {
      if (!rule.command) return fail(`规则 ${rule.id} 缺少 command 参数`)
      const ok = commandSucceeded(rule.command, ctx.executedCommands)
      return ok ? pass() : fail(rule.description)
    }
    case 'custom': {
      if (!rule.check) return fail(`规则 ${rule.id} 缺少 check 回调`)
      const r = rule.check(ctx)
      if (typeof r === 'boolean') {
        return r ? pass() : fail(rule.description)
      }
      return r.passed
        ? pass()
        : fail(r.message ?? rule.description)
    }
    default:
      return fail(`规则 ${rule.id} 未知 kind: ${rule.kind as string}`)
  }
}

/**
 * 执行 manifest 全部规则，聚合为 summary。
 * - manifest 为 null/空 → 直接返回 allPassed + message null（与现状非项目创建场景一致）
 * - severity=warn 的未通过项计入 failed，但不影响 allPassed
 */
export function runValidation(
  manifest: ArtifactManifest | null,
  ctx: ValidationContext
): ValidationSummary {
  if (!manifest || manifest.rules.length === 0) {
    return { allPassed: true, failed: [], message: null, manifestId: null }
  }
  const failed: ValidationResult[] = []
  let blocked = false
  for (const rule of manifest.rules) {
    const r = runRule(rule, ctx)
    if (!r.passed) {
      failed.push(r)
      if (r.severity === 'block') blocked = true
    }
  }
  // allPassed 仅在没有任何 block 级未通过时为 true
  const allPassed = !blocked
  const message = allPassed
    ? null
    : formatValidationMessage({ allPassed, failed, message: null, manifestId: manifest.id }, ctx)
  return { allPassed, failed, message, manifestId: manifest.id }
}

/**
 * 聚合为给模型的强制继续消息。
 * - vueScaffold manifest 未通过时输出与旧 validateProjectCreation 逐字对齐的模板（含「当前已创建 N 个文件」尾巴）
 * - 其他 manifest 未通过时输出通用模板
 * - allPassed 时返回 null
 * - ctx 可选：vueScaffold 模板需要 ctx.createdFiles.size 拼尾巴；缺省时尾巴省略
 */
export function formatValidationMessage(
  summary: ValidationSummary,
  ctx?: ValidationContext
): string | null {
  if (summary.allPassed) return null
  if (summary.failed.length === 0) return null
  // 逐条列出缺失项：- <ruleId>: <缺失描述>，比顿号连接更易 AI 定向补齐
  const items = summary.failed.map((r) => `- ${r.ruleId}: ${r.message || r.ruleId}`).join('\n')

  if (summary.manifestId === 'vue-scaffold') {
    const tail =
      ctx && ctx.createdFiles.size >= 0
        ? `（当前已创建 ${ctx.createdFiles.size} 个文件）。`
        : '。'
    return `🚫 验证锁未通过，缺失项：\n${items}\n\n` +
      `除非所有关键文件已创建且 npm install + npm run serve 均已执行成功，否则严禁输出"任务完成"或结束循环。` +
      `请立即调用工具补齐缺失项${tail}` +
      `\n提示：若命令已执行但失败，真实报错在最近一次工具输出的 stderr 中（常见：package.json JSON 非法、` +
      `main.js 重复声明、App.vue 模板未闭合）。先 read 定位问题文件，再用 edit 精准修复后重跑验证命令。`
  }
  return `🚫 验证锁未通过，缺失项：\n${items}\n\n请立即调用工具补齐缺失项。`
}

/**
 * 从计划文本/对象解析 manifest（二期未做自动注入，本函数仅作为占位与单测入口）。
 * - 合法的 ArtifactManifest 对象（含 id + rules 数组）→ 原样返回
 * - 其他输入 → null
 */
export function parseManifest(raw: unknown): ArtifactManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || !Array.isArray(obj.rules)) return null
  const rules: ValidationRule[] = []
  for (const r of obj.rules) {
    if (!r || typeof r !== 'object') continue
    const rr = r as Record<string, unknown>
    if (
      typeof rr.id !== 'string' ||
      typeof rr.description !== 'string' ||
      typeof rr.kind !== 'string'
    ) {
      continue
    }
    rules.push(rr as unknown as ValidationRule)
  }
  if (rules.length === 0) return null
  return { id: obj.id, rules }
}
