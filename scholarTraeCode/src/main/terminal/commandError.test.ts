import { describe, it, expect } from 'vitest'
import {
  analyzeCommandError,
  formatErrorForAi,
  isQuickExit,
  formatQuickExitAdvice,
  analyzeExitCode,
  QUICK_EXIT_THRESHOLD_MS,
  formatFastFailBreaker,
  FAST_FAIL_BREAKER_TAG,
  FAST_FAIL_BREAKER_MS
} from './commandError'

describe('analyzeCommandError', () => {
  it('退出码 0 返回 null', () => {
    expect(analyzeCommandError('npm test', 'all passed', 0)).toBeNull()
  })

  it('无输出超时：提示交互等待', () => {
    const r = analyzeCommandError('npm init', '', null)
    expect(r).not.toBeNull()
    expect(r!.summary).toContain('超时')
    expect(r!.hints.join('')).toContain('交互')
  })

  it('无输出非零退出：给出通用排查方向', () => {
    const r = analyzeCommandError('foo', '', 2)
    expect(r!.summary).toContain('2')
    expect(r!.hints.length).toBeGreaterThan(0)
  })

  it('Windows 缺命令：提示联动 probe_environment，severity=manual', () => {
    const out = "'nppm' 不是内部或外部命令，也不是可运行的程序\n或批处理文件。"
    const r = analyzeCommandError('nppm install', out, 1)
    expect(r!.summary).toContain('不是内部或外部命令')
    expect(r!.hints[0]).toContain('probe_environment')
    expect(r!.severity).toBe('manual')
  })

  it('POSIX 缺命令', () => {
    const r = analyzeCommandError('nppm', 'bash: nppm: command not found', 127)
    expect(r!.summary).toContain('command not found')
  })

  it('端口占用', () => {
    const out = 'Error: listen EADDRINUSE: address already in use :::5173'
    const r = analyzeCommandError('npm run dev', out, 1)
    expect(r!.summary).toContain('EADDRINUSE')
    expect(r!.hints[0]).toContain('端口')
  })

  it('缺模块', () => {
    const out = "Error: Cannot find module 'vue'\n    at ..."
    const r = analyzeCommandError('node app.js', out, 1)
    expect(r!.hints[0]).toContain('npm install')
  })

  it('npm 依赖冲突', () => {
    const out = 'npm ERR! code ERESOLVE\nnpm ERR! unable to resolve dependency tree'
    const r = analyzeCommandError('npm install', out, 1)
    expect(r!.hints.join('')).toContain('legacy-peer-deps')
  })

  it('TS 编译错误提示按行号修复', () => {
    const out = "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'."
    const r = analyzeCommandError('tsc', out, 2)
    expect(r!.summary).toContain('error TS2322')
    expect(r!.hints[0]).toContain('第一个 TS 错误')
  })

  it('npm 通用错误指向根因行', () => {
    const out = '> build\n...\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 2'
    const r = analyzeCommandError('npm run build', out, 1)
    expect(r!.hints.join('')).toContain('根因')
  })

  it('非 git 仓库', () => {
    const r = analyzeCommandError('git status', 'fatal: not a git repository', 128)
    expect(r!.hints[0]).toContain('git init')
  })

  it('权限错误', () => {
    const r = analyzeCommandError('touch /x', 'touch: cannot touch: Permission denied', 1)
    expect(r!.hints[0]).toMatch(/管理员|权限/)
  })

  it('未识别错误：摘要取退出码与命令，附通用提示', () => {
    const r = analyzeCommandError('custom-tool', 'something weird happened\nline2', 42)
    expect(r!.summary).toContain('42')
    expect(r!.summary).toContain('custom-tool')
    expect(r!.hints.length).toBe(1)
  })

  it('tail 保留输出尾部 1500 字符', () => {
    const out = 'x'.repeat(2000)
    const r = analyzeCommandError('c', out, 1)
    expect(r!.tail.length).toBe(1500)
  })

  it('同类关键行去重、提示不重复', () => {
    const out = ['npm ERR! one', 'npm ERR! two', 'npm ERR! three', 'npm ERR! four'].join('\n')
    const r = analyzeCommandError('npm i', out, 1)
    expect(r!.hints.length).toBe(1)
  })

  // —— 权限：禁 sudo ——
  it('权限错误：提示禁 sudo，severity=manual', () => {
    const r = analyzeCommandError('touch /x', 'touch: cannot touch: Permission denied', 1)
    expect(r!.hints[0]).toContain('不要尝试 sudo')
    expect(r!.severity).toBe('manual')
  })

  // —— Docker ——
  it('Docker OOMKilled：提示调 --memory，severity=auto', () => {
    const r = analyzeCommandError('docker run app', 'Killed\nOOMKilled', 137)
    expect(r!.hints[0]).toContain('--memory')
    expect(r!.severity).toBe('auto')
  })

  it('Docker 端口映射冲突', () => {
    const r = analyzeCommandError(
      'docker run -p 8080:80 app',
      'Bind for 0.0.0.0:8080 failed: port is already allocated',
      1
    )
    expect(r!.hints[0]).toContain('端口')
  })

  // —— Python ——
  it('Python ModuleNotFoundError：提示 venv + requirements', () => {
    const r = analyzeCommandError('python app.py', "ModuleNotFoundError: No module named 'flask'", 1)
    expect(r!.hints[0]).toContain('venv')
    expect(r!.hints[0]).toContain('requirements')
  })

  it('pip PEP 668 externally-managed：severity=manual', () => {
    const r = analyzeCommandError(
      'pip install flask',
      'error: externally-managed-environment\n× This environment is externally managed',
      1
    )
    expect(r!.hints[0]).toContain('venv')
    expect(r!.severity).toBe('manual')
  })

  it('pip 网络/SSL 错误：提示换镜像源', () => {
    const r = analyzeCommandError(
      'pip install flask',
      'Could not fetch URL https://pypi.org/simple/flask/: There was a problem confirming the ssl certificate',
      1
    )
    expect(r!.hints[0]).toContain('镜像')
  })

  // —— Go ——
  it('Go missing go.sum：提示 go mod tidy，severity=auto', () => {
    const r = analyzeCommandError('go build', 'missing go.sum entry for module github.com/foo/bar', 1)
    expect(r!.hints[0]).toContain('go mod tidy')
    expect(r!.severity).toBe('auto')
  })

  it('Go 无 go.mod：提示 go mod init', () => {
    const r = analyzeCommandError('go build', "go: cannot find main module; see 'go help modules'", 1)
    expect(r!.hints[0]).toContain('go mod init')
  })

  it('Go 模块下载失败：提示 GOPROXY 镜像', () => {
    const r = analyzeCommandError('go mod download', 'go: github.com/foo/bar: dial tcp: connection refused', 1)
    expect(r!.hints[0]).toContain('GOPROXY')
  })

  // —— Linux 系统级 ——
  it('动态库缺失：severity=manual', () => {
    const r = analyzeCommandError(
      './app',
      'error while loading shared libraries: libssl.so.1.1: cannot open shared object file',
      127
    )
    expect(r!.hints[0]).toContain('ldd')
    expect(r!.severity).toBe('manual')
  })

  it('apt 找不到包：提示用户手动 apt update，severity=manual', () => {
    const r = analyzeCommandError('apt install nginx', 'E: Unable to locate package nginx', 100)
    expect(r!.hints[0]).toContain('apt update')
    expect(r!.severity).toBe('manual')
  })

  // —— npm EACCES ——
  it('npm EACCES：禁 sudo，提示 nvm/cache 属主，severity=manual', () => {
    const r = analyzeCommandError('npm install', 'npm ERR! code EACCES', 1)
    expect(r!.hints[0]).toContain('不要 sudo')
    expect(r!.severity).toBe('manual')
  })

  // —— severity 优先级：高优先级规则命中决定分级 ——
  it('多规则命中时取最高优先级规则的 severity', () => {
    // command not found（manual，优先级高）+ npm ERR!（auto）同时出现
    const out = "bash: node: command not found\nnpm ERR! code ELIFECYCLE"
    const r = analyzeCommandError('npm run build', out, 1)
    expect(r!.severity).toBe('manual')
  })
})

describe('formatErrorForAi', () => {
  it('null 返回空串', () => {
    expect(formatErrorForAi(null)).toBe('')
  })
  it('含摘要/修复方向/尾部三段', () => {
    const info = analyzeCommandError('tsc', 'error TS2322: bad', 2)!
    const text = formatErrorForAi(info)
    expect(text).toContain('【诊断摘要】')
    expect(text).toContain('修复方向：')
    expect(text).toContain('【输出尾部】')
    expect(text).toContain('error TS2322: bad')
  })
  it('severity=auto 输出【AI 可自修】', () => {
    const info = analyzeCommandError('go build', 'missing go.sum entry for module x', 1)!
    expect(formatErrorForAi(info)).toContain('【AI 可自修】')
  })
  it('severity=manual 输出【需用户介入】', () => {
    const info = analyzeCommandError('apt install x', 'E: Unable to locate package x', 100)!
    expect(formatErrorForAi(info)).toContain('【需用户介入】')
  })
})

describe('秒退检测 isQuickExit / formatQuickExitAdvice', () => {
  it('低于 500ms 且非零退出 → 秒退', () => {
    expect(isQuickExit(2, 1)).toBe(true)
    expect(isQuickExit(QUICK_EXIT_THRESHOLD_MS - 1, 99)).toBe(true)
  })
  it('退出码 0 / 超时(null) / 达到阈值 → 非秒退', () => {
    expect(isQuickExit(2, 0)).toBe(false)
    expect(isQuickExit(2, null)).toBe(false)
    expect(isQuickExit(QUICK_EXIT_THRESHOLD_MS, 1)).toBe(false)
    expect(isQuickExit(5000, 1)).toBe(false)
  })
  it('秒退建议以「错误：」开头且含耗时/退出码/强制反思/三阶段指引', () => {
    const text = formatQuickExitAdvice('npm run serve', 1, 2)
    expect(text).not.toBeNull()
    expect(text).toMatch(/^错误：/)
    expect(text).toContain('耗时仅 2ms')
    expect(text).toContain('退出码 1')
    expect(text).toContain('npm run serve')
    expect(text).toContain('强制反思')
    expect(text).toContain('npm install')
  })
  it('复合命令只取首段点名；非秒退返回 null', () => {
    const text = formatQuickExitAdvice('cd app && npm run dev', 1, 10)
    expect(text).toContain('cd app')
    expect(formatQuickExitAdvice('npm run serve', 0, 2)).toBeNull()
  })

  it('python 命令秒退：按画像指引 requirements.txt 与 pip install -r', () => {
    const text = formatQuickExitAdvice('python main.py', 1, 2)
    expect(text).not.toBeNull()
    expect(text).toContain('requirements.txt')
    expect(text).toContain('pip install -r requirements.txt')
    expect(text).toContain('强制反思')
  })

  it('go 命令秒退：按画像指引 go.mod 与 go mod tidy', () => {
    const text = formatQuickExitAdvice('go build', 1, 2)
    expect(text).not.toBeNull()
    expect(text).toContain('go.mod')
    expect(text).toContain('go mod tidy')
  })

  it('通用兜底（识别不出生态）：环境未初始化或拼写错误', () => {
    const text = formatQuickExitAdvice('some-weird-tool --run', 1, 2)
    expect(text).not.toBeNull()
    expect(text).toContain('命令瞬间失败退出，通常是因为环境未初始化或命令拼写错误')
    expect(text).toContain('强制反思')
  })
})

describe('analyzeExitCode（非零退出强制标记）', () => {
  it('退出码 0 / null 返回空串（不打断 AI 流）', () => {
    expect(analyzeExitCode('all passed', 0)).toBe('')
    expect(analyzeExitCode('', null)).toBe('')
  })

  it('非零退出：含 [EXECUTION_FAILED] 标签与反思指令', () => {
    const tag = analyzeExitCode('some error output', 1)
    expect(tag).toContain('[EXECUTION_FAILED]')
    expect(tag).toContain('非零退出码 1')
    expect(tag).toContain('禁止不做分析继续后续文件修改')
  })

  it('附带 stderr 输出尾部 10 行（过滤空行）', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`)
    const output = lines.join('\n') + '\n\n' // 末尾空行应被过滤
    const tag = analyzeExitCode(output, 2)
    expect(tag).toContain('【输出尾部 10 行】')
    expect(tag).toContain('line 15')
    expect(tag).toContain('line 6')
    // 第 5 行在尾部 10 行之外，不应出现
    expect(tag).not.toContain('line 5')
  })

  it('无输出时不附尾部块', () => {
    const tag = analyzeExitCode('', 1)
    expect(tag).toContain('[EXECUTION_FAILED]')
    expect(tag).not.toContain('【输出尾部 10 行】')
  })
})

describe('formatFastFailBreaker（秒退熔断器）', () => {
  it('退出码 0 / null 不熔断（成功或超时场景不归本熔断管）', () => {
    expect(formatFastFailBreaker('npm run dev', 0, 4)).toBeNull()
    expect(formatFastFailBreaker('npm run dev', null, 4)).toBeNull()
  })

  it('耗时 ≥ 阈值不熔断（慢失败另有 quick-exit 反思建议兜底）', () => {
    expect(formatFastFailBreaker('npm run dev', 1, FAST_FAIL_BREAKER_MS)).toBeNull()
    expect(formatFastFailBreaker('npm run dev', 1, 5000)).toBeNull()
  })

  it('非零退出且秒退：带熔断标记 + 耗时/退出码 + 强中断指令', () => {
    const text = formatFastFailBreaker('npm run dev', 1, 4)!
    expect(text).toContain(FAST_FAIL_BREAKER_TAG)
    expect(text).toContain('【致命错误】')
    expect(text).toContain('耗时 4ms')
    expect(text).toContain('退出码 1')
    expect(text).toContain('npm run dev')
    expect(text).toContain('禁止继续执行任何后续命令')
    expect(text).toContain('read_file')
    expect(text).toContain('list_directory')
  })

  it('复合命令只取命令头（截断 & 后段）', () => {
    const text = formatFastFailBreaker('cd vue2-project && npm run dev', 2, 10)!
    expect(text).toContain('cd vue2-project')
    expect(text).not.toContain('&& npm run dev。')
  })

  it('耗时恰为阈值-1ms 仍触发（边界内含）', () => {
    const text = formatFastFailBreaker('npm run dev', 1, FAST_FAIL_BREAKER_MS - 1)
    expect(text).toContain(FAST_FAIL_BREAKER_TAG)
    expect(text).toContain(`耗时 ${FAST_FAIL_BREAKER_MS - 1}ms`)
  })

  it('负耗时（时钟异常）按 0ms 展示且仍触发', () => {
    const text = formatFastFailBreaker('npm run dev', 1, -5)!
    expect(text).toContain('耗时 0ms')
    expect(text).toContain(FAST_FAIL_BREAKER_TAG)
  })

  it('空命令串回退「命令」占位，不产生空引用', () => {
    const text = formatFastFailBreaker('', 1, 3)!
    expect(text).toContain('：命令。')
  })
})
