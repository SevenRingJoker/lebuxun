// scheduler 纯函数单元测试：isProjectCreation / analyzeBashFailure / postProcessToolResult / autoUpdateTodos / validateProjectCreation
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AiMessage } from './types'
import type { PromptContext } from './promptBuilder'
import { TodoStore } from './todoManager'
import type { ArtifactManifest } from './validation'
import { gateBashMessage } from './bashGate'
import {
  isProjectCreation,
  analyzeBashFailure,
  postProcessToolResult,
  autoUpdateTodos,
  isTodoSatisfied,
  preflightBash,
  probeNpmGateContext,
  validateProjectCreation,
  extractManifestFromPlan,
  validateTaskCompletion,
  getValidationState,
  setValidationManifest,
  isNetworkUnreachableError,
  nextCandidateAfterNetworkError,
  checkRecoveryGuard,
  hasForcedRecoveryTag,
  extractTargetDirFromPlan,
  computeExecStage,
  checkExecStageGate,
  fileActionPath,
  trackFileAction,
  FILE_ACTION_THRESHOLD,
  isOutsideTargetDir
} from './scheduler'
import { getProfile, NODE_GATE_PROFILE } from '../../shared/projectProfiles'
import { getTemplate } from './validationTemplates'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 构造最小 PromptContext，只填测试所需字段
function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    isProjectCreation: true,
    createdFiles: new Set<string>(),
    ranNpmInstall: false,
    ranServe: false,
    round: 0,
    stallRestarts: 0,
    tools: [],
    ...overrides
  } as PromptContext
}

// ==================== isProjectCreation ====================
describe('isProjectCreation', () => {
  it('识别"创建vue2项目"为项目创建请求', () => {
    const msgs: AiMessage[] = [{ role: 'user', content: '创建vue2项目' }]
    expect(isProjectCreation(msgs)).toBe(true)
  })

  it('识别"新建一个react工程"', () => {
    const msgs: AiMessage[] = [{ role: 'user', content: '帮我新建一个react工程' }]
    expect(isProjectCreation(msgs)).toBe(true)
  })

  it('普通问答不识别为项目创建', () => {
    const msgs: AiMessage[] = [{ role: 'user', content: '你好，解释一下闭包' }]
    expect(isProjectCreation(msgs)).toBe(false)
  })

  it('倒序找最后一条 user 消息：尾部混入 assistant 占位时仍能检测', () => {
    const msgs: AiMessage[] = [
      { role: 'user', content: '创建vue2项目' },
      { role: 'assistant', content: '', isStreaming: true } as AiMessage
    ]
    expect(isProjectCreation(msgs)).toBe(true)
  })

  it('尾部是工具消息时不影响检测', () => {
    const msgs: AiMessage[] = [
      { role: 'user', content: '生成一个koa项目' },
      { role: 'tool', content: 'ok', name: 'write' } as AiMessage
    ]
    expect(isProjectCreation(msgs)).toBe(true)
  })

  it('空消息列表返回 false', () => {
    expect(isProjectCreation([])).toBe(false)
  })
})

// ==================== analyzeBashFailure ====================
describe('analyzeBashFailure', () => {
  it('Windows 命令不存在：识别"不是内部或外部命令"并建议 npx', () => {
    const result = `'vue' 不是内部或外部命令，也不是可运行的程序`
    const analysis = analyzeBashFailure(result, 'vue create my-app', new Map())
    expect(analysis).not.toBeNull()
    expect(analysis).toContain('vue')
    expect(analysis).toContain('npx')
  })

  it('Unix command not found：识别并建议 npx', () => {
    const result = `bash: vue: command not found`
    const analysis = analyzeBashFailure(result, 'vue create app', new Map())
    expect(analysis).not.toBeNull()
    expect(analysis).toContain('npx')
  })

  it('npm ERR 错误：返回修复建议', () => {
    const result = `npm ERR! code ECONNREFUSED`
    const analysis = analyzeBashFailure(result, 'npm install', new Map())
    expect(analysis).not.toBeNull()
    expect(analysis).toContain('镜像源')
  })

  it('目录不存在错误：返回创建目录建议', () => {
    const result = `The system cannot find the path specified.`
    const analysis = analyzeBashFailure(result, 'cd my-project && npm install', new Map())
    expect(analysis).not.toBeNull()
    expect(analysis).toContain('mkdir')
  })

  it('正常成功输出：返回 null', () => {
    const result = `退出码 0\n\nadded 200 packages`
    expect(analyzeBashFailure(result, 'npm install', new Map())).toBeNull()
  })

  it('交互式 preset 选择卡死：识别并要求放弃脚手架', () => {
    const result = `? Please pick a preset: (Use arrow keys)
> Default ([Vue 3] babel, eslint)
  Default ([Vue 2] babel, eslint)`
    const analysis = analyzeBashFailure(result, 'vue create app', new Map())
    expect(analysis).not.toBeNull()
    expect(analysis).toContain('交互式')
  })

  it('vue 命令不存在：建议用 write 而非 npx/安装', () => {
    const analysis = analyzeBashFailure(`'vue' 不是内部或外部命令`, 'vue create app', new Map())
    expect(analysis).not.toBeNull()
    expect(analysis).toContain('write')
    expect(analysis).not.toContain('npx vue')
  })
})

// ==================== postProcessToolResult ====================
describe('postProcessToolResult', () => {
  it('mkdir 目录已存在：改写为 Success', () => {
    const ctx = makeCtx()
    const result = `子目录或文件 vue2-project 已存在。`
    const final = postProcessToolResult('bash', { command: 'mkdir vue2-project' }, result, ctx)
    expect(final).toContain('成功')
    expect(final).toContain('已存在')
  })

  it('create_directory 已存在：改写为 Success', () => {
    const ctx = makeCtx()
    const result = `Directory already exists`
    const final = postProcessToolResult('create_directory', { path: '/a/b' }, result, ctx)
    expect(final).toContain('成功')
  })

  it('write 成功后注入文件树', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/proj/package.json', '/proj/src/main.js']) })
    const result = `已写入 /proj/App.vue（120 字符）`
    const final = postProcessToolResult('write', { path: '/proj/App.vue', content: 'x' }, result, ctx)
    expect(final).toContain('[当前文件树]')
    expect(final).toContain('package.json')
    expect(final).toContain('main.js')
  })

  it('write 失败（以"错误"开头）不注入文件树', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/proj/a.js']) })
    const result = `错误：权限不足`
    const final = postProcessToolResult('write', { path: '/proj/a.js' }, result, ctx)
    expect(final).not.toContain('[当前文件树]')
  })

  it('bash 非 mkdir 命令不做幂等改写', () => {
    const ctx = makeCtx()
    const result = `退出码 0\nhello`
    const final = postProcessToolResult('bash', { command: 'echo hello' }, result, ctx)
    expect(final).toBe(result)
  })
})

// ==================== autoUpdateTodos ====================
describe('autoUpdateTodos', () => {
  function makeStore() {
    const store = new TodoStore()
    store.handle({
      action: 'add',
      todos: [
        { content: '创建项目文件夹' },
        { content: '创建 package.json' },
        { content: '创建 src/main.js、src/App.vue' },
        { content: 'bash 执行 npm install' },
        { content: 'bash 执行 npm run serve' }
      ]
    })
    return store
  }

  it('write package.json：链式完成 #1 文件夹（隐式建目录）和 #2 package.json，无警告', () => {
    const store = makeStore()
    const ctx = makeCtx({ createdFiles: new Set(['/proj/package.json']) })
    const warning = autoUpdateTodos(store, 'write', { path: '/proj/package.json' }, '已写入', ctx)
    expect(warning).toBeNull()
    expect(store.items[0].status).toBe('completed')
    expect(store.items[1].status).toBe('completed')
    expect(store.items[2].status).toBe('pending')
  })

  it('跳序 write App.vue：#3 不标记完成并返回顺序锁警告', () => {
    const store = makeStore()
    const ctx = makeCtx({ createdFiles: new Set(['/proj/src/App.vue']) })
    const warning = autoUpdateTodos(store, 'write', { path: '/proj/src/App.vue' }, '已写入', ctx)
    // #1 因隐式建目录完成；#2 package.json 未完成；#3 被跳序，不允许完成
    expect(store.items[0].status).toBe('completed')
    expect(store.items[1].status).toBe('pending')
    const srcTodo = store.items.find((t) => t.content.includes('main.js'))!
    expect(srcTodo.status).toBe('pending')
    expect(warning).toContain('顺序锁')
    expect(warning).toContain('#2')
  })

  it('批量任务只写 main.js 缺 App.vue：#3 不完成', () => {
    const store = makeStore()
    const ctx = makeCtx({ createdFiles: new Set(['/proj/package.json', '/proj/src/main.js']) })
    autoUpdateTodos(store, 'write', { path: '/proj/src/main.js' }, '已写入', ctx)
    const srcTodo = store.items.find((t) => t.content.includes('main.js'))!
    expect(srcTodo.status).toBe('pending')
  })

  it('批量任务 main.js + App.vue 齐全：#3 链式完成', () => {
    const store = makeStore()
    const ctx = makeCtx({
      createdFiles: new Set(['/proj/package.json', '/proj/src/main.js', '/proj/src/App.vue'])
    })
    const warning = autoUpdateTodos(store, 'write', { path: '/proj/src/App.vue' }, '已写入', ctx)
    expect(warning).toBeNull()
    expect(store.items[2].status).toBe('completed')
    expect(store.items[3].status).toBe('pending')
  })

  it('bash mkdir 成功（ranMkdir 已置位）标记"创建项目文件夹"完成', () => {
    const store = makeStore()
    const ctx = makeCtx({ ranMkdir: true })
    const warning = autoUpdateTodos(store, 'bash', { command: 'mkdir vue2-project' }, '退出码 0', ctx)
    expect(warning).toBeNull()
    expect(store.items[0].status).toBe('completed')
    expect(store.items[1].status).toBe('pending')
  })

  it('前置文件齐全 + npm install 成功：链式推进到 #4 完成', () => {
    const store = makeStore()
    const ctx = makeCtx({
      createdFiles: new Set(['/proj/package.json', '/proj/src/main.js', '/proj/src/App.vue']),
      ranNpmInstall: true
    })
    const warning = autoUpdateTodos(store, 'bash', { command: 'npm install' }, '退出码 0\nadded 200 packages', ctx)
    expect(warning).toBeNull()
    expect(store.items[0].status).toBe('completed')
    expect(store.items[3].status).toBe('completed')
    expect(store.items[4].status).toBe('pending')
  })

  it('前置未完成时执行 npm install：返回顺序锁警告且 #4 不完成', () => {
    const store = makeStore()
    const ctx = makeCtx({ ranNpmInstall: true })
    const warning = autoUpdateTodos(store, 'bash', { command: 'npm install' }, '退出码 0', ctx)
    expect(warning).toContain('顺序锁')
    expect(store.items.find((t) => t.content.includes('npm install'))!.status).toBe('pending')
  })

  it('空清单返回 null', () => {
    const store = new TodoStore()
    const ctx = makeCtx()
    expect(autoUpdateTodos(store, 'write', { path: '/a.js' }, '已写入', ctx)).toBeNull()
  })

  it('非项目创建工具（grep）不影响 Todo', () => {
    const store = makeStore()
    const ctx = makeCtx()
    const warning = autoUpdateTodos(store, 'grep', { pattern: 'foo' }, '未找到匹配', ctx)
    expect(warning).toBeNull()
    expect(store.items.every((t) => t.status === 'pending')).toBe(true)
  })
})

// ==================== isTodoSatisfied ====================
describe('isTodoSatisfied', () => {
  const todo = (content: string) => ({ content })

  it('目录任务：ranMkdir 为 true 即满足', () => {
    const ctx = makeCtx({ ranMkdir: true })
    expect(isTodoSatisfied(todo('创建项目文件夹'), ctx)).toBe(true)
  })

  it('目录任务：有任意已创建文件也视为满足（write 隐式建目录）', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/a.js']) })
    expect(isTodoSatisfied(todo('创建项目文件夹'), ctx)).toBe(true)
  })

  it('文件任务：路径含反斜杠也能匹配（Windows）', () => {
    const ctx = makeCtx({ createdFiles: new Set(['D:\\p\\package.json']) })
    expect(isTodoSatisfied(todo('创建 package.json'), ctx)).toBe(true)
  })

  it('批量任务：缺任意一个文件都不满足', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/p/babel.config.js', '/p/vue.config.js'])
    })
    expect(isTodoSatisfied(todo('创建 babel.config.js、vue.config.js、index.html'), ctx)).toBe(false)
  })

  it('npm install 步骤：ranNpmInstall 标志位', () => {
    expect(isTodoSatisfied(todo('npm install 安装依赖'), makeCtx({ ranNpmInstall: true }))).toBe(true)
    expect(isTodoSatisfied(todo('npm install 安装依赖'), makeCtx())).toBe(false)
  })
})

// ==================== preflightBash ====================
describe('preflightBash', () => {
  it('vue create 归为交互式（建议 PTY）', () => {
    const ctx = makeCtx()
    expect(preflightBash('vue create my-app', ctx)).toContain('PTY')
  })

  it('npx @vue/cli create 归为交互式', () => {
    const ctx = makeCtx()
    expect(preflightBash('npx @vue/cli create app', ctx)).toContain('PTY')
  })

  it('create-react-app 归为交互式', () => {
    const ctx = makeCtx()
    expect(preflightBash('npx create-react-app app', ctx)).toContain('PTY')
  })

  it('无 package.json 时 npm install（含带包名形态）被拦截（顺序锁）', () => {
    const ctx = makeCtx({ isProjectCreation: true })
    expect(preflightBash('npm install', ctx)).toContain('当前目录缺少 package.json')
    expect(preflightBash('npm install vue@2.7.16', ctx)).toContain('当前目录缺少 package.json')
  })

  it('有 package.json 时 npm install 放行', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/package.json']) })
    expect(preflightBash('npm install', ctx)).toBeNull()
  })

  it('未 npm install 时 npm run serve 被拦截（顺序锁）', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/p/package.json']),
      ranNpmInstall: false
    })
    expect(preflightBash('npm run serve', ctx)).toContain('依赖尚未安装')
  })

  it('已 install 后 npm run serve 放行', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/p/package.json']),
      ranNpmInstall: true
    })
    expect(preflightBash('npm run serve', ctx)).toBeNull()
  })

  it('非项目创建场景只拦截脚手架，不做 npm 顺序检查', () => {
    const ctx = makeCtx({ isProjectCreation: false })
    expect(preflightBash('npm install', ctx)).toBeNull()
  })

  it('npm install -g 全局安装不受 package.json 前置限制', () => {
    const ctx = makeCtx({ isProjectCreation: true })
    expect(preflightBash('npm install -g typescript', ctx)).toBeNull()
  })
})

// ==================== probeNpmGateContext（NPM 硬锁磁盘探测） ====================
describe('probeNpmGateContext', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stc-npm-probe-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('空目录：package.json / node_modules 均不存在', () => {
    const gate = probeNpmGateContext(makeCtx({ workspace: dir }), null)
    expect(gate.packageJsonExists).toBe(false)
    expect(gate.nodeModulesExists).toBe(false)
  })

  it('createdFiles 含 package.json：packageJsonExists=true（即使磁盘无文件）', () => {
    const gate = probeNpmGateContext(
      makeCtx({ workspace: dir, createdFiles: new Set([join(dir, 'package.json')]) }),
      null
    )
    expect(gate.packageJsonExists).toBe(true)
    expect(gate.nodeModulesExists).toBe(false)
  })

  it('磁盘存在 package.json 与 node_modules：两者均 true', () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'node_modules'))
    const gate = probeNpmGateContext(makeCtx({ workspace: dir }), null)
    expect(gate.packageJsonExists).toBe(true)
    expect(gate.nodeModulesExists).toBe(true)
  })

  it('cwd 子目录探测：根目录缺失但子目录齐全时按子目录判定为存在', () => {
    mkdirSync(join(dir, 'web'))
    writeFileSync(join(dir, 'web', 'package.json'), '{}')
    mkdirSync(join(dir, 'web', 'node_modules'))
    const gate = probeNpmGateContext(makeCtx({ workspace: dir }), 'web')
    expect(gate.packageJsonExists).toBe(true)
    expect(gate.nodeModulesExists).toBe(true)
  })

  it('探测结果接入 gateBashMessage：空目录硬锁拦截；补齐 package.json 后 install 放行、run 仍拦', () => {
    const gate = probeNpmGateContext(
      makeCtx({ workspace: dir, isProjectCreation: false }),
      null
    )
    expect(gateBashMessage('npm install', gate)).toContain('当前目录缺少 package.json')
    expect(gateBashMessage('npm run dev', gate)).toContain('依赖尚未安装')
    // 造 package.json（含 dependencies 的有效清单；空壳 {} 会被内容级校验拦截）但无 node_modules：
    // install 放行，run 被依赖锁拦截
    writeFileSync(join(dir, 'package.json'), '{"name":"x","dependencies":{"vue":"^2.6.14"}}')
    const gate2 = probeNpmGateContext(
      makeCtx({ workspace: dir, isProjectCreation: false }),
      null
    )
    expect(gateBashMessage('npm install', gate2)).toBeNull()
    expect(gateBashMessage('npm run dev', gate2)).toContain('依赖尚未安装')
  })
})

// ==================== validateProjectCreation ====================
describe('validateProjectCreation', () => {
  it('全部缺失：返回包含所有缺失项的消息', () => {
    const ctx = makeCtx({ createdFiles: new Set() })
    const msg = validateProjectCreation(ctx)
    expect(msg).not.toBeNull()
    expect(msg).toContain('package.json')
    expect(msg).toContain('main.js')
    expect(msg).toContain('App.vue')
    expect(msg).toContain('npm install')
    expect(msg).toContain('npm run serve')
  })

  it('仅有 package.json：仍未通过', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/proj/package.json']) })
    expect(validateProjectCreation(ctx)).not.toBeNull()
  })

  it('三个文件齐全但未 npm install：未通过', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/proj/package.json', '/proj/src/main.js', '/proj/src/App.vue'])
    })
    expect(validateProjectCreation(ctx)).not.toBeNull()
  })

  it('文件齐全 + npm install 但未 npm run serve：未通过', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/proj/package.json', '/proj/src/main.js', '/proj/src/App.vue']),
      ranNpmInstall: true
    })
    expect(validateProjectCreation(ctx)).not.toBeNull()
  })

  it('五项全部满足：返回 null（允许收尾）', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/proj/package.json', '/proj/src/main.js', '/proj/src/App.vue']),
      ranNpmInstall: true,
      ranServe: true
    })
    expect(validateProjectCreation(ctx)).toBeNull()
  })

  it('Windows 反斜杠路径也能正确识别', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['D:\\proj\\package.json', 'D:\\proj\\src\\main.js', 'D:\\proj\\src\\App.vue']),
      ranNpmInstall: true,
      ranServe: true
    })
    expect(validateProjectCreation(ctx)).toBeNull()
  })
})

// ==================== extractManifestFromPlan（二期 generatePlan 注入） ====================
describe('extractManifestFromPlan', () => {
  it('合法 manifest 段在末尾：解析成功', () => {
    const plan = '=== 文件: package.json ===\n内容\n=== 结束 ===\n\n```manifest\n{ "id": "test", "rules": [{ "id": "pkg", "description": "package.json", "kind": "fileExists", "path": "package.json" }] }\n```'
    const m = extractManifestFromPlan(plan)
    expect(m).not.toBeNull()
    expect(m!.id).toBe('test')
    expect(m!.rules).toHaveLength(1)
    expect(m!.rules[0].id).toBe('pkg')
  })

  it('无 manifest 段：返回 null', () => {
    expect(extractManifestFromPlan('普通 plan 文本，无 manifest 声明')).toBeNull()
  })

  it('JSON 损坏：返回 null', () => {
    const plan = '```manifest\n{ 不是合法 json }\n```'
    expect(extractManifestFromPlan(plan)).toBeNull()
  })

  it('rules 字段缺失：返回 null', () => {
    const plan = '```manifest\n{ "id": "test" }\n```'
    expect(extractManifestFromPlan(plan)).toBeNull()
  })

  it('id 字段缺失：返回 null', () => {
    const plan = '```manifest\n{ "rules": [] }\n```'
    expect(extractManifestFromPlan(plan)).toBeNull()
  })

  it('多个 manifest 段：取第一个', () => {
    const plan = '```manifest\n{ "id": "first", "rules": [{ "id": "a", "description": "a", "kind": "fileExists", "path": "a.js" }] }\n```\n文字\n```manifest\n{ "id": "second", "rules": [{ "id": "b", "description": "b", "kind": "fileExists", "path": "b.js" }] }\n```'
    const m = extractManifestFromPlan(plan)
    expect(m!.id).toBe('first')
  })

  it('manifest 段在 plan 中间：也能解析', () => {
    const plan = '前文\n```manifest\n{ "id": "mid", "rules": [{ "id": "x", "description": "x", "kind": "fileExists", "path": "x.js" }] }\n```\n后文'
    const m = extractManifestFromPlan(plan)
    expect(m!.id).toBe('mid')
  })

  it('空字符串：返回 null', () => {
    expect(extractManifestFromPlan('')).toBeNull()
  })

  it('rules 内有非法项（缺 id）：跳过该规则，剩余合法则返回', () => {
    const plan = '```manifest\n{ "id": "t", "rules": [{ "description": "无id", "kind": "fileExists", "path": "a.js" }, { "id": "ok", "description": "ok", "kind": "fileExists", "path": "b.js" }] }\n```'
    const m = extractManifestFromPlan(plan)
    expect(m).not.toBeNull()
    expect(m!.rules).toHaveLength(1)
    expect(m!.rules[0].id).toBe('ok')
  })

  it('rules 全部非法：返回 null', () => {
    const plan = '```manifest\n{ "id": "t", "rules": [{ "description": "无id", "kind": "fileExists" }] }\n```'
    expect(extractManifestFromPlan(plan)).toBeNull()
  })
})

// ==================== validateTaskCompletion（二期通用化） ====================
describe('validateTaskCompletion', () => {
  const testManifest: ArtifactManifest = {
    id: 'test',
    rules: [
      { id: 'pkg', description: 'package.json', kind: 'fileExists', path: 'package.json' },
      { id: 'main', description: 'src/main.js', kind: 'fileExists', path: 'src/main.js' }
    ]
  }

  it('ctx.artifactManifest 优先：用注入 manifest', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, createdFiles: new Set(['/p/package.json', '/p/src/main.js']) })
    expect(validateTaskCompletion(ctx)).toBeNull()
  })

  it('注入 manifest 部分未通过：返回消息', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, createdFiles: new Set(['/p/package.json']) })
    const msg = validateTaskCompletion(ctx)
    expect(msg).not.toBeNull()
    expect(msg).toContain('src/main.js')
  })

  it('注入 manifest 全通过：返回 null', () => {
    const ctx = makeCtx({
      artifactManifest: testManifest,
      createdFiles: new Set(['/p/package.json', '/p/src/main.js'])
    })
    expect(validateTaskCompletion(ctx)).toBeNull()
  })

  it('缺省 + isProjectCreation：回退 vueScaffold', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/p/package.json', '/p/src/main.js', '/p/src/App.vue']),
      ranNpmInstall: true,
      ranServe: true
    })
    expect(validateTaskCompletion(ctx)).toBeNull()
  })

  it('缺省 + isProjectCreation + 缺失：返回 vueScaffold 消息', () => {
    const ctx = makeCtx({ createdFiles: new Set() })
    const msg = validateTaskCompletion(ctx)
    expect(msg).not.toBeNull()
    expect(msg).toContain('package.json')
  })

  it('缺省 + 非项目创建：返回 null（无校验）', () => {
    const ctx = makeCtx({ isProjectCreation: false, createdFiles: new Set() })
    expect(validateTaskCompletion(ctx)).toBeNull()
  })

  it('注入 manifest + isProjectCreation：用注入而非 vueScaffold', () => {
    // 注入 manifest 只校验 2 项，即使 vueScaffold 5 项未满足也只看注入
    const ctx = makeCtx({
      artifactManifest: testManifest,
      createdFiles: new Set(['/p/package.json', '/p/src/main.js'])
    })
    // 缺 App.vue + npm install/serve，但注入 manifest 不含这些，应通过
    expect(validateTaskCompletion(ctx)).toBeNull()
  })

  it('validateProjectCreation 与 validateTaskCompletion 在 vueScaffold 场景结果一致', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/package.json']) })
    expect(validateProjectCreation(ctx)).toBe(validateTaskCompletion(ctx))
  })
})

// ==================== getValidationState / setValidationManifest（IPC 状态读写） ====================
describe('getValidationState / setValidationManifest', () => {
  // 每例前重置单例，避免状态泄漏
  beforeEach(() => setValidationManifest(null))

  it('初始：manifest 为 null，ctx 为 null（无活动任务）', () => {
    const st = getValidationState()
    expect(st.manifest).toBeNull()
    expect(st.ctx).toBeNull()
  })

  it('setValidationManifest 后 getValidationState 返回该 manifest', () => {
    const m: ArtifactManifest = {
      id: 'ipc-test',
      rules: [{ id: 'r1', description: 'r1', kind: 'fileExists', path: 'a.js' }]
    }
    setValidationManifest(m)
    expect(getValidationState().manifest).toBe(m)
  })

  it('setValidationManifest(null) 清空 manifest', () => {
    setValidationManifest({ id: 'x', rules: [{ id: 'r', description: 'r', kind: 'fileExists', path: 'x.js' }] })
    setValidationManifest(null)
    expect(getValidationState().manifest).toBeNull()
  })

  it('连续 set 两次：后者覆盖前者', () => {
    setValidationManifest({ id: 'first', rules: [{ id: 'a', description: 'a', kind: 'fileExists', path: 'a.js' }] })
    const second: ArtifactManifest = { id: 'second', rules: [{ id: 'b', description: 'b', kind: 'fileExists', path: 'b.js' }] }
    setValidationManifest(second)
    expect(getValidationState().manifest?.id).toBe('second')
  })

  it('无活动任务时 ctx 为 null', () => {
    setValidationManifest({ id: 'x', rules: [{ id: 'r', description: 'r', kind: 'fileExists', path: 'x.js' }] })
    // currentTaskCtx 未导出 setter，任务未运行时恒为 null
    expect(getValidationState().ctx).toBeNull()
  })

  it('manifest 与 ctx 独立：set manifest 不影响 ctx null', () => {
    setValidationManifest({ id: 'x', rules: [{ id: 'r', description: 'r', kind: 'fileExists', path: 'x.js' }] })
    const st = getValidationState()
    expect(st.manifest).not.toBeNull()
    expect(st.ctx).toBeNull()
  })
})

// ==================== isTodoSatisfied manifest 分支（二期重构） ====================
describe('isTodoSatisfied（manifest 分支）', () => {
  const testManifest: ArtifactManifest = {
    id: 'test',
    rules: [
      { id: 'pkg', description: 'package.json', kind: 'fileExists', path: 'package.json' },
      { id: 'main', description: 'src/main.js', kind: 'fileExists', path: 'src/main.js' },
      { id: 'app', description: 'src/App.vue', kind: 'fileExists', path: 'src/App.vue' }
    ]
  }

  it('有 manifest + todo 提到 main.js + 已创建：通过', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, createdFiles: new Set(['/p/src/main.js']) })
    expect(isTodoSatisfied({ content: '创建 src/main.js' }, ctx)).toBe(true)
  })

  it('有 manifest + todo 提到 main.js + 未创建：不通过', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, createdFiles: new Set() })
    expect(isTodoSatisfied({ content: '创建 src/main.js' }, ctx)).toBe(false)
  })

  it('有 manifest + 批量 todo（package.json + main.js）部分未创建：不通过', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, createdFiles: new Set(['/p/package.json']) })
    expect(isTodoSatisfied({ content: '创建 package.json 和 src/main.js' }, ctx)).toBe(false)
  })

  it('有 manifest + 批量 todo 全部已创建：通过', () => {
    const ctx = makeCtx({
      artifactManifest: testManifest,
      createdFiles: new Set(['/p/package.json', '/p/src/main.js'])
    })
    expect(isTodoSatisfied({ content: '创建 package.json 和 src/main.js' }, ctx)).toBe(true)
  })

  it('有 manifest + todo 无匹配 fileExists 规则：返回 false（无法判定）', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, createdFiles: new Set() })
    expect(isTodoSatisfied({ content: '创建 babel.config.js' }, ctx)).toBe(false)
  })

  it('有 manifest + npm install todo：走布尔位（不调 runRule）', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, ranNpmInstall: true })
    expect(isTodoSatisfied({ content: '执行 npm install' }, ctx)).toBe(true)
  })

  it('有 manifest + npm run serve todo：走布尔位', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, ranServe: true })
    expect(isTodoSatisfied({ content: '执行 npm run serve' }, ctx)).toBe(true)
  })

  it('有 manifest + 目录 todo：走布尔位', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, ranMkdir: true })
    expect(isTodoSatisfied({ content: '创建项目文件夹' }, ctx)).toBe(true)
  })

  it('有 manifest + app.vue 已创建：通过', () => {
    const ctx = makeCtx({ artifactManifest: testManifest, createdFiles: new Set(['/p/src/App.vue']) })
    expect(isTodoSatisfied({ content: '创建 src/App.vue' }, ctx)).toBe(true)
  })

  it('缺省 manifest（无 artifactManifest）：回退旧硬编码（行为等价）', () => {
    // 无 artifactManifest，走旧 fileHintsOf 硬编码
    const ctx = makeCtx({ createdFiles: new Set(['/p/package.json']) })
    expect(isTodoSatisfied({ content: '创建 package.json' }, ctx)).toBe(true)
  })

  it('缺省 manifest + 多文件批量 todo：旧硬编码批量语义', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/p/package.json', '/p/src/main.js', '/p/src/App.vue'])
    })
    expect(isTodoSatisfied({ content: '创建 package.json、main.js、app.vue' }, ctx)).toBe(true)
  })
})

// ==================== 需求1：网络错误识别 + 候选跳转（不切同 provider） ====================
describe('isNetworkUnreachableError', () => {
  it('fetch failed / failed to fetch 命中（ Ollama 服务未启动最典型形态）', () => {
    expect(isNetworkUnreachableError('fetch failed')).toBe(true)
    expect(isNetworkUnreachableError('TypeError: Failed to fetch')).toBe(true)
    expect(isNetworkUnreachableError('network request failed')).toBe(true)
  })

  it('连接层错误码命中：ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EAI_AGAIN', () => {
    expect(isNetworkUnreachableError('connect ECONNREFUSED 127.0.0.1:11434')).toBe(true)
    expect(isNetworkUnreachableError('ETIMEDOUT')).toBe(true)
    expect(isNetworkUnreachableError('getaddrinfo ENOTFOUND ollama.local')).toBe(true)
    expect(isNetworkUnreachableError('EAI_AGAIN')).toBe(true)
  })

  it('连接超时文案命中', () => {
    expect(isNetworkUnreachableError('connect timeout after 30000ms')).toBe(true)
    expect(isNetworkUnreachableError('connection timed out')).toBe(true)
  })

  it('首 token 超时（模型在但不响应）不命中——仍允许回退到其他模型', () => {
    expect(isNetworkUnreachableError('模型 qwen2.5-coder:7b 在 30 秒内未开始响应')).toBe(false)
    expect(isNetworkUnreachableError('模型输出中断：仅收到 12 token')).toBe(false)
    expect(isNetworkUnreachableError('HTTP 400: 请求参数错误')).toBe(false)
    expect(isNetworkUnreachableError('')).toBe(false)
  })
})

describe('nextCandidateAfterNetworkError', () => {
  it('跳过同 provider 候选，返回第一个异 provider 下标', () => {
    const ids = ['ollama:qwen2.5-coder:7b', 'ollama:qwen2.5:14b', 'deepseek:deepseek-chat']
    expect(nextCandidateAfterNetworkError(ids, 0)).toBe(2)
  })

  it('当前已是异 provider 前一个同 provider 时同样跳转', () => {
    const ids = ['ollama:a', 'ollama:b', 'ollama:c', 'openai:gpt']
    expect(nextCandidateAfterNetworkError(ids, 1)).toBe(3)
  })

  it('全部候选同 provider → -1（网络挂了切同机模型无意义，应直接终止）', () => {
    expect(nextCandidateAfterNetworkError(['ollama:a', 'ollama:b'], 0)).toBe(-1)
  })

  it('裸 id（不含冒号）默认 ollama：与 ollama 全限定候选同 provider 不跳转', () => {
    expect(nextCandidateAfterNetworkError(['qwen2.5-coder', 'ollama:qwen2.5:14b'], 0)).toBe(-1)
  })

  it('当前下标已是最后候选 → -1', () => {
    expect(nextCandidateAfterNetworkError(['ollama:a', 'openai:b'], 1)).toBe(-1)
  })
})

// ==================== 需求4：FORCED-RECOVERY 三阶段白名单 ====================
describe('checkRecoveryGuard', () => {
  it('write-only 阶段：只放行 write_file，read/edit/bash/搜索全拒', () => {
    expect(checkRecoveryGuard('write-only', 'write_file', '')).toBeNull()
    expect(checkRecoveryGuard('write-only', 'write', '')).toBeNull()
    expect(checkRecoveryGuard('write-only', 'read_text_file', '')).toContain('第 1 阶段')
    expect(checkRecoveryGuard('write-only', 'read', '')).toContain('污染')
    expect(checkRecoveryGuard('write-only', 'edit_file', '')).toContain('整体覆盖')
    expect(checkRecoveryGuard('write-only', 'bash', 'npm install')).toContain('第 1 阶段')
    expect(checkRecoveryGuard('write-only', 'run_terminal_command', 'npm run dev')).toContain('第 1 阶段')
    expect(checkRecoveryGuard('write-only', 'grep', 'foo')).toContain('write_file')
  })

  it('install 阶段：放行 write（补修漏网文件）与非全局安装命令，拒运行/构建/全局安装', () => {
    expect(checkRecoveryGuard('install', 'write_file', '')).toBeNull()
    expect(checkRecoveryGuard('install', 'bash', 'npm install')).toBeNull()
    expect(checkRecoveryGuard('install', 'run_terminal_command', 'npm install vue@2.7.16')).toBeNull()
    expect(checkRecoveryGuard('install', 'bash', 'yarn install')).toBeNull()
    expect(checkRecoveryGuard('install', 'bash', 'npm run dev')).toContain('第 2 阶段')
    expect(checkRecoveryGuard('install', 'bash', 'npm run serve')).toContain('第 2 阶段')
    expect(checkRecoveryGuard('install', 'bash', 'npm i -g @vue/cli')).toContain('第 2 阶段')
    expect(checkRecoveryGuard('install', 'read_text_file', '')).toContain('第 2 阶段')
  })

  it('done 阶段：全部放行（交给正常循环与验证锁兜底）', () => {
    expect(checkRecoveryGuard('done', 'read_text_file', '')).toBeNull()
    expect(checkRecoveryGuard('done', 'bash', 'npm run dev')).toBeNull()
    expect(checkRecoveryGuard('done', 'edit_file', '')).toBeNull()
  })
})

describe('hasForcedRecoveryTag', () => {
  const tag = (content: string): AiMessage[] => [{ role: 'user', content } as AiMessage]

  it('user 消息含【FORCED-RECOVERY】标签 → true（容忍空白变体）', () => {
    expect(hasForcedRecoveryTag(tag('【FORCED-RECOVERY】请严格按三阶段重试'))).toBe(true)
    expect(hasForcedRecoveryTag(tag('【 FORCED-RECOVERY 】旧计划作废'))).toBe(true)
  })

  it('标签出现在 assistant 消息中不算（必须是用户/系统下发的接管指令）', () => {
    expect(hasForcedRecoveryTag([{ role: 'assistant', content: '【FORCED-RECOVERY】好的我会执行' } as AiMessage])).toBe(false)
  })

  it('无标签 → false', () => {
    expect(hasForcedRecoveryTag(tag('帮我写个 Vue 项目'))).toBe(false)
    expect(hasForcedRecoveryTag([])).toBe(false)
  })
})

// ==================== 需求3：probeNpmGateContext 采信加严 ====================
describe('probeNpmGateContext - package.json 位置采信', () => {
  let wsDir: string
  let otherDir: string
  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'gate-ws-'))
    otherDir = mkdtempSync(join(tmpdir(), 'gate-other-'))
  })
  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true })
    rmSync(otherDir, { recursive: true, force: true })
  })

  it('createdFiles 中的 package.json 在工作区外（其他盘/默认目录）时不采信：硬锁仍拦截', () => {
    const ctx = makeCtx({
      workspace: wsDir,
      isProjectCreation: false,
      createdFiles: new Set([join(otherDir, 'package.json')])
    })
    const gate = probeNpmGateContext(ctx, null)
    expect(gate.packageJsonExists).toBe(false)
    expect(gateBashMessage('npm install vue@2.7.16', gate)).toContain('当前目录缺少 package.json')
  })

  it('createdFiles 中的 package.json 在工作区深层子目录时不为根目录 install 背书', () => {
    const ctx = makeCtx({
      workspace: wsDir,
      isProjectCreation: false,
      createdFiles: new Set([join(wsDir, 'sub', 'package.json')])
    })
    expect(probeNpmGateContext(ctx, null).packageJsonExists).toBe(false)
    // 但命令 cwd 显式指向该子目录时采信
    expect(probeNpmGateContext(ctx, join(wsDir, 'sub')).packageJsonExists).toBe(true)
  })

  it('createdFiles 中的 package.json 恰在工作区根部时采信', () => {
    const ctx = makeCtx({
      workspace: wsDir,
      isProjectCreation: true,
      createdFiles: new Set([join(wsDir, 'package.json')])
    })
    expect(probeNpmGateContext(ctx, null).packageJsonExists).toBe(true)
  })
})

// ==================== 需求5：执行阶段硬门控 / targetDir 限定 / 文件动作防抖 ====================
describe('extractTargetDirFromPlan', () => {
  it('显式 targetDir 行优先（容忍全角冒号与首尾空白）', () => {
    expect(extractTargetDirFromPlan('targetDir: vue2-project\n=== 文件: package.json ===')).toBe('vue2-project')
    expect(extractTargetDirFromPlan('targetDir：my-app\n')).toBe('my-app')
  })

  it('兜底推断：所有 === 文件: === 路径共享同一顶层目录时采纳', () => {
    const plan = '=== 文件: vue2-project/package.json ===\n=== 文件: vue2-project/src/main.js ==='
    expect(extractTargetDirFromPlan(plan)).toBe('vue2-project')
  })

  it('文件路径分散在多个顶层目录时不做限定（返回 null）', () => {
    const plan = '=== 文件: a/package.json ===\n=== 文件: b/src/main.js ==='
    expect(extractTargetDirFromPlan(plan)).toBeNull()
  })

  it('拒绝绝对路径 / .. 上跳 / 根目录项目（.）', () => {
    expect(extractTargetDirFromPlan('targetDir: D:\\proj\\x')).toBeNull()
    expect(extractTargetDirFromPlan('targetDir: /abs/path')).toBeNull()
    expect(extractTargetDirFromPlan('targetDir: ../escape')).toBeNull()
    expect(extractTargetDirFromPlan('targetDir: .')).toBeNull()
  })

  it('空 plan / 无任何线索返回 null', () => {
    expect(extractTargetDirFromPlan(null)).toBeNull()
    expect(extractTargetDirFromPlan('')).toBeNull()
    expect(extractTargetDirFromPlan('没有文件清单也没有 targetDir 的计划')).toBeNull()
  })

  it('targetDir 尾部斜杠/反斜杠被去除；反斜杠分隔同样识别', () => {
    expect(extractTargetDirFromPlan('targetDir: vue2-project/')).toBe('vue2-project')
    expect(extractTargetDirFromPlan('targetDir: vue2-project\\')).toBe('vue2-project')
  })

  it('中文目录名可识别（编译测试项目场景）', () => {
    expect(extractTargetDirFromPlan('targetDir: 我的项目')).toBe('我的项目')
    expect(extractTargetDirFromPlan('targetDir：嵌套\\子目录')).toBe('嵌套\\子目录')
  })

  it('显式 targetDir 优先于文件清单兜底推断（即使文件清单指向别处）', () => {
    const plan = 'targetDir: app\n=== 文件: other/package.json ===\n=== 文件: other/src/main.js ==='
    expect(extractTargetDirFromPlan(plan)).toBe('app')
  })

  it('文件清单全在工作区根（无子目录前缀）→ 不限定（返回 null）', () => {
    const plan = '=== 文件: package.json ===\n=== 文件: index.js ==='
    expect(extractTargetDirFromPlan(plan)).toBeNull()
  })

  it('部分文件在根、部分在子目录 → 不一致，不限定', () => {
    const plan = '=== 文件: package.json ===\n=== 文件: app/src/main.js ==='
    expect(extractTargetDirFromPlan(plan)).toBeNull()
  })
})

describe('computeExecStage', () => {
  const vueTpl = getTemplate('vue-scaffold')!

  it('非项目创建：直接 run（不做阶段限制）', () => {
    expect(computeExecStage({
      isProjectCreation: false, createdFiles: new Set(), ranInit: false,
      manifest: vueTpl, profile: NODE_GATE_PROFILE
    })).toBe('run')
  })

  it('文件未齐（缺 src/main.js、src/App.vue）→ files', () => {
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(['/p/package.json']), ranInit: false,
      manifest: vueTpl, profile: NODE_GATE_PROFILE
    })).toBe('files')
  })

  it('文件齐（createdFiles 或 onDisk 命中）未装依赖 → install', () => {
    expect(computeExecStage({
      isProjectCreation: true,
      createdFiles: new Set(['/p/package.json', '/p/src/main.js', '/p/src/App.vue']),
      ranInit: false, manifest: vueTpl, profile: NODE_GATE_PROFILE
    })).toBe('install')
    // onDisk 谓词补齐缺口同样视为已创建
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(['/p/package.json']), ranInit: false,
      manifest: vueTpl, profile: NODE_GATE_PROFILE,
      onDisk: (rel) => rel === 'src/main.js' || rel === 'src/App.vue'
    })).toBe('install')
  })

  it('文件齐且已装依赖 → run', () => {
    expect(computeExecStage({
      isProjectCreation: true,
      createdFiles: new Set(['/p/package.json', '/p/src/main.js', '/p/src/App.vue']),
      ranInit: true, manifest: vueTpl, profile: NODE_GATE_PROFILE
    })).toBe('run')
  })

  it('无 manifest 时回退「画像 dependencyManifest 存在」宽松口径', () => {
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(), ranInit: false,
      manifest: null, profile: NODE_GATE_PROFILE
    })).toBe('files')
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(['/p/package.json']), ranInit: false,
      manifest: null, profile: NODE_GATE_PROFILE
    })).toBe('install')
  })

  it('createdFiles 为 Windows 反斜杠绝对路径也能归一化命中 fileExists 规则', () => {
    expect(computeExecStage({
      isProjectCreation: true,
      createdFiles: new Set(['D:\\p\\package.json', 'D:\\p\\src\\main.js', 'D:\\p\\src\\App.vue']),
      ranInit: false, manifest: vueTpl, profile: NODE_GATE_PROFILE
    })).toBe('install')
  })

  it('onDisk 未注入时缺失文件按未创建计（不擅自放行）', () => {
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(['/p/package.json']), ranInit: false,
      manifest: vueTpl, profile: NODE_GATE_PROFILE
    })).toBe('files')
  })

  it('画像无 dependencyManifest 且无 manifest（generic）：files 视为就绪，未装依赖 → install', () => {
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(), ranInit: false,
      manifest: null, profile: getProfile('generic')
    })).toBe('install')
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(), ranInit: true,
      manifest: null, profile: getProfile('generic')
    })).toBe('run')
  })

  it('go/rust 画像走各自模板：go.mod+main.go 齐 → install；缺 main.go → files', () => {
    const goTpl = getTemplate('go-project')!
    const goProfile = getProfile('go')
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(['/p/go.mod']), ranInit: false,
      manifest: goTpl, profile: goProfile
    })).toBe('files')
    expect(computeExecStage({
      isProjectCreation: true, createdFiles: new Set(['/p/go.mod', '/p/main.go']), ranInit: false,
      manifest: goTpl, profile: goProfile
    })).toBe('install')
  })
})

describe('checkExecStageGate', () => {
  it('files 阶段拦截画像安装命令（npm install / pip install），文案含依赖清单名', () => {
    const deny = checkExecStageGate('npm install', 'files', NODE_GATE_PROFILE)
    expect(deny).toContain('【阶段错误】')
    expect(deny).toContain('write_file')
    expect(deny).toContain('package.json')
    const pyDeny = checkExecStageGate('pip install -r requirements.txt', 'files', getProfile('python'))
    expect(pyDeny).toContain('requirements.txt')
  })

  it('files 阶段放行非安装命令；install/run 阶段全部放行', () => {
    expect(checkExecStageGate('mkdir src', 'files', NODE_GATE_PROFILE)).toBeNull()
    expect(checkExecStageGate('npm install', 'install', NODE_GATE_PROFILE)).toBeNull()
    expect(checkExecStageGate('npm install', 'run', NODE_GATE_PROFILE)).toBeNull()
  })

  it('go/rust 画像 files 阶段拦截各自安装/构建命令（泛化验证）', () => {
    expect(checkExecStageGate('go mod tidy', 'files', getProfile('go'))).toContain('【阶段错误】')
    expect(checkExecStageGate('go mod tidy', 'files', getProfile('go'))).toContain('go.mod')
    expect(checkExecStageGate('go build ./...', 'files', getProfile('go'))).toBeNull() // build 非 go initPattern
    // rust 画像 initPattern 含 cargo build（cargo fetch 慢于秒退，build 即初始化）
    expect(checkExecStageGate('cargo build', 'files', getProfile('rust'))).toContain('Cargo.toml')
  })

  it('画像无 initPattern（generic）任何阶段都不拦', () => {
    expect(checkExecStageGate('npm install', 'files', getProfile('generic'))).toBeNull()
  })
})

describe('fileActionPath / trackFileAction 防抖', () => {
  it('fileActionPath：读写工具提取归一化路径，非文件工具返回 null', () => {
    expect(fileActionPath('write_file', { path: 'D:\\P\\Package.JSON' })).toBe('d:/p/package.json')
    expect(fileActionPath('read_text_file', { file_path: 'src/App.vue' })).toBe('src/app.vue')
    expect(fileActionPath('bash', { command: 'npm install' })).toBeNull()
    expect(fileActionPath('write_file', {})).toBeNull()
  })

  it('窗口内同一路径达到阈值即触发；不同路径不触发', () => {
    let w: string[] = []
    let triggered = false
    for (let i = 0; i < FILE_ACTION_THRESHOLD; i++) {
      const r = trackFileAction(w, 'package.json')
      w = r.window
      triggered = r.triggered
    }
    expect(triggered).toBe(true)

    let w2: string[] = []
    // 同一路径在窗口内最多出现 2 次（低于阈值 3）→ 全程不触发
    for (const p of ['a.json', 'b.json', 'a.json', 'c.json', 'b.json']) {
      const r = trackFileAction(w2, p)
      w2 = r.window
      expect(r.triggered).toBe(false)
    }
  })

  it('读写混排同一文件也计数（写→读→查目录→写死循环场景）', () => {
    let w: string[] = []
    let triggered = false
    for (const p of ['package.json', 'src/main.js', 'package.json', 'package.json']) {
      const r = trackFileAction(w, p)
      w = r.window
      triggered = r.triggered
    }
    expect(triggered).toBe(true)
  })
})

describe('isOutsideTargetDir 目录越界判定', () => {
  const ws = join(tmpdir(), 'ws-root')

  it('targetRoot 本身与子路径（相对/绝对/反斜杠混写）均不越界', () => {
    expect(isOutsideTargetDir(ws, 'vue2-project', 'vue2-project')).toBe(false)
    expect(isOutsideTargetDir(ws, 'vue2-project', 'vue2-project/package.json')).toBe(false)
    expect(isOutsideTargetDir(ws, 'vue2-project', 'vue2-project\\src\\App.vue')).toBe(false)
    expect(isOutsideTargetDir(ws, 'vue2-project', join(ws, 'vue2-project', 'src', 'main.js'))).toBe(false)
  })

  it('写到工作区根（父目录）→ 越界', () => {
    expect(isOutsideTargetDir(ws, 'vue2-project', 'package.json')).toBe(true)
    expect(isOutsideTargetDir(ws, 'vue2-project', join(ws, 'package.json'))).toBe(true)
    expect(isOutsideTargetDir(ws, 'vue2-project', 'src/main.js')).toBe(true)
  })

  it('兄弟目录前缀陷阱：vue2-project2 不以 vue2-project 前缀误判为在内', () => {
    expect(isOutsideTargetDir(ws, 'vue2-project', 'vue2-project2/package.json')).toBe(true)
  })

  it('上跳逃逸（../）与其他盘符绝对路径 → 越界', () => {
    expect(isOutsideTargetDir(ws, 'vue2-project', '../outside.txt')).toBe(true)
    expect(isOutsideTargetDir(ws, 'vue2-project', 'C:\\other\\package.json')).toBe(true)
  })

  it('大小写与尾部斜杠差异不影响判定（Windows 路径语义）', () => {
    expect(isOutsideTargetDir(ws, 'vue2-project', 'VUE2-PROJECT/Package.JSON')).toBe(false)
    expect(isOutsideTargetDir(ws, 'Vue2-Project/', 'vue2-project/src/main.js')).toBe(false)
  })

  it('create_directory 创建目标目录本身豁免：targetDir 路径不越界', () => {
    expect(isOutsideTargetDir(ws, 'vue2-project', 'vue2-project/')).toBe(false)
    expect(isOutsideTargetDir(ws, 'vue2-project', 'vue2-project\\')).toBe(false)
  })
})

describe('probeNpmGateContext - 内容级空壳拦截', () => {
  let wsDir: string
  beforeEach(() => { wsDir = mkdtempSync(join(tmpdir(), 'gate-content-')) })
  afterEach(() => { rmSync(wsDir, { recursive: true, force: true }) })

  it('磁盘 package.json 为 npm init -y 空壳（无 dependencies）→ npm install 被拦', () => {
    writeFileSync(join(wsDir, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.0"\n}')
    const ctx = makeCtx({ workspace: wsDir, isProjectCreation: true })
    const gate = probeNpmGateContext(ctx, null)
    expect(gate.packageJsonExists).toBe(true)
    expect(gate.packageJsonHasContent).toBe(false)
    expect(gateBashMessage('npm install', gate)).toContain('缺少 dependencies')
  })

  it('磁盘 package.json 含 dependencies → packageJsonHasContent:true，npm install 放行', () => {
    writeFileSync(join(wsDir, 'package.json'), '{"name":"x","dependencies":{"vue":"^2.6.14"}}')
    const ctx = makeCtx({ workspace: wsDir, isProjectCreation: true })
    const gate = probeNpmGateContext(ctx, null)
    expect(gate.packageJsonHasContent).toBe(true)
    expect(gateBashMessage('npm install', gate)).toBeNull()
  })

  it('package.json 不存在 → hasContent 保持 undefined（不拦，由缺失校验接管）', () => {
    const ctx = makeCtx({ workspace: wsDir, isProjectCreation: true })
    const gate = probeNpmGateContext(ctx, null)
    expect(gate.packageJsonExists).toBe(false)
    expect(gate.packageJsonHasContent).toBeUndefined()
  })
})
