// validation.ts 纯函数单测：四类验证器 + 聚合 + 格式化 + vueScaffold 预置 + parseManifest
import { describe, it, expect } from 'vitest'
import {
  runRule,
  runValidation,
  formatValidationMessage,
  parseManifest,
  vueScaffoldManifest,
  type ValidationRule,
  type ValidationContext,
  type ArtifactManifest
} from './validation'

/** 构造 ctx 工具 */
function makeCtx(partial: Partial<ValidationContext> = {}): ValidationContext {
  return {
    createdFiles: partial.createdFiles ?? new Set<string>(),
    executedCommands: partial.executedCommands ?? new Map<string, string>(),
    workspace: partial.workspace
  }
}

// ==================== runRule · fileExists ====================
describe('runRule · fileExists', () => {
  it('精确路径命中（package.json 在 createdFiles）', () => {
    const rule: ValidationRule = {
      id: 'r1',
      description: 'package.json',
      kind: 'fileExists',
      path: 'package.json'
    }
    const ctx = makeCtx({ createdFiles: new Set(['/proj/package.json']) })
    const r = runRule(rule, ctx)
    expect(r.passed).toBe(true)
    expect(r.severity).toBe('block')
  })

  it('后缀匹配：路径以反斜杠存储时仍命中', () => {
    const rule: ValidationRule = {
      id: 'r2',
      description: 'src/main.js',
      kind: 'fileExists',
      path: 'src/main.js'
    }
    const ctx = makeCtx({ createdFiles: new Set(['D:\\proj\\src\\main.js']) })
    expect(runRule(rule, ctx).passed).toBe(true)
  })

  it('大小写不敏感：App.VUE 仍命中 src/App.vue', () => {
    const rule: ValidationRule = {
      id: 'r3',
      description: 'src/App.vue',
      kind: 'fileExists',
      path: 'src/App.vue'
    }
    const ctx = makeCtx({ createdFiles: new Set(['/proj/src/App.VUE']) })
    expect(runRule(rule, ctx).passed).toBe(true)
  })

  it('路径缺失时返回未通过 + 描述作为 message', () => {
    const rule: ValidationRule = {
      id: 'r4',
      description: 'src/App.vue',
      kind: 'fileExists',
      path: 'src/App.vue'
    }
    const ctx = makeCtx({ createdFiles: new Set(['/proj/package.json']) })
    const r = runRule(rule, ctx)
    expect(r.passed).toBe(false)
    expect(r.message).toBe('src/App.vue')
  })

  it('缺少 path 参数：返回未通过且 message 含规则 id', () => {
    const rule: ValidationRule = {
      id: 'r5',
      description: 'bad',
      kind: 'fileExists'
    }
    const r = runRule(rule, makeCtx())
    expect(r.passed).toBe(false)
    expect(r.message).toContain('r5')
  })
})

// ==================== runRule · contentMatch ====================
describe('runRule · contentMatch（二期预留）', () => {
  it('文件不在 createdFiles 时未通过', () => {
    const rule: ValidationRule = {
      id: 'c1',
      description: 'main.js 含 createApp',
      kind: 'contentMatch',
      path: 'src/main.js',
      pattern: 'createApp'
    }
    const r = runRule(rule, makeCtx())
    expect(r.passed).toBe(false)
    expect(r.message).toBe('main.js 含 createApp')
  })

  it('pattern 为 RegExp 也不读磁盘，未通过', () => {
    const rule: ValidationRule = {
      id: 'c2',
      description: '含 export',
      kind: 'contentMatch',
      path: 'src/main.js',
      pattern: /export\s+default/
    }
    expect(runRule(rule, makeCtx()).passed).toBe(false)
  })

  it('缺少 path/pattern：未通过且 message 含规则 id', () => {
    const rule: ValidationRule = {
      id: 'c3',
      description: 'bad',
      kind: 'contentMatch'
    }
    const r = runRule(rule, makeCtx())
    expect(r.passed).toBe(false)
    expect(r.message).toContain('c3')
  })
})

// ==================== runRule · commandExecuted ====================
describe('runRule · commandExecuted', () => {
  it('命令存在且结果为空串 → 通过', () => {
    const rule: ValidationRule = {
      id: 'e1',
      description: 'npm install 未执行',
      kind: 'commandExecuted',
      command: /\bnpm\s+(install|i)\b/
    }
    const ctx = makeCtx({
      executedCommands: new Map([['npm install', '']])
    })
    expect(runRule(rule, ctx).passed).toBe(true)
  })

  it('命令存在但结果含 npm ERR → 未通过', () => {
    const rule: ValidationRule = {
      id: 'e2',
      description: 'npm install 未执行',
      kind: 'commandExecuted',
      command: /\bnpm\s+(install|i)\b/
    }
    const ctx = makeCtx({
      executedCommands: new Map([['npm install', 'npm ERR code ERESOLVE']])
    })
    expect(runRule(rule, ctx).passed).toBe(false)
  })

  it('命令不存在 → 未通过', () => {
    const rule: ValidationRule = {
      id: 'e3',
      description: 'npm run serve 未执行',
      kind: 'commandExecuted',
      command: /\bnpm\s+run\s+(serve|dev)\b/
    }
    const ctx = makeCtx({
      executedCommands: new Map([['npm install', '']])
    })
    expect(runRule(rule, ctx).passed).toBe(false)
  })

  it('字符串命令：子串匹配大小写不敏感', () => {
    const rule: ValidationRule = {
      id: 'e4',
      description: 'npm install 未执行',
      kind: 'commandExecuted',
      command: 'NPM INSTALL'
    }
    const ctx = makeCtx({
      executedCommands: new Map([['npm install', '']])
    })
    expect(runRule(rule, ctx).passed).toBe(true)
  })
})

// ==================== runRule · custom ====================
describe('runRule · custom', () => {
  it('回调返 true → 通过', () => {
    const rule: ValidationRule = {
      id: 'u1',
      description: '自定义通过',
      kind: 'custom',
      check: () => true
    }
    expect(runRule(rule, makeCtx()).passed).toBe(true)
  })

  it('回调返 false → 未通过，message 为 description', () => {
    const rule: ValidationRule = {
      id: 'u2',
      description: '自定义未通过',
      kind: 'custom',
      check: () => false
    }
    const r = runRule(rule, makeCtx())
    expect(r.passed).toBe(false)
    expect(r.message).toBe('自定义未通过')
  })

  it('回调返对象 { passed: false, message } 覆盖 description', () => {
    const rule: ValidationRule = {
      id: 'u3',
      description: '原始描述',
      kind: 'custom',
      check: () => ({ passed: false, message: '覆盖消息' })
    }
    const r = runRule(rule, makeCtx())
    expect(r.passed).toBe(false)
    expect(r.message).toBe('覆盖消息')
  })
})

// ==================== runRule · severity ====================
describe('runRule · severity', () => {
  it('warn 级未通过仍记入 failed，但不影响 allPassed', () => {
    const manifest: ArtifactManifest = {
      id: 'warn-only',
      rules: [
        {
          id: 'w1',
          description: '可选 lint 已跑',
          kind: 'commandExecuted',
          command: /eslint/,
          severity: 'warn'
        }
      ]
    }
    const summary = runValidation(manifest, makeCtx())
    expect(summary.failed.length).toBe(1)
    expect(summary.allPassed).toBe(true) // warn 不阻止
    expect(summary.message).toBe(null)
  })

  it('block 级未通过阻止 allPassed', () => {
    const manifest: ArtifactManifest = {
      id: 'block-only',
      rules: [
        {
          id: 'b1',
          description: 'package.json',
          kind: 'fileExists',
          path: 'package.json'
        }
      ]
    }
    const summary = runValidation(manifest, makeCtx())
    expect(summary.allPassed).toBe(false)
    expect(summary.message).not.toBe(null)
  })
})

// ==================== runValidation ====================
describe('runValidation', () => {
  it('manifest 为 null → allPassed + message null + manifestId null', () => {
    const summary = runValidation(null, makeCtx())
    expect(summary.allPassed).toBe(true)
    expect(summary.failed).toEqual([])
    expect(summary.message).toBe(null)
    expect(summary.manifestId).toBe(null)
  })

  it('manifest 为空 rules → allPassed', () => {
    const summary = runValidation({ id: 'empty', rules: [] }, makeCtx())
    expect(summary.allPassed).toBe(true)
    expect(summary.manifestId).toBe(null)
  })

  it('全部通过 → allPassed true + message null', () => {
    const manifest: ArtifactManifest = {
      id: 'all-pass',
      rules: [
        { id: 'p1', description: 'package.json', kind: 'fileExists', path: 'package.json' }
      ]
    }
    const ctx = makeCtx({ createdFiles: new Set(['/proj/package.json']) })
    const summary = runValidation(manifest, ctx)
    expect(summary.allPassed).toBe(true)
    expect(summary.failed).toEqual([])
    expect(summary.message).toBe(null)
    expect(summary.manifestId).toBe('all-pass')
  })

  it('部分未通过 → allPassed false + failed 列表 + message 非空', () => {
    const manifest: ArtifactManifest = {
      id: 'partial',
      rules: [
        { id: 'p1', description: 'package.json', kind: 'fileExists', path: 'package.json' },
        { id: 'p2', description: 'src/main.js', kind: 'fileExists', path: 'src/main.js' }
      ]
    }
    const ctx = makeCtx({ createdFiles: new Set(['/proj/package.json']) })
    const summary = runValidation(manifest, ctx)
    expect(summary.allPassed).toBe(false)
    expect(summary.failed.length).toBe(1)
    expect(summary.failed[0].ruleId).toBe('p2')
    expect(summary.message).not.toBe(null)
  })
})

// ==================== formatValidationMessage ====================
describe('formatValidationMessage', () => {
  it('vueScaffold 未通过输出含 npm install + npm run serve 模板（逐字对齐旧消息）', () => {
    const ctx = makeCtx({ createdFiles: new Set() })
    const summary = runValidation(vueScaffoldManifest, ctx)
    expect(summary.message).not.toBe(null)
    expect(summary.message).toContain('npm install + npm run serve 均已执行成功')
    expect(summary.message).toContain('严禁输出"任务完成"或结束循环')
    expect(summary.message).toContain('当前已创建 0 个文件')
  })

  it('vueScaffold 未通过且 ctx 缺省时尾巴省略为句号', () => {
    // 直接调用 format，不传 ctx
    const summary = runValidation(vueScaffoldManifest, makeCtx())
    const msg = formatValidationMessage(summary)
    expect(msg).not.toBe(null)
    expect(msg).toContain('npm install + npm run serve 均已执行成功')
  })

  it('通用 manifest 未通过输出通用模板（无 vue 专有文案）', () => {
    const manifest: ArtifactManifest = {
      id: 'generic',
      rules: [
        { id: 'g1', description: 'README.md', kind: 'fileExists', path: 'README.md' }
      ]
    }
    const summary = runValidation(manifest, makeCtx())
    expect(summary.message).not.toBe(null)
    expect(summary.message).toContain('🚫 验证锁未通过')
    expect(summary.message).toContain('README.md')
    expect(summary.message).not.toContain('npm install + npm run serve')
  })

  it('allPassed summary 返回 null', () => {
    const summary = runValidation(null, makeCtx())
    expect(formatValidationMessage(summary)).toBe(null)
  })
})

// ==================== vueScaffoldManifest ====================
describe('vueScaffoldManifest 预置规则', () => {
  it('6 条规则齐全（5 原有 + 编译验证），kind/severity/path/command 字段正确', () => {
    expect(vueScaffoldManifest.id).toBe('vue-scaffold')
    expect(vueScaffoldManifest.rules.length).toBe(6)
    const ids = vueScaffoldManifest.rules.map((r) => r.id)
    expect(ids).toEqual(['vue-pkg', 'vue-main', 'vue-app', 'vue-install', 'vue-serve', 'vue-build-check'])
    const fileRules = vueScaffoldManifest.rules.filter((r) => r.kind === 'fileExists')
    expect(fileRules.length).toBe(3)
    const cmdRules = vueScaffoldManifest.rules.filter((r) => r.kind === 'commandExecuted')
    expect(cmdRules.length).toBe(3)
    // 默认 severity 为 block（runRule 中 severity ?? 'block'）
    expect(vueScaffoldManifest.rules.every((r) => (r.severity ?? 'block') === 'block')).toBe(true)
  })

  it('端到端：ctx 完全为空 → 6 项全未通过，消息含全部缺失项', () => {
    const ctx = makeCtx()
    const summary = runValidation(vueScaffoldManifest, ctx)
    expect(summary.allPassed).toBe(false)
    expect(summary.failed.length).toBe(6)
    expect(summary.message).toContain('package.json')
    expect(summary.message).toContain('src/main.js')
    expect(summary.message).toContain('src/App.vue')
    expect(summary.message).toContain('npm install 未执行')
    expect(summary.message).toContain('npm run serve 未执行')
  })

  it('端到端：全部满足 → allPassed true + message null', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/p/package.json', '/p/src/main.js', '/p/src/App.vue']),
      executedCommands: new Map([
        ['npm install', ''],
        ['npm run serve', '']
      ])
    })
    const summary = runValidation(vueScaffoldManifest, ctx)
    expect(summary.allPassed).toBe(true)
    expect(summary.message).toBe(null)
  })
})

// ==================== parseManifest ====================
describe('parseManifest', () => {
  it('合法 ArtifactManifest 对象 → 原样返回', () => {
    const raw = {
      id: 'test-manifest',
      rules: [
        { id: 't1', description: 'a', kind: 'fileExists', path: 'a.txt' }
      ]
    }
    const m = parseManifest(raw)
    expect(m).not.toBe(null)
    expect(m?.id).toBe('test-manifest')
    expect(m?.rules.length).toBe(1)
  })

  it('非法输入（字符串/缺字段/rules 空） → null', () => {
    expect(parseManifest('hello')).toBe(null)
    expect(parseManifest(null)).toBe(null)
    expect(parseManifest({ id: 'x' })).toBe(null) // 缺 rules
    expect(parseManifest({ id: 'x', rules: [] })).toBe(null) // rules 空
    expect(parseManifest({ id: 'x', rules: [{ bad: true }] })).toBe(null) // 规则缺字段
  })
})
