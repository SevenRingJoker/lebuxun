// s45 失败分类器与修复动作生成 · 纯函数单测
import { describe, expect, it } from 'vitest'
import {
  classifyFailure,
  proposeRepairs,
  npmPackageName,
  pypiPackageName,
  formatRepairForAi
} from './repairAdvisor'

describe('classifyFailure 四分类', () => {
  it('exitCode=0 不分类', () => {
    expect(classifyFailure('npm test', 'ok', 0)).toBeNull()
  })

  it('npm 缺包 → missing-dep 且提取包名', () => {
    const r = classifyFailure('node app.js', "Error: Cannot find module 'lodash'", 1)!
    expect(r.category).toBe('missing-dep')
    expect(r.subject).toBe('lodash')
  })

  it('相对路径缺模块 → code（导入路径问题而非缺包）', () => {
    const r = classifyFailure('node app.js', "Error: Cannot find module './utils/helper'", 1)!
    expect(r.category).toBe('code')
  })

  it('python ModuleNotFoundError → missing-dep', () => {
    const r = classifyFailure('python app.py', "ModuleNotFoundError: No module named 'flask'", 1)!
    expect(r.category).toBe('missing-dep')
    expect(r.subject).toBe('flask')
  })

  it('npm ERESOLVE → version-conflict', () => {
    const r = classifyFailure('npm install', 'npm ERR! ERESOLVE unable to resolve dependency tree', 1)!
    expect(r.category).toBe('version-conflict')
  })

  it('命令不存在 → system + manual + 提取命令名', () => {
    const r = classifyFailure('nppm i', "'nppm' 不是内部或外部命令，也不是可运行的程序", 9009)!
    expect(r.category).toBe('system')
    expect(r.severity).toBe('manual')
    expect(r.subject).toBe('nppm')
  })

  it('posix command not found 提取命令名', () => {
    const r = classifyFailure('foo', 'bash: foo: command not found', 127)!
    expect(r.category).toBe('system')
    expect(r.subject).toBe('foo')
  })

  it('权限不足 → system + manual', () => {
    const r = classifyFailure('touch /x', 'touch: cannot touch: Permission denied', 1)!
    expect(r.category).toBe('system')
    expect(r.severity).toBe('manual')
  })

  it('pip 网络错误 → system（可换镜像）', () => {
    const r = classifyFailure(
      'pip install flask',
      'WARNING: Retrying... Could not fetch URL https://pypi.org/simple/flask/: ReadTimeoutError',
      1
    )!
    expect(r.category).toBe('system')
  })

  it('TS 编译错误 → code', () => {
    const r = classifyFailure('tsc', 'src/a.ts(1,7): error TS2322: Type X is not assignable', 2)!
    expect(r.category).toBe('code')
  })

  it('未识别 → unknown', () => {
    const r = classifyFailure('custom', 'something weird happened', 42)!
    expect(r.category).toBe('unknown')
  })
})

describe('proposeRepairs 修复动作', () => {
  it('npm 缺包 → install-dep 命令', () => {
    const r = classifyFailure('node a.js', "Cannot find module 'axios'", 1)!
    const acts = proposeRepairs(r)
    const npm = acts.find((a) => a.id === 'npm-install:axios')
    expect(npm?.command).toBe('npm install axios')
    expect(npm?.risk).toBe('low')
  })

  it('python 缺包 → pip 与 npm 双候选（生态不确定）', () => {
    const r = classifyFailure('python a.py', "ModuleNotFoundError: No module named 'flask'", 1)!
    const acts = proposeRepairs(r)
    expect(acts.some((a) => a.command === 'pip install flask')).toBe(true)
    expect(acts.some((a) => a.command === 'npm install flask')).toBe(true)
  })

  it('模块名≠包名：cv2 → opencv-python', () => {
    const r = classifyFailure('python a.py', "ModuleNotFoundError: No module named 'cv2'", 1)!
    const acts = proposeRepairs(r)
    expect(acts.some((a) => a.command === 'pip install opencv-python')).toBe(true)
  })

  it('@scope/pkg/sub 截到包名', () => {
    const r = classifyFailure('node a.js', "Cannot find module '@vueuse/core/shared'", 1)!
    const acts = proposeRepairs(r)
    expect(acts.some((a) => a.command === 'npm install @vueuse/core')).toBe(true)
  })

  it('版本冲突 → legacy-peer-deps + 锁版本建议（纯建议无命令）', () => {
    const r = classifyFailure('npm i', 'npm ERR! ERESOLVE unable to resolve dependency tree', 1)!
    const acts = proposeRepairs(r)
    expect(acts.some((a) => a.command === 'npm install --legacy-peer-deps')).toBe(true)
    const advice = acts.find((a) => a.id === 'pin-version-advice')
    expect(advice?.command).toBeNull()
  })

  it('pip 网络错 → 清华镜像动作', () => {
    const r = classifyFailure('pip install x', 'Could not fetch URL https://pypi.org/simple/x/', 1)!
    const acts = proposeRepairs(r)
    expect(acts.some((a) => a.command?.includes('pypi.tuna.tsinghua.edu.cn'))).toBe(true)
  })

  it('命令不存在 → 手动安装建议（无命令）', () => {
    const r = classifyFailure('nppm', "'nppm' 不是内部或外部命令", 9009)!
    const acts = proposeRepairs(r)
    const m = acts.find((a) => a.kind === 'manual-step')
    expect(m?.command).toBeNull()
    expect(m?.note).toContain('nppm')
  })

  it('code 类不给自动动作', () => {
    const r = classifyFailure('tsc', 'error TS2322: bad', 2)!
    expect(proposeRepairs(r)).toEqual([])
  })

  it('unknown 不给动作', () => {
    const r = classifyFailure('x', 'weird', 9)!
    expect(proposeRepairs(r)).toEqual([])
  })
})

describe('包名归一', () => {
  it('npm 子路径截断', () => {
    expect(npmPackageName('lodash/fp')).toBe('lodash')
    expect(npmPackageName('@scope/pkg/sub')).toBe('@scope/pkg')
    expect(npmPackageName('axios')).toBe('axios')
  })

  it('pypi 别名表', () => {
    expect(pypiPackageName('cv2')).toBe('opencv-python')
    expect(pypiPackageName('PIL')).toBe('Pillow')
    expect(pypiPackageName('flask')).toBe('flask')
    expect(pypiPackageName('os.path')).toBe('os')
  })
})

describe('formatRepairForAi', () => {
  it('有动作时输出建议段', () => {
    const r = classifyFailure('node a.js', "Cannot find module 'axios'", 1)!
    const text = formatRepairForAi({
      origin: 'bash',
      command: 'node a.js',
      cwd: '/x',
      report: r,
      actions: proposeRepairs(r)
    })
    expect(text).toContain('缺依赖')
    expect(text).toContain('npm install axios')
    expect(text).toContain('修复确认卡片')
  })

  it('无动作返回空串', () => {
    const r = classifyFailure('tsc', 'error TS2322: bad', 2)!
    expect(
      formatRepairForAi({ origin: 'bash', command: 'tsc', cwd: '/x', report: r, actions: [] })
    ).toBe('')
  })
})
