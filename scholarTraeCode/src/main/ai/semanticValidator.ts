// 语义验证器（L3 层）：依赖闭环检查 + Coder 修复补丁生成/解析/预检。
// 分层验证链：L1 语法（syntaxGuard）→ L2 结构（validation.ts 验证锁）→ L3 语义（本模块）→ L4 运行时（runtimeValidator）。
// 纯函数层：import/require 提取、依赖差集、补丁解析；模型调用与 staging 落盘编排在 scheduler。

import { validateSyntaxBeforeWrite } from './syntaxGuard'
import { resolveVfsPath } from './virtualFs'

/** 依赖闭环问题：某包被 import/require 但未在 package.json 声明 */
export interface DependencyIssue {
  /** 缺失的包名（归一化后，如 @scope/pkg 或 pkg） */
  package: string
  /** 引用该包的文件清单（相对路径，排序去重） */
  referencedBy: string[]
}

/** Coder 补丁：完整文件内容（非 diff） */
export interface CoderPatch {
  file: string
  content: string
}

/** Node 内置模块（含子路径前缀判定，如 fs/promises → fs） */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib'
])

/**
 * 包名归一化：
 * - 相对路径（./ ../）/ 绝对路径 / 盘符路径 → null（跳过）
 * - node: 前缀 → null（内置模块）
 * - @/ 别名（webpack/vite src 别名）→ null
 * - @scope/pkg/sub → @scope/pkg
 * - pkg/sub → pkg
 */
export function normalizePackageName(spec: string): string | null {
  if (!spec) return null
  if (spec.startsWith('.') || spec.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(spec)) return null
  if (spec.startsWith('node:')) return null
  if (spec.startsWith('@/')) return null
  const parts = spec.split('/')
  if (spec.startsWith('@')) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0] || null
}

/** 从源码文本提取 import / export from / require / 动态 import 的模块说明符（未归一化） */
export function extractImportSpecifiers(content: string): string[] {
  const specs: string[] = []
  const patterns = [
    // import ... from 'x'（含裸 import 'x' 与 import {a,b} from 'x'）
    /\bimport\s+(?:[\w$]+|\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+\s*,\s*\{[^}]*\}|[\w$]+\s*,\s*\*\s+as\s+[\w$]+)?\s*(?:from\s+)?['"]([^'"]+)['"]/g,
    // export ... from 'x'（含 export * from 'x'）
    /\bexport\s+(?:[\w$]+|\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g,
    // require('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // 动态 import('x')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      specs.push(m[1])
    }
  }
  return specs
}

/**
 * 依赖闭环检查：files 中所有 import/require 包名与 package.json 声明求差集。
 * @param files 相对路径 → 文件内容
 * @param packageJsonContent package.json 文本（JSON 解析失败视为无声明）
 */
export function checkDependencyClosure(
  files: ReadonlyMap<string, string> | Record<string, string>,
  packageJsonContent: string
): DependencyIssue[] {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files)
  const declared = new Set<string>()
  try {
    const pkg = JSON.parse(packageJsonContent) as Record<string, unknown>
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[key]
      if (deps && typeof deps === 'object') {
        for (const name of Object.keys(deps as Record<string, unknown>)) declared.add(name)
      }
    }
  } catch {
    // package.json 解析失败：declared 保持空集，所有外部引用都会报缺失
  }

  const byPackage = new Map<string, Set<string>>()
  for (const [file, content] of entries) {
    if (!content) continue
    for (const spec of extractImportSpecifiers(content)) {
      const name = normalizePackageName(spec)
      if (!name || NODE_BUILTINS.has(name) || declared.has(name)) continue
      if (!byPackage.has(name)) byPackage.set(name, new Set())
      byPackage.get(name)!.add(file)
    }
  }
  return [...byPackage.entries()]
    .map(([pkg, refs]) => ({ package: pkg, referencedBy: [...refs].sort() }))
    .sort((a, b) => a.package.localeCompare(b.package))
}

/**
 * 构建发给 Coder 的修复提示词：缺失依赖清单 + 相关文件内容（超长截断）。
 * 要求 Coder 逐文件输出完整修复内容（```patch JSON 块）。
 */
export function buildCoderRepairPrompt(
  issues: DependencyIssue[],
  files: ReadonlyMap<string, string> | Record<string, string>
): string {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files)
  const issueLines = issues
    .map((i) => `- ${i.package}（被 ${i.referencedBy.join('、')} 引用）`)
    .join('\n')
  const fileBlocks = entries
    .map(([file, content]) => {
      const truncated = content.length > 3000 ? `${content.slice(0, 3000)}\n...(截断)` : content
      return `### ${file}\n\`\`\`\n${truncated}\n\`\`\``
    })
    .join('\n\n')
  return [
    '【L3 语义验证】以下文件引用了未在 package.json 声明的依赖包：',
    '',
    issueLines,
    '',
    '相关文件内容：',
    '',
    fileBlocks,
    '',
    '请修复依赖闭环：为每个需要修改的文件输出修复后的完整内容（不使用 diff）。',
    '输出格式：每个文件用 ```patch {"file":"相对路径","content":"完整内容"}``` 代码块包裹。',
    '注意：只修复依赖导入问题，不要改动业务逻辑；若应改用已声明的等价包，请替换 import 来源；',
    '若缺失包确实需要安装，不要修改 package.json——在输出中只修正引用侧。'
  ].join('\n')
}

/**
 * 解析 Coder 返回的补丁块。
 * 格式：```patch {"file":"相对路径","content":"完整内容"}```
 */
export function parseCoderPatches(
  text: string
): { ok: true; patches: CoderPatch[] } | { ok: false; error: string } {
  const blocks = [...text.matchAll(/```patch\s*\n([\s\S]*?)```/g)]
  if (blocks.length === 0) return { ok: false, error: '未找到 ```patch 代码块' }
  const patches: CoderPatch[] = []
  for (let i = 0; i < blocks.length; i++) {
    const raw = blocks[i][1].trim()
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch (e) {
      return {
        ok: false,
        error: `第 ${i + 1} 个 patch 块 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`
      }
    }
    if (typeof obj !== 'object' || obj === null) {
      return { ok: false, error: `第 ${i + 1} 个 patch 块不是 JSON 对象` }
    }
    const { file, content } = obj as Record<string, unknown>
    if (typeof file !== 'string' || !file.trim()) {
      return { ok: false, error: `第 ${i + 1} 个 patch 块缺少 file 字段` }
    }
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: `第 ${i + 1} 个 patch 块 content 为空` }
    }
    patches.push({ file: file.trim(), content })
  }
  return { ok: true, patches }
}

/**
 * 补丁预检：targetDir 边界（resolveVfsPath）+ 语法检查（syntaxGuard）。
 * 全部通过返回 ok；任一失败返回首个错误。
 */
export async function validatePatches(
  patches: CoderPatch[],
  opts: { workspace: string; targetDir: string | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const p of patches) {
    const vfs = resolveVfsPath(p.file, opts.workspace, opts.targetDir)
    if (!vfs.ok) return { ok: false, error: `补丁路径越界（${p.file}）：${vfs.error}` }
    const syntaxErr = await validateSyntaxBeforeWrite(vfs.absPath, p.content)
    if (syntaxErr) return { ok: false, error: `补丁语法预检失败（${p.file}）：${syntaxErr}` }
  }
  return { ok: true }
}
