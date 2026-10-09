// 项目画像（Project Profile）注册表：把「不同语言/生态的规矩」抽象为数据，
// 替代 if (isVue) 式硬编码。门控（bashGate）、重规划（replanner）、提示词（promptBuilder）、
// 秒退诊断（commandError）、前端强制重置话术（chat.ts）统一从本注册表取数。
//
// 纯数据 + 纯函数，零 IO：main 与 renderer 均可安全引用（@shared 别名或相对路径）。

/** 项目画像：一个生态的依赖声明、配置、源码布局与命令纪律 */
export interface ProjectProfile {
  /** 画像 id（vue/react/node/python/go/rust/java-maven/java-gradle/docker/generic） */
  id: string
  /** 语言大类 */
  language: 'node' | 'python' | 'go' | 'rust' | 'java' | 'cpp' | 'generic'
  /** 中文展示名（话术/提示词用） */
  displayName: string
  /** 依赖声明文件（如 package.json / requirements.txt / go.mod） */
  dependencyManifest: string
  /** 配置文件清单（如 vue.config.js / pyproject.toml / Cargo.toml） */
  configFiles: string[]
  /** 源码目录（如 src/、cmd/；无固定目录为空串） */
  sourceDir: string
  /** 初始化（依赖安装/整理）命令——展示与话术用 */
  initCommands: string[]
  /** 运行/验证命令——展示与话术用 */
  runCommands: string[]
  /** 禁止的全局安装命令——话术展示用（提醒模型不要污染环境） */
  forbidGlobalInstall: string[]
  /** 依赖安装命令匹配器（门控与成功置位用；自带全局安装排除） */
  initPattern?: RegExp
  /** 运行命令匹配器（硬拦全集：依赖目录确认缺失时拦截，任何场景生效） */
  runPattern?: RegExp
  /** 主运行命令匹配器（软拦子集：仅项目创建场景且未做磁盘探测时拦截） */
  primaryRunPattern?: RegExp
  /** 需要 manifest 前置的命令匹配器（项目创建场景基于 createdFiles 判定） */
  manifestRequiredPattern?: RegExp
  /** 依赖目录名（node_modules / venv；磁盘探测用，无可缺省） */
  depsDir?: string
  /** 缺失 manifest 的拦截文案（前置校验失败反馈） */
  manifestHint?: string
  /** 依赖未就绪时运行命令的硬拦文案（cmdHead 为命令首段） */
  runNotReadyHint?: (cmdHead: string) => string
  /** 项目创建场景主运行命令的软拦文案 */
  runSoftHint?: (cmdHead: string) => string
  /**
   * 清单生成器禁令：命中即拦截（如 npm init -y 生成无 dependencies 的空壳 package.json，
   * 会让后续 npm install 被误判放行）。强制模型用 write_file 写完整清单。
   */
  banManifestGen?: { re: RegExp; hint: string }
  /** 清单存在但内容无效（空文件 / node 缺 dependencies）时的拦截文案 */
  manifestEmptyHint?: string
}

// ============ Node.js 生态（门控画像：vue/react/node 通用 npm 顺序锁） ============

/** npm 安装命令（排除全局安装；npm init/create 天然不匹配） */
const NPM_INSTALL_RE = /\bnpm\s+(install|i)\b(?!.*\s-g\b)(?!.*\s--global\b)/

export const NODE_GATE_PROFILE: ProjectProfile = {
  id: 'node',
  language: 'node',
  displayName: 'Node.js',
  dependencyManifest: 'package.json',
  configFiles: [],
  sourceDir: 'src/',
  initCommands: ['npm install'],
  runCommands: ['npm run serve', 'npm run build'],
  forbidGlobalInstall: ['npm install -g', 'npm i -g', 'yarn global add', 'pnpm add -g'],
  initPattern: NPM_INSTALL_RE,
  runPattern: /\bnpm\s+run\s+[^\s&|]+/,
  primaryRunPattern: /\bnpm\s+run\s+(serve|dev|start)\b|\byarn\s+(serve|dev)\b/,
  manifestRequiredPattern: NPM_INSTALL_RE,
  depsDir: 'node_modules',
  manifestHint:
    '错误：当前目录缺少 package.json，无法执行 npm install（含 npm install <包名>，如 npm install vue@2.7.16）。' +
    '请先使用 write_file 创建 package.json（含 name/scripts/dependencies 的完整内容），package.json 落盘后再执行安装。',
  runNotReadyHint: (cmdHead) =>
    '错误：拦截：依赖尚未安装（node_modules 不存在且未成功执行过 npm install），' +
    `此时执行 ${cmdHead} 必然秒退失败。` +
    '请先确认 package.json 已创建并成功执行 npm install，安装完成后再运行脚本（顺序锁）。',
  runSoftHint: (cmdHead) =>
    /\byarn\b/.test(cmdHead)
      ? '错误：依赖尚未安装（未成功执行 npm/yarn install），此时启动开发服务器必然失败。请先完成依赖安装（顺序锁）。'
      : '错误：依赖尚未安装（未成功执行 npm install），此时启动开发服务器必然失败。请先完成 npm install（顺序锁）。',
  // 封杀 npm init -y / npm init --yes / 裸 npm init：生成的空壳 package.json 无 dependencies，
  // 会让内容级校验失效、顺序锁被误判放行（npm init <pkg> 脚手架仍走交互式拦截，不受影响）
  banManifestGen: {
    re: /\bnpm\s+init\b(?:\s+(?:-y|--yes)\b|\s*$|\s*[;&|])/,
    hint:
      '【前置校验失败】禁止使用 npm init（含 -y/--yes）生成默认空壳 package.json——' +
      '它不含 dependencies，会导致后续安装/运行全部秒退。' +
      '请直接使用 write_file 写入完整的 package.json（必须含 name、scripts、dependencies 字段），然后再执行 npm install。'
  },
  manifestEmptyHint:
    '【前置校验失败】package.json 已存在但缺少 dependencies 字段（疑似 npm init -y 生成的空壳），' +
    'npm install 无依赖可装。请使用 write_file 重写完整的 package.json（含 dependencies 声明全部依赖包），然后再执行 npm install。'
}

// ============ 生态预设注册表 ============

/** 通用前置校验失败文案：【前置校验失败】当前目录缺少 X 依赖声明文件 Y。请先使用 write_file 创建该文件。 */
function manifestHintOf(displayName: string, manifest: string, extra = ''): string {
  return `【前置校验失败】当前目录缺少 ${displayName} 依赖声明文件 ${manifest}。请先使用 write_file 创建该文件${extra}。`
}

const vueProfile: ProjectProfile = {
  ...NODE_GATE_PROFILE,
  id: 'vue',
  displayName: 'Vue',
  configFiles: ['vue.config.js', 'babel.config.js'],
  initCommands: ['npm install'],
  runCommands: ['npm run serve', 'npm run build']
}

const reactProfile: ProjectProfile = {
  ...NODE_GATE_PROFILE,
  id: 'react',
  displayName: 'React',
  configFiles: ['vite.config.js'],
  initCommands: ['npm install'],
  runCommands: ['npm run dev', 'npm run build']
}

const pythonProfile: ProjectProfile = {
  id: 'python',
  language: 'python',
  displayName: 'Python',
  dependencyManifest: 'requirements.txt',
  configFiles: ['pyproject.toml'],
  sourceDir: '',
  initCommands: ['pip install -r requirements.txt'],
  runCommands: ['python main.py'],
  forbidGlobalInstall: ['sudo pip install', 'pip install --break-system-packages'],
  initPattern: /\bpip\s+install\s+-r\b/,
  manifestRequiredPattern: /\bpip\s+install\s+-r\b/,
  depsDir: 'venv',
  manifestHint: manifestHintOf('Python', 'requirements.txt', '（每行一个依赖包名）')
}

const goProfile: ProjectProfile = {
  id: 'go',
  language: 'go',
  displayName: 'Go',
  dependencyManifest: 'go.mod',
  configFiles: [],
  sourceDir: 'cmd/',
  initCommands: ['go mod tidy'],
  runCommands: ['go build', 'go run .'],
  forbidGlobalInstall: ['go install <包>@latest'],
  initPattern: /\bgo\s+mod\s+tidy\b/,
  // go build 等编译/运行命令在缺 go.mod 时同样无法执行，一并要求 manifest 已创建
  runPattern: /\bgo\s+(build|run|test|vet)\b/,
  // go build/go run 为主运行命令：项目创建场景依赖未就绪时软拦提示先初始化
  primaryRunPattern: /\bgo\s+(build|run)\b/,
  manifestRequiredPattern: /\bgo\s+(build|run|test|mod\s+tidy|vet)\b/,
  manifestHint: manifestHintOf('Go', 'go.mod', '（首行 module <模块名>）'),
  runNotReadyHint: (cmdHead: string) =>
    `【前置校验失败】当前目录缺少 Go 依赖声明文件 go.mod（或依赖尚未初始化），无法执行 ${cmdHead}。请先使用 write_file 创建 go.mod（首行 module <模块名>），再执行 go mod tidy。`,
  runSoftHint: (cmdHead: string) =>
    `【前置校验失败】当前目录缺少 Go 依赖声明文件 go.mod（或依赖尚未初始化），无法执行 ${cmdHead}。请先使用 write_file 创建 go.mod（首行 module <模块名>），再执行 go mod tidy。`
}

const rustProfile: ProjectProfile = {
  id: 'rust',
  language: 'rust',
  displayName: 'Rust',
  dependencyManifest: 'Cargo.toml',
  configFiles: [],
  sourceDir: 'src/',
  initCommands: ['cargo fetch'],
  runCommands: ['cargo build', 'cargo run'],
  forbidGlobalInstall: ['cargo install'],
  initPattern: /\bcargo\s+(fetch|build)\b/,
  manifestRequiredPattern: /\bcargo\s+(build|run|test|check|fetch)\b/,
  manifestHint: manifestHintOf('Rust', 'Cargo.toml', '（含 [package] 与 [dependencies]）')
}

const javaMavenProfile: ProjectProfile = {
  id: 'java-maven',
  language: 'java',
  displayName: 'Java（Maven）',
  dependencyManifest: 'pom.xml',
  configFiles: [],
  sourceDir: 'src/main/java/',
  initCommands: ['mvn compile'],
  runCommands: ['mvn package'],
  forbidGlobalInstall: [],
  initPattern: /\bmvn\s+(compile|install)\b/,
  manifestRequiredPattern: /\bmvn\s+(compile|package|install)\b/,
  manifestHint: manifestHintOf('Java（Maven）', 'pom.xml')
}

const javaGradleProfile: ProjectProfile = {
  id: 'java-gradle',
  language: 'java',
  displayName: 'Java（Gradle）',
  dependencyManifest: 'build.gradle',
  configFiles: ['settings.gradle'],
  sourceDir: 'src/main/java/',
  initCommands: ['gradle build'],
  runCommands: ['gradle run'],
  forbidGlobalInstall: [],
  initPattern: /\bgradle\s+build\b/,
  manifestRequiredPattern: /\bgradle\s+(build|run)\b/,
  manifestHint: manifestHintOf('Java（Gradle）', 'build.gradle')
}

const dockerProfile: ProjectProfile = {
  id: 'docker',
  language: 'generic',
  displayName: 'Docker',
  dependencyManifest: 'docker-compose.yml',
  configFiles: ['Dockerfile'],
  sourceDir: '',
  initCommands: ['docker compose config'],
  runCommands: ['docker compose up'],
  forbidGlobalInstall: [],
  initPattern: /\bdocker\s+compose\s+config\b/,
  manifestRequiredPattern: /\bdocker\s+compose\s+(up|build|config)\b/,
  manifestHint: manifestHintOf('Docker', 'docker-compose.yml', '（编排文件）')
}

/** 通用兜底画像：无 manifest 门控，仅提供话术骨架 */
const genericProfile: ProjectProfile = {
  id: 'generic',
  language: 'generic',
  displayName: '通用',
  dependencyManifest: '',
  configFiles: [],
  sourceDir: 'src/',
  initCommands: [],
  runCommands: [],
  forbidGlobalInstall: []
}

/** 画像注册表：id → 画像（门控/话术/提示词统一数据源） */
export const PROFILE_REGISTRY: Record<string, ProjectProfile> = {
  vue: vueProfile,
  react: reactProfile,
  node: NODE_GATE_PROFILE,
  python: pythonProfile,
  go: goProfile,
  rust: rustProfile,
  'java-maven': javaMavenProfile,
  'java-gradle': javaGradleProfile,
  docker: dockerProfile,
  generic: genericProfile
}

/** 按 id 取画像；未知 id 返回 generic */
export function getProfile(id: string): ProjectProfile {
  return PROFILE_REGISTRY[id] ?? genericProfile
}

/** 参与 createdFiles 依赖图谱门控的画像（node 走独立硬锁，此处不含 node 系） */
export const MANIFEST_GATE_PROFILES: ProjectProfile[] = [
  pythonProfile,
  goProfile,
  rustProfile,
  javaMavenProfile,
  javaGradleProfile,
  dockerProfile
]

// ============ 检测 / 绑定 ============

/**
 * 按用户请求文本识别项目画像（生成 plan 时绑定）。
 * 关键词从具体到通用匹配；识别不出返回 generic（不瞎绑，由 AI 按通用流程执行）。
 */
export function detectProfileFromText(text: string): ProjectProfile {
  const t = (text || '').toLowerCase()
  if (/\bvue\s*2|vue@2/.test(t)) return vueProfile
  if (/\bvue\s*3|vue@3|\bvue\b/.test(t)) return vueProfile
  if (/\breact\b|next\.?js/.test(t)) return reactProfile
  if (/\bpython\b|django|flask|fastapi|\.py\b/.test(t)) return pythonProfile
  if (/\bgolang\b|\bgo\s+(web|服务|cli|项目)/.test(t) || /\bgo\b(?![a-z])/.test(t)) return goProfile
  if (/\brust\b|cargo/.test(t)) return rustProfile
  if (/docker|容器化|docker-compose/.test(t)) return dockerProfile
  if (/\bmaven\b|pom\.xml|spring/.test(t)) return javaMavenProfile
  if (/\bgradle\b/.test(t)) return javaGradleProfile
  if (/\bnode\b|express|koa|npm/.test(t)) return NODE_GATE_PROFILE
  return genericProfile
}

/** 按命令文本推断所属生态（秒退诊断等场景使用；识别不出返回 generic） */
export function detectProfileForCommand(command: string): ProjectProfile {
  const c = (command || '').toLowerCase()
  if (/\bnpm\b|\byarn\b|\bpnpm\b|\bnode\b|\bnpx\b/.test(c)) return NODE_GATE_PROFILE
  if (/\bpip\b|\bpython/.test(c)) return pythonProfile
  if (/\bcargo\b|\brustc\b/.test(c)) return rustProfile
  if (/\bgo\s+(build|run|test|mod)/.test(c)) return goProfile
  if (/\bdocker\b/.test(c)) return dockerProfile
  if (/\bmvn\b|\bgradle\b/.test(c)) return javaMavenProfile
  return genericProfile
}

/**
 * 按产物文件名清单推断画像（前端「重试任务」按缺失产物反推生态）。
 * 缺省返回 node：FORCED-RECOVERY 场景的历史主流是 npm 生态，话术兼容现状。
 */
export function detectProfileFromArtifacts(paths: string[]): ProjectProfile {
  const names = paths.map((p) => p.replace(/\\/g, '/').toLowerCase())
  const has = (re: RegExp) => names.some((n) => re.test(n))
  if (has(/requirements\.txt|\.py\b/)) return pythonProfile
  if (has(/go\.mod|\.go\b/)) return goProfile
  if (has(/cargo\.toml|\.rs\b/)) return rustProfile
  if (has(/docker-compose\.ya?ml|dockerfile/)) return dockerProfile
  if (has(/pom\.xml/)) return javaMavenProfile
  if (has(/build\.gradle/)) return javaGradleProfile
  if (has(/vue\.config\.js/)) return vueProfile
  if (has(/vite\.config\.[jt]s/) && has(/\.jsx?\b|\.tsx?\b/)) return reactProfile
  return NODE_GATE_PROFILE
}

// ============ 内容级校验 / 模板映射 ============

/**
 * manifest 内容级校验：文件存在 ≠ 有效。
 * - node：package.json 必须含非空 dependencies 或 devDependencies（npm init -y 空壳判无效）；
 * - 其他生态：内容非空白即视为有效声明（requirements.txt 非空、go.mod 非空等）。
 * 纯函数零 IO：文件读取由调用方完成，本函数只判定内容。
 */
export function manifestContentOk(profile: ProjectProfile, content: string): boolean {
  const text = (content || '').trim()
  if (!text) return false
  if (profile.language === 'node') {
    try {
      const j = JSON.parse(text)
      const deps = j?.dependencies && Object.keys(j.dependencies).length > 0
      const devDeps = j?.devDependencies && Object.keys(j.devDependencies).length > 0
      return !!(deps || devDeps)
    } catch {
      return false
    }
  }
  return true
}

/**
 * 画像 id → 验证模板 id 映射（执行阶段门控的 fileExists 判据来源）。
 * 无合适模板的画像返回 null（回退「仅校验 manifest 文件存在」的宽松口径）。
 */
export function templateIdForProfile(profileId: string): string | null {
  const map: Record<string, string> = {
    vue: 'vue-scaffold',
    node: 'node-service',
    python: 'python-project',
    go: 'go-project',
    rust: 'rust-project',
    docker: 'docker-service'
  }
  return map[profileId] ?? null
}

// ============ 话术 / 提示词模板 ============

/**
 * S8 执行纪律注入文本（项目创建场景）：先 manifest → 再 config → 最后源码；
 * 依赖安装必须在 manifest 创建成功后；禁止全局安装。
 */
export function formatProfileDiscipline(profile: ProjectProfile): string {
  if (profile.id === 'generic' || !profile.dependencyManifest) return ''
  const configText = profile.configFiles.length > 0 ? profile.configFiles.join('、') : '（本生态无必须配置文件）'
  const srcText = profile.sourceDir ? `${profile.sourceDir} 下` : '项目目录内'
  return (
    `[S8 执行纪律·项目画像] 当前项目类型：${profile.displayName}（${profile.language}）。\n` +
    `执行顺序铁律：先声明依赖（必须首先创建 ${profile.dependencyManifest}），再写配置（${configText}），最后写源码（${srcText}的源码文件）。\n` +
    `任何依赖安装命令（${profile.initCommands.join(' / ') || '见画像'}）必须在 ${profile.dependencyManifest} 创建成功后才能执行；` +
    `安装成功后才允许运行验证命令（${profile.runCommands.join(' / ') || '见画像'}）。` +
    (profile.forbidGlobalInstall.length > 0
      ? `\n绝对禁止使用全局安装命令（如 ${profile.forbidGlobalInstall.join('、')}）——依赖必须装入项目本地环境。`
      : '')
  )
}

/**
 * 【系统强制重置】话术模板（物理阻断后「重试任务」用）：
 * 按画像声明三阶段顺序，禁止全局安装。missingDetails 为缺失产物清单（每行一个，可为空）。
 * 保留 FORCED-RECOVERY 标签前缀——后端据此进入三阶段白名单（write-only → install → done）。
 */
export function buildForcedResetPrompt(profile: ProjectProfile, missingDetails: string): string {
  const manifest = profile.dependencyManifest || '依赖声明文件'
  const configText = profile.configFiles.length > 0 ? profile.configFiles.join('、') : '必要配置文件'
  const srcText = profile.sourceDir ? `${profile.sourceDir} 下` : '项目目录内'
  const initText = profile.initCommands.join(' / ') || '对应依赖安装命令'
  const runText = profile.runCommands.join(' / ') || '对应运行命令'
  const forbidText = profile.forbidGlobalInstall.join('、') || '任何全局安装命令'
  return (
    // 不再写死项目类型（如「当前项目类型是：Node.js」）——避免误导后续 generateDagPlan
    // 的类型识别；类型由 scheduler 从原始用户请求重新判定。
    `【FORCED-RECOVERY】【系统强制重置】任务已作废，上下文已清理。\n` +
    '你必须严格遵循以下阶段顺序，不得有任何跳跃：\n' +
    `阶段一（文件生成）：只允许调用 write_file 创建基础文件。必须首先创建 ${manifest}，然后创建 ${configText}，最后创建 ${srcText}的源码。` +
    '禁止 read_text_file/read_file 读取旧文件（旧文件已视为污染状态），禁止 edit_file 修补，一律整体覆盖写入：\n' +
    `${missingDetails || '（见上方偏差报告中的全部缺失文件）'}\n` +
    `阶段二（依赖安装）：文件齐全后，执行且只执行一次 ${initText} 并确认成功（退出码为 0）；\n` +
    `阶段三（运行验证）：依赖装好后，执行 ${runText} 验证，然后再次请求验证锁。\n` +
    `绝对禁止在阶段一和阶段二中使用任何全局安装命令（如 ${forbidText}）。` +
    '在阶段一、二完成前，禁止任何运行/启动命令、后台任务与搜索读取动作。'
  )
}
