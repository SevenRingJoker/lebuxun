// DAG 静态审查器：在 Planner 生成 DAG 后、执行前做纯函数静态检查，
// 拦截非标准节点（如 example.txt）和越序命令（如 npm install vue@2.7.16），
// 避免问题进入执行层浪费轮次。
import type { TaskDag } from './taskDag'
import type { ProjectProfile } from '../../shared/projectProfiles'

export interface DagValidationResult {
  ok: boolean
  error?: string
  warnings: string[]
}

/** 禁止的文件名模式：测试性/示例性文件不应出现在正式项目中 */
export const FORBIDDEN_FILE_RE = /(^|\/)(example|test|temp|tmp|demo|sample)\.(txt|md|json|js|ts)$/i

/** 禁止的命令模式 */
export const FORBIDDEN_CMD_PATTERNS: { re: RegExp; hint: string }[] = [
  {
    re: /\bnpm\s+(install|i)\s+[@a-z][a-z0-9-]*@[\d.]+/i,
    hint: '禁止用 npm install <pkg>@<ver> 直接装包（应通过 package.json 声明依赖后执行 npm install）'
  },
  {
    re: /\bnpm\s+(install|i)\s+(-g|--global)\b/i,
    hint: '禁止全局安装（npm install -g），依赖必须声明在 package.json 中'
  },
  {
    re: /\bnpm\s+(init|create)\b/i,
    hint: '禁止 npm init/create 生成空壳清单，必须用 write_file 直接写 package.json'
  },
  {
    re: /\byarn\s+(init|create)\b/i,
    hint: '禁止 yarn init/create，必须用 write_file 直接写 package.json'
  },
  {
    re: /\bpnpm\s+(init|create)\b/i,
    hint: '禁止 pnpm init/create，必须用 write_file 直接写 package.json'
  }
]

/** 工具执行层轻量检查：命中禁止文件名时返回提示文案，否则 null */
export function findForbiddenFile(path: string): string | null {
  if (path && FORBIDDEN_FILE_RE.test(path)) {
    return `【禁止文件拦截】${path} 属于测试性文件，禁止写入。项目只允许创建标准结构文件（package.json、src/main.js 等）。`
  }
  return null
}

/** 工具执行层轻量检查：命中禁止命令时返回提示文案，否则 null */
export function findForbiddenCommand(cmd: string): string | null {
  if (!cmd) return null
  for (const { re, hint } of FORBIDDEN_CMD_PATTERNS) {
    if (re.test(cmd)) return `【禁止命令拦截】${hint}（命令: ${cmd}）`
  }
  return null
}

/**
 * 从 ProjectProfile 推断关键文件列表（用于检查 DAG 是否包含必要的 write_file 节点）
 */
function deriveKeyFiles(profile: ProjectProfile | null | undefined): string[] {
  if (!profile) return []
  const files: string[] = []
  if (profile.dependencyManifest) files.push(profile.dependencyManifest)
  if (profile.configFiles) files.push(...profile.configFiles)
  // 源码目录本身不是文件，但常见的入口文件需要检查
  if (profile.sourceDir) {
    // 常见入口文件（按语言/框架推断）
    const src = profile.sourceDir.replace(/\/$/, '')
    if (profile.id === 'vue' || profile.id === 'react' || profile.id === 'node') {
      files.push(`${src}/main.js`, `${src}/main.ts`, `${src}/index.js`, `${src}/index.ts`)
    } else if (profile.id === 'python') {
      files.push(`${src}/main.py`, 'main.py', 'app.py')
    } else if (profile.id === 'go') {
      files.push('main.go', 'cmd/main.go')
    } else if (profile.id === 'rust') {
      files.push('src/main.rs', 'src/lib.rs')
    }
  }
  return [...new Set(files)]
}

/**
 * 对 DAG 做静态审查：检查禁止模式 + 关键产物节点齐全性。
 * @param dag 待审查的 DAG
 * @param profile 项目画像（可为 null，此时跳过关键产物检查）
 * @param targetDir 目标子目录（如 vue2-project），用于路径前缀匹配
 */
export function validateDagStatic(
  dag: TaskDag,
  profile: ProjectProfile | null | undefined,
  targetDir: string | null | undefined
): DagValidationResult {
  const warnings: string[] = []

  for (const node of dag.nodes) {
    const path = String(node.args?.path ?? '')
    const cmd = String(node.args?.command ?? '')

    // 1. 禁止的文件名模式
    if (path && FORBIDDEN_FILE_RE.test(path)) {
      warnings.push(`节点 ${node.id}: 禁止创建测试性文件 ${path}`)
    }

    // 2. 禁止的命令模式
    if (cmd) {
      for (const { re, hint } of FORBIDDEN_CMD_PATTERNS) {
        if (re.test(cmd)) {
          warnings.push(`节点 ${node.id}: ${hint}（命令: ${cmd}）`)
        }
      }
    }
  }

  // 3. 关键产物节点检查（仅当 profile 存在时）
  if (profile) {
    const requiredFiles = deriveKeyFiles(profile)
    for (const req of requiredFiles) {
      const hasNode = dag.nodes.some((n) => {
        const p = String(n.args?.path ?? '').replace(/\\/g, '/').toLowerCase()
        return p.endsWith(req.toLowerCase())
      })
      if (!hasNode) {
        warnings.push(`DAG 缺少关键文件节点：${req}`)
      }
    }
  }

  // 判定：「禁止」类警告视为错误（ok=false），「缺少关键文件」视为警告（仅提示）
  const hasForbidden = warnings.some((w) => w.includes('禁止'))
  return {
    ok: !hasForbidden,
    error: hasForbidden ? warnings.filter((w) => w.includes('禁止')).join('；') : undefined,
    warnings
  }
}
