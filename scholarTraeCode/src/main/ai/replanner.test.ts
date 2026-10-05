// replanner.ts 单测：状态机、提示词构造、响应解析、LLM 请求（mock provider）
import { describe, it, expect } from 'vitest'
import {
  createReplanState,
  noteFailure,
  noteSuccess,
  shouldReplan,
  markReplanned,
  summarizeSignals,
  buildReplanPrompt,
  parseReplanResponse,
  sanitizeReplanSteps,
  requestReplan,
  FAILURE_THRESHOLD,
  MAX_REPLANS,
  type ReplanState
} from './replanner'
import type { AiProvider } from './types'
import type { TodoItem } from './todoManager'

// ============ 状态机 ============

describe('createReplanState', () => {
  it('初始计数与信号为空', () => {
    const s = createReplanState()
    expect(s.consecutiveFailures).toBe(0)
    expect(s.replanCount).toBe(0)
    expect(s.signals).toEqual([])
  })
})

describe('noteFailure', () => {
  it('计数+1 且信号入列', () => {
    const s = createReplanState()
    noteFailure(s, 'commandFailure', 'npm install\nnpm ERR! code 1')
    expect(s.consecutiveFailures).toBe(1)
    expect(s.signals[0]).toMatchObject({ trigger: 'commandFailure' })
    expect(s.signals[0].detail).toContain('npm ERR')
    expect(s.signals[0].at).toBeTypeOf('number')
  })

  it('明细折叠空白换行', () => {
    const s = createReplanState()
    noteFailure(s, 'preflightBlock', 'line1\n  line2\tline3')
    expect(s.signals[0].detail).toBe('line1 line2 line3')
  })

  it('超长明细截断到 600 字符并加省略号', () => {
    const s = createReplanState()
    noteFailure(s, 'validationBlock', 'x'.repeat(800))
    expect(s.signals[0].detail.length).toBe(601)
    expect(s.signals[0].detail.endsWith('…')).toBe(true)
  })

  it('信号超过 8 条时只保留最新 8 条', () => {
    const s = createReplanState()
    for (let i = 0; i < 10; i++) noteFailure(s, 'commandFailure', `sig-${i}`)
    expect(s.signals.length).toBe(8)
    expect(s.signals[0].detail).toBe('sig-2')
    expect(s.signals[7].detail).toBe('sig-9')
  })
})

describe('noteSuccess', () => {
  it('清零连续失败计数与信号，但保留已用重规划次数', () => {
    const s = createReplanState()
    s.replanCount = 1
    noteFailure(s, 'commandFailure', 'x')
    noteSuccess(s)
    expect(s.consecutiveFailures).toBe(0)
    expect(s.signals).toEqual([])
    expect(s.replanCount).toBe(1)
  })
})

describe('shouldReplan', () => {
  it(`未达 ${FAILURE_THRESHOLD} 次不触发`, () => {
    const s = createReplanState()
    noteFailure(s, 'commandFailure', 'x')
    expect(shouldReplan(s)).toBe(false)
  })

  it('达到阈值且未超次数上限时触发', () => {
    const s = createReplanState()
    noteFailure(s, 'commandFailure', 'x')
    noteFailure(s, 'preflightBlock', 'y')
    expect(shouldReplan(s)).toBe(true)
  })

  it(`重规划次数达 ${MAX_REPLANS} 后永不触发（防抖）`, () => {
    const s = createReplanState()
    markReplanned(s)
    markReplanned(s)
    noteFailure(s, 'commandFailure', 'x')
    noteFailure(s, 'commandFailure', 'y')
    expect(shouldReplan(s)).toBe(false)
  })
})

describe('markReplanned', () => {
  it('次数+1 并清零失败计数与信号', () => {
    const s = createReplanState()
    noteFailure(s, 'commandFailure', 'x')
    markReplanned(s)
    expect(s.replanCount).toBe(1)
    expect(s.consecutiveFailures).toBe(0)
    expect(s.signals).toEqual([])
  })
})

describe('summarizeSignals', () => {
  it('无信号时给出计数兜底', () => {
    const s = createReplanState()
    s.consecutiveFailures = 3
    expect(summarizeSignals(s)).toBe('连续 3 次受阻')
  })

  it('有信号时逐条带类型标签拼接', () => {
    const s = createReplanState()
    noteFailure(s, 'commandFailure', 'npm ERR! x')
    noteFailure(s, 'validationBlock', '缺 package.json')
    const text = summarizeSignals(s)
    expect(text).toContain('连续 2 次受阻')
    expect(text).toContain('[命令执行失败]')
    expect(text).toContain('[验证锁拦截]')
  })

  it('超长摘要截断', () => {
    const s = createReplanState()
    noteFailure(s, 'commandFailure', 'x'.repeat(800))
    const text = summarizeSignals(s)
    expect(text.length).toBeLessThanOrEqual(601)
  })
})

// ============ buildReplanPrompt ============

const todos: TodoItem[] = [
  { id: 1, content: '创建 package.json', status: 'completed', priority: 'high' },
  { id: 2, content: 'npm install', status: 'pending', priority: 'high' }
]

function makePromptState(): ReplanState {
  const s = createReplanState()
  noteFailure(s, 'commandFailure', 'npm ERR! code ERESOLVE')
  noteFailure(s, 'preflightBlock', 'vue create app')
  return s
}

describe('buildReplanPrompt', () => {
  it('包含用户请求/受阻信号/文件清单/原 TODO 四块', () => {
    const prompt = buildReplanPrompt({
      userRequest: '帮我创建一个 Vue 项目',
      state: makePromptState(),
      createdFiles: new Set(['/p/package.json']),
      todos
    })
    expect(prompt).toContain('Vue 项目')
    expect(prompt).toContain('ERESOLVE')
    expect(prompt).toContain('vue create app')
    expect(prompt).toContain('package.json')
    expect(prompt).toContain('[x] #1 创建 package.json')
    expect(prompt).toContain('[ ] #2 npm install')
    expect(prompt).toContain('```replan')
  })

  it('无文件/无 TODO/无信号时走兜底文案', () => {
    const s = createReplanState()
    s.consecutiveFailures = 2
    const prompt = buildReplanPrompt({
      userRequest: 'x',
      state: s,
      createdFiles: new Set(),
      todos: []
    })
    expect(prompt).toContain('尚未创建任何文件')
    expect(prompt).toContain('（无 TODO 清单）')
  })

  it('约束中明确禁止交互脚手架与 sudo', () => {
    const prompt = buildReplanPrompt({
      userRequest: 'x',
      state: makePromptState(),
      createdFiles: new Set(),
      todos: []
    })
    expect(prompt).toContain('sudo')
    expect(prompt).toContain('交互式脚手架')
  })

  it('missingArtifacts 非空：注入强制接管段（旧计划作废 + 固定三阶段）且列出缺失文件', () => {
    const prompt = buildReplanPrompt({
      userRequest: 'x',
      state: makePromptState(),
      createdFiles: new Set(['/p/src/main.js']),
      todos: [],
      missingArtifacts: ['package.json（计划声明的产物）', 'src/App.vue（根组件）']
    })
    // 强制接管口吻
    expect(prompt).toContain('旧计划已作废')
    expect(prompt).toContain('不允许做任何多余操作')
    expect(prompt).toContain('package.json（计划声明的产物）')
    expect(prompt).toContain('src/App.vue（根组件）')
    // 固定三阶段
    expect(prompt).toContain('阶段1 生成文件')
    expect(prompt).toContain('阶段2 安装依赖')
    expect(prompt).toContain('阶段3 运行验证')
    // 第一步只能 write_file，禁止 read/edit 污染文件
    expect(prompt).toContain('write_file')
    expect(prompt).toContain('绝对禁止 read_text_file')
    expect(prompt).toContain('edit_file')
  })

  it('missingArtifacts 缺省/空：不注入铁律段', () => {
    const prompt = buildReplanPrompt({
      userRequest: 'x',
      state: makePromptState(),
      createdFiles: new Set(),
      todos: []
    })
    expect(prompt).not.toContain('最高优先级')
    expect(prompt).not.toContain('阶段1 生成文件')
  })
})

// ============ parseReplanResponse ============

describe('parseReplanResponse', () => {
  it('解析 replan 代码块', () => {
    const text =
      '```replan\n' +
      JSON.stringify({
        steps: [
          { content: '创建 src/main.js', kind: 'file', target: 'src/main.js' },
          { content: '执行 npm install', kind: 'command', target: 'npm install' }
        ]
      }) +
      '\n```'
    const steps = parseReplanResponse(text)!
    expect(steps.length).toBe(2)
    expect(steps[0]).toMatchObject({ content: '创建 src/main.js', kind: 'file', target: 'src/main.js' })
    expect(steps[1].kind).toBe('command')
  })

  it('代码块外带解释文字仍能提取', () => {
    const text = '分析如下……\n```replan\n{ "steps": [ { "content": "a" } ] }\n```\n以上。'
    expect(parseReplanResponse(text)!.length).toBe(1)
  })

  it('支持无代码块裸 JSON', () => {
    const steps = parseReplanResponse('{ "steps": [ { "content": "a" }, { "content": "b" } ] }')!
    expect(steps.length).toBe(2)
  })

  it('损坏 JSON 返回 null', () => {
    expect(parseReplanResponse('```replan\n{ broken\n```')).toBeNull()
  })

  it('steps 不是数组返回 null', () => {
    expect(parseReplanResponse('{ "steps": "x" }')).toBeNull()
  })

  it('过滤无 content 的非法项；全部无效时返回 null', () => {
    const text = JSON.stringify({
      steps: [
        { content: '有效' },
        { content: '' },
        { content: '   ' },
        { kind: 'file' },
        'string-item'
      ]
    })
    const steps = parseReplanResponse(text)!
    expect(steps.length).toBe(1)
    expect(steps[0].content).toBe('有效')
    expect(steps[0].kind).toBeUndefined()
  })

  it('非法 kind 不写入，非法 target 不写入', () => {
    const text = JSON.stringify({
      steps: [{ content: 'x', kind: 'other', target: 123 }]
    })
    const step = parseReplanResponse(text)![0]
    expect(step.kind).toBeUndefined()
    expect(step.target).toBeUndefined()
  })

  it('空文本返回 null', () => {
    expect(parseReplanResponse('')).toBeNull()
  })
})

// ============ sanitizeReplanSteps ============

describe('sanitizeReplanSteps', () => {
  /** 模拟门控：命令含 block 字样拦截 */
  const gateFn = (cmd: string) => (cmd.includes('block') ? '拦截理由' : null)

  it('命令类步骤命中门控 → dropped；未命中 → kept', () => {
    const r = sanitizeReplanSteps(
      [
        { content: '写文件', kind: 'file', target: 'a.js' },
        { content: '安全命令', kind: 'command', target: 'npm install' },
        { content: '危险命令', kind: 'command', target: 'vue block app' }
      ],
      gateFn
    )
    expect(r.kept.map((s) => s.content)).toEqual(['写文件', '安全命令'])
    expect(r.dropped.map((s) => s.content)).toEqual(['危险命令'])
  })

  it('文件类步骤即使 target 含门控特征也保留（写入不挂起终端）', () => {
    const r = sanitizeReplanSteps(
      [{ content: '写 vue create 笔记', kind: 'file', target: 'block.md' }],
      gateFn
    )
    expect(r.kept.length).toBe(1)
    expect(r.dropped.length).toBe(0)
  })

  it('命令步骤无 target 时用 content 兜底判定', () => {
    const r = sanitizeReplanSteps(
      [
        { content: '执行 block 命令', kind: 'command' },
        { content: '执行正常命令', kind: 'command' }
      ],
      gateFn
    )
    expect(r.dropped.length).toBe(1)
    expect(r.kept.length).toBe(1)
  })

  it('无 kind 的步骤一律保留', () => {
    const r = sanitizeReplanSteps(
      [{ content: 'block 相关描述' }],
      gateFn
    )
    expect(r.kept.length).toBe(1)
  })

  it('全部被过滤时 kept 为空（调用方放弃重规划）', () => {
    const r = sanitizeReplanSteps(
      [
        { content: 'a', kind: 'command', target: 'block x' },
        { content: 'b', kind: 'command', target: 'block y' }
      ],
      gateFn
    )
    expect(r.kept.length).toBe(0)
    expect(r.dropped.length).toBe(2)
  })

  it('基础文件缺失模式：edit 修补已存在的非缺失文件 → dropped', () => {
    const r = sanitizeReplanSteps(
      [
        // 继续给残缺 main.js 打补丁 → 丢弃
        { content: 'edit src/main.js：删除重复的 const app', kind: 'file', target: 'src/main.js' },
        // write 缺失的 package.json → 保留
        { content: 'write package.json 完整内容', kind: 'file', target: 'package.json' },
        // 安装依赖 → 保留（gateFn 不拦）
        { content: 'npm install', kind: 'command', target: 'npm install' }
      ],
      gateFn,
      {
        missingArtifacts: ['package.json（计划声明的产物）'],
        existingFiles: new Set(['/p/src/main.js'])
      }
    )
    expect(r.kept.map((s) => s.target)).toEqual(['package.json', 'npm install'])
    expect(r.dropped.length).toBe(1)
    expect(r.dropped[0].target).toBe('src/main.js')
  })

  it('基础文件缺失模式：edit 缺失清单内文件也丢弃（污染文件只能整体 write 覆盖）', () => {
    const r = sanitizeReplanSteps(
      [{ content: 'edit package.json：补 scripts 字段', kind: 'file', target: 'package.json' }],
      gateFn,
      { missingArtifacts: ['package.json（缺）'] }
    )
    expect(r.kept.length).toBe(0)
    expect(r.dropped.length).toBe(1)
    expect(r.dropped[0].target).toBe('package.json')
  })

  it('基础文件缺失模式：read_text_file/读取旧文件步骤一律丢弃（第一步只能 write_file）', () => {
    const r = sanitizeReplanSteps(
      [
        { content: 'read_text_file 读取 src/main.js 现状', kind: 'file', target: 'src/main.js' },
        { content: '先读取并查看文件内容', kind: undefined, target: '' },
        { content: 'write_file 完整生成 package.json', kind: 'file', target: 'package.json' }
      ],
      gateFn,
      { missingArtifacts: ['package.json（缺）', 'src/main.js（缺）'] }
    )
    expect(r.kept.map((s) => s.target)).toEqual(['package.json'])
    expect(r.dropped.length).toBe(2)
  })

  it('基础文件缺失模式：只保留「缺失清单文件在前 + 唯一安装命令」，乱序/运行命令/多余文件全丢弃', () => {
    const r = sanitizeReplanSteps(
      [
        { content: 'write_file package.json', kind: 'file', target: 'package.json' },
        { content: 'npm run serve 提前运行', kind: 'command', target: 'npm run serve' },
        { content: 'npm install 安装依赖', kind: 'command', target: 'npm install' },
        { content: '安装后再补 App.vue（乱序）', kind: 'file', target: 'src/App.vue' },
        { content: '多写一个清单外文件', kind: 'file', target: 'src/extra.js' },
        { content: '再装一次（重复安装）', kind: 'command', target: 'npm install' }
      ],
      gateFn,
      { missingArtifacts: ['package.json（缺）', 'src/App.vue（缺）'] }
    )
    expect(r.kept.map((s) => `${s.kind}:${s.target}`)).toEqual([
      'file:package.json',
      'command:npm install'
    ])
    expect(r.dropped.length).toBe(4)
  })

  it('基础文件缺失模式：全局安装 npm i -g 不属于阶段2，丢弃', () => {
    const r = sanitizeReplanSteps(
      [
        { content: 'write package.json', kind: 'file', target: 'package.json' },
        { content: 'npm i -g @vue/cli', kind: 'command', target: 'npm i -g @vue/cli' }
      ],
      gateFn,
      { missingArtifacts: ['package.json（缺）'] }
    )
    expect(r.kept.map((s) => s.target)).toEqual(['package.json'])
  })

  it('不传 options 时行为与旧版一致（file 步骤全保留，edit 描述不拦）', () => {
    const r = sanitizeReplanSteps(
      [{ content: 'edit src/main.js：修语法', kind: 'file', target: 'src/main.js' }],
      gateFn
    )
    expect(r.kept.length).toBe(1)
  })
})

// ============ requestReplan ============

/** 构造只关心 chat 行为的 mock provider */
function makeMockProvider(chatImpl: (params: any) => Promise<any>): AiProvider {
  return {
    id: 'mock',
    displayName: 'Mock',
    health: async () => ({ ok: true }),
    listModels: async () => [],
    chat: chatImpl,
    chatStream: async () => ({ ok: true })
  } as unknown as AiProvider
}

const baseParams = {
  modelName: 'mock-model',
  userRequest: '创建 Vue 项目',
  createdFiles: new Set(['/p/package.json']),
  todos
}

describe('requestReplan', () => {
  it('LLM 返回有效代码块：解析步骤并带耗时', async () => {
    const provider = makeMockProvider(async () => ({
      ok: true,
      content: '```replan\n{ "steps": [ { "content": "npm install --legacy-peer-deps", "kind": "command" } ] }\n```'
    }))
    const state = makePromptState()
    const result = (await requestReplan({ provider, state, ...baseParams }))!
    expect(result).not.toBeNull()
    expect(result.steps.length).toBe(1)
    expect(result.steps[0].content).toContain('legacy-peer-deps')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('ok:false 返回 null', async () => {
    const provider = makeMockProvider(async () => ({ ok: false, error: 'x' }))
    const result = await requestReplan({ provider, state: makePromptState(), ...baseParams })
    expect(result).toBeNull()
  })

  it('content 无有效步骤返回 null', async () => {
    const provider = makeMockProvider(async () => ({ ok: true, content: '无法解析的文本' }))
    const result = await requestReplan({ provider, state: makePromptState(), ...baseParams })
    expect(result).toBeNull()
  })

  it('chat 抛异常被捕获返回 null', async () => {
    const provider = makeMockProvider(async () => {
      throw new Error('network down')
    })
    const result = await requestReplan({ provider, state: makePromptState(), ...baseParams })
    expect(result).toBeNull()
  })

  it('发送给 LLM 的消息为单条 user 且含失败信号', async () => {
    let captured: any
    const provider = makeMockProvider(async (params) => {
      captured = params
      return { ok: true, content: '```replan\n{ "steps": [ { "content": "a" } ] }\n```' }
    })
    await requestReplan({ provider, state: makePromptState(), ...baseParams })
    // 阶段一重构：replanner 不再向 provider 传 model 参数（由 OllamaProvider 从 Registry 拉取）
    expect(captured.model).toBeUndefined()
    expect(captured.messages.length).toBe(1)
    expect(captured.messages[0].role).toBe('user')
    expect(captured.messages[0].content).toContain('ERESOLVE')
  })
})
