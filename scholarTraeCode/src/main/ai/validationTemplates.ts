// 任务验证模板库（纯函数层）：ArtifactManifest 从单一 vueScaffold 预置扩展到多语言模板。
//
// 每个模板是一组预置 ValidationRule，覆盖该生态项目的关键产物（文件存在 + 命令执行成功）。
// generatePlan 提示词声明可用模板 id，AI 可在 plan 末尾用 `template: <id>` 引用，
// extractManifestFromPlan 解析时从 TEMPLATE_REGISTRY 取深拷贝，允许 AI 追加自定义 rules。
//
// 零 IO：模板只声明规则，执行由 validation.ts 的 runValidation 完成。

import type { ArtifactManifest } from './validation'

/**
 * Vue2 脚手架 6 项（原 5 项 + 编译验证）。
 * id 保持 'vue-scaffold' 以兼容 formatValidationMessage 的专有分支。
 *
 * vue-build-check（编译验证）：文件存在 ≠ 项目可用——必须至少一次 build/serve/vue-tsc
 * 以退出码 0 结束，才能证明 main.js/App.vue 无语法错误（语法预检拦截之外的最后一道锁）。
 */
export const vueScaffoldManifest: ArtifactManifest = {
  id: 'vue-scaffold',
  rules: [
    { id: 'vue-pkg', description: 'package.json', kind: 'fileExists', path: 'package.json' },
    { id: 'vue-main', description: 'src/main.js', kind: 'fileExists', path: 'src/main.js' },
    { id: 'vue-app', description: 'src/App.vue', kind: 'fileExists', path: 'src/App.vue' },
    { id: 'vue-install', description: 'npm install 未执行', kind: 'commandExecuted', command: /\bnpm\s+(install|i)\b/ },
    { id: 'vue-serve', description: 'npm run serve 未执行', kind: 'commandExecuted', command: /\bnpm\s+run\s+(serve|dev)\b/ },
    { id: 'vue-build-check', description: '编译验证未执行（npm run build / serve / vue-tsc 需成功）', kind: 'commandExecuted', command: /\bnpm\s+run\s+(build|serve|dev)\b|\bvue-tsc\b/ }
  ]
}

/** Node.js 服务项目：package.json + 入口文件 + npm install + 启动验证 */
const nodeServiceManifest: ArtifactManifest = {
  id: 'node-service',
  rules: [
    { id: 'node-pkg', description: 'package.json', kind: 'fileExists', path: 'package.json' },
    { id: 'node-entry', description: '入口文件（index.js / src/index.js）', kind: 'fileExists', path: 'index.js' },
    { id: 'node-install', description: 'npm install 未执行', kind: 'commandExecuted', command: /\bnpm\s+(install|i)\b/ },
    { id: 'node-start', description: 'npm start / node 入口 未执行', kind: 'commandExecuted', command: /\bnpm\s+(start|run\s+dev)|node\s+\S+\.js\b/ }
  ]
}

/** Python 项目：requirements.txt + 入口 .py + venv 安装依赖 + 运行验证 */
const pythonProjectManifest: ArtifactManifest = {
  id: 'python-project',
  rules: [
    { id: 'py-req', description: 'requirements.txt', kind: 'fileExists', path: 'requirements.txt' },
    { id: 'py-entry', description: '入口 Python 文件（main.py / app.py）', kind: 'fileExists', path: 'main.py' },
    { id: 'py-install', description: 'pip install -r requirements.txt 未执行', kind: 'commandExecuted', command: /\bpip\s+install\s+-r\b/ },
    { id: 'py-run', description: 'python 入口脚本未执行', kind: 'commandExecuted', command: /\bpython(\.exe)?\s+\S+\.py\b/ }
  ]
}

/** Go 项目：go.mod + main.go + go mod tidy 依赖整理 + go build 验证 */
const goProjectManifest: ArtifactManifest = {
  id: 'go-project',
  rules: [
    { id: 'go-mod', description: 'go.mod', kind: 'fileExists', path: 'go.mod' },
    { id: 'go-main', description: 'main.go', kind: 'fileExists', path: 'main.go' },
    { id: 'go-tidy', description: 'go mod tidy 未执行', kind: 'commandExecuted', command: /\bgo\s+mod\s+tidy\b/ },
    { id: 'go-build', description: 'go build 未执行', kind: 'commandExecuted', command: /\bgo\s+build\b/ }
  ]
}

/** Rust 项目：Cargo.toml + src/main.rs + cargo build 验证 */
const rustProjectManifest: ArtifactManifest = {
  id: 'rust-project',
  rules: [
    { id: 'rust-toml', description: 'Cargo.toml', kind: 'fileExists', path: 'Cargo.toml' },
    { id: 'rust-main', description: 'src/main.rs', kind: 'fileExists', path: 'src/main.rs' },
    { id: 'rust-build', description: 'cargo build 未执行', kind: 'commandExecuted', command: /\bcargo\s+build\b/ }
  ]
}

/** Docker 服务：Dockerfile + docker-compose.yml + compose config 校验 */
const dockerServiceManifest: ArtifactManifest = {
  id: 'docker-service',
  rules: [
    { id: 'docker-dockerfile', description: 'Dockerfile', kind: 'fileExists', path: 'Dockerfile' },
    { id: 'docker-compose', description: 'docker-compose.yml', kind: 'fileExists', path: 'docker-compose.yml' },
    { id: 'docker-config', description: 'docker compose config 校验未执行', kind: 'commandExecuted', command: /\bdocker\s+compose\s+config\b/ }
  ]
}

/** 模板注册表：id → manifest 深拷贝工厂（避免调用方修改污染单例） */
export const TEMPLATE_REGISTRY: Record<string, () => ArtifactManifest> = {
  'vue-scaffold': () => deepClone(vueScaffoldManifest),
  'vue-project': () => deepClone(vueScaffoldManifest),
  'node-service': () => deepClone(nodeServiceManifest),
  'python-project': () => deepClone(pythonProjectManifest),
  'python-service': () => deepClone(pythonProjectManifest),
  'go-project': () => deepClone(goProjectManifest),
  'go-cli': () => deepClone(goProjectManifest),
  'rust-project': () => deepClone(rustProjectManifest),
  'rust-app': () => deepClone(rustProjectManifest),
  'docker-service': () => deepClone(dockerServiceManifest),
  'docker-compose': () => deepClone(dockerServiceManifest)
}

/** 可用模板 id 清单（供 generatePlan 提示词注入） */
export const AVAILABLE_TEMPLATE_IDS = Object.keys(TEMPLATE_REGISTRY)

/**
 * 按 id 取模板深拷贝；不存在返回 null。
 */
export function getTemplate(id: string): ArtifactManifest | null {
  const factory = TEMPLATE_REGISTRY[id]
  return factory ? factory() : null
}

/**
 * 解析带 template 引用的 manifest 对象：
 * - 若对象含 `"template": "<id>"`，取模板深拷贝，并把对象中额外声明的 rules 追加到模板规则后（自定义扩展）。
 * - 否则返回 null（由调用方按内联 JSON 自行 parseManifest）。
 */
export function resolveTemplateReference(obj: Record<string, unknown>): ArtifactManifest | null {
  const tplId = obj.template
  if (typeof tplId !== 'string') return null
  const base = getTemplate(tplId)
  if (!base) return null
  // 允许 AI 追加自定义 rules（覆盖式合并：模板规则 + 自定义 rules）
  if (Array.isArray(obj.rules)) {
    for (const r of obj.rules) {
      if (r && typeof r === 'object') base.rules.push(r as any)
    }
  }
  // 若 AI 显式给了 id，用 AI 的；否则用模板 id
  if (typeof obj.id === 'string') base.id = obj.id
  return base
}

/** 深拷贝 manifest（rules 数组 + 每个 rule 对象），避免模板单例被调用方修改 */
function deepClone(m: ArtifactManifest): ArtifactManifest {
  return {
    id: m.id,
    rules: m.rules.map((r) => ({ ...r }))
  }
}
