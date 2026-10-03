import { describe, it, expect } from 'vitest'
import {
  TEMPLATE_REGISTRY,
  AVAILABLE_TEMPLATE_IDS,
  getTemplate,
  resolveTemplateReference,
  vueScaffoldManifest
} from './validationTemplates'
import { runValidation, type ValidationContext } from './validation'

function makeCtx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    createdFiles: new Set<string>(),
    executedCommands: new Map<string, string>(),
    ...overrides
  }
}

describe('TEMPLATE_REGISTRY', () => {
  it('包含 11 个模板工厂（vue 双别名 + node/python/go/rust/docker 各含服务/cli/应用别名）', () => {
    const ids = Object.keys(TEMPLATE_REGISTRY)
    expect(ids).toContain('vue-scaffold')
    expect(ids).toContain('vue-project')
    expect(ids).toContain('node-service')
    expect(ids).toContain('python-project')
    expect(ids).toContain('python-service')
    expect(ids).toContain('go-project')
    expect(ids).toContain('go-cli')
    expect(ids).toContain('rust-project')
    expect(ids).toContain('rust-app')
    expect(ids).toContain('docker-service')
    expect(ids).toContain('docker-compose')
  })

  it('vue-scaffold 与 vue-project 是同一模板的别名', () => {
    const a = getTemplate('vue-scaffold')!
    const b = getTemplate('vue-project')!
    expect(a.id).toBe(b.id)
    expect(a.rules.length).toBe(b.rules.length)
  })

  it('AVAILABLE_TEMPLATE_IDS 与注册表一致', () => {
    expect(AVAILABLE_TEMPLATE_IDS.sort()).toEqual(Object.keys(TEMPLATE_REGISTRY).sort())
  })
})

describe('getTemplate 深拷贝', () => {
  it('返回的 manifest 修改不影响单例', () => {
    const tpl = getTemplate('go-project')!
    tpl.rules.push({ id: 'hack', description: 'x', kind: 'fileExists', path: 'x' })
    const again = getTemplate('go-project')!
    expect(again.rules.length).toBe(4)
  })

  it('未知 id 返回 null', () => {
    expect(getTemplate('not-exist')).toBeNull()
  })
})

describe('resolveTemplateReference', () => {
  it('纯 template 引用返回模板深拷贝', () => {
    const m = resolveTemplateReference({ template: 'go-project' })!
    expect(m.id).toBe('go-project')
    expect(m.rules.length).toBe(4)
  })

  it('template 引用 + 自定义 rules 追加', () => {
    const m = resolveTemplateReference({
      template: 'go-project',
      rules: [{ id: 'extra', description: 'README.md', kind: 'fileExists', path: 'README.md' }]
    })!
    expect(m.rules.length).toBe(5)
    expect(m.rules[m.rules.length - 1].id).toBe('extra')
  })

  it('显式 id 覆盖模板 id', () => {
    const m = resolveTemplateReference({ template: 'go-project', id: 'my-go' })!
    expect(m.id).toBe('my-go')
  })

  it('无 template 字段返回 null（交给 parseManifest 内联解析）', () => {
    expect(resolveTemplateReference({ id: 'x', rules: [] })).toBeNull()
  })

  it('未知 template id 返回 null', () => {
    expect(resolveTemplateReference({ template: 'nope' })).toBeNull()
  })
})

describe('各模板验证行为', () => {
  it('vue-scaffold：package.json/main.js/App.vue + npm install + serve + 编译验证', () => {
    const m = getTemplate('vue-scaffold')!
    const summary = runValidation(m, makeCtx())
    expect(summary.allPassed).toBe(false)
    const failedIds = summary.failed.map((r) => r.ruleId)
    expect(failedIds).toEqual(['vue-pkg', 'vue-main', 'vue-app', 'vue-install', 'vue-serve', 'vue-build-check'])
  })

  it('vue-scaffold 全部满足时通过', () => {
    const m = getTemplate('vue-scaffold')!
    const ctx = makeCtx({
      createdFiles: new Set(['/p/package.json', '/p/src/main.js', '/p/src/App.vue']),
      executedCommands: new Map([['npm install', ''], ['npm run serve', '']])
    })
    expect(runValidation(m, ctx).allPassed).toBe(true)
  })

  it('vue-scaffold：编译命令失败（退出码非零）时 build-check 不通过', () => {
    const m = getTemplate('vue-scaffold')!
    const ctx = makeCtx({
      createdFiles: new Set(['/p/package.json', '/p/src/main.js', '/p/src/App.vue']),
      executedCommands: new Map([
        ['npm install', ''],
        ['npm run serve', '退出码 1\nERROR in src/main.js: SyntaxError']
      ])
    })
    const failedIds = runValidation(m, ctx).failed.map((r) => r.ruleId)
    expect(failedIds).toContain('vue-build-check')
    expect(failedIds).toContain('vue-serve')
  })

  it('go-project：go.mod + main.go + go mod tidy + go build', () => {
    const m = getTemplate('go-project')!
    const failedIds = runValidation(m, makeCtx()).failed.map((r) => r.ruleId)
    expect(failedIds).toEqual(['go-mod', 'go-main', 'go-tidy', 'go-build'])
  })

  it('go-project 全部满足时通过', () => {
    const m = getTemplate('go-project')!
    const ctx = makeCtx({
      createdFiles: new Set(['/p/go.mod', '/p/main.go']),
      executedCommands: new Map([['go mod tidy', ''], ['go build ./...', '']])
    })
    expect(runValidation(m, ctx).allPassed).toBe(true)
  })

  it('rust-project：Cargo.toml + src/main.rs + cargo build', () => {
    const m = getTemplate('rust-project')!
    const failedIds = runValidation(m, makeCtx()).failed.map((r) => r.ruleId)
    expect(failedIds).toEqual(['rust-toml', 'rust-main', 'rust-build'])
  })

  it('python-project：requirements.txt + main.py + pip install -r + python 入口', () => {
    const m = getTemplate('python-project')!
    const failedIds = runValidation(m, makeCtx()).failed.map((r) => r.ruleId)
    expect(failedIds).toEqual(['py-req', 'py-entry', 'py-install', 'py-run'])
  })

  it('docker-service：Dockerfile + docker-compose.yml + docker compose config', () => {
    const m = getTemplate('docker-service')!
    const failedIds = runValidation(m, makeCtx()).failed.map((r) => r.ruleId)
    expect(failedIds).toEqual(['docker-dockerfile', 'docker-compose', 'docker-config'])
  })

  it('node-service：package.json + index.js + npm install + 启动', () => {
    const m = getTemplate('node-service')!
    const failedIds = runValidation(m, makeCtx()).failed.map((r) => r.ruleId)
    expect(failedIds).toEqual(['node-pkg', 'node-entry', 'node-install', 'node-start'])
  })
})

describe('vueScaffoldManifest 与 validation.ts 重导出一致', () => {
  it('id 仍为 vue-scaffold，6 条规则', () => {
    expect(vueScaffoldManifest.id).toBe('vue-scaffold')
    expect(vueScaffoldManifest.rules.length).toBe(6)
  })
})
