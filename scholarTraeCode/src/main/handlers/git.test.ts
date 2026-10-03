// Git porcelain 解析与纯逻辑单测（不实际执行 git 命令）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import {
  parsePorcelain, classifyStatus, sanitizeCommitMessage, parseLog, planCreatedFileCleanup,
  groupChanges, toScmItem, validateScmPaths, MAX_SCM_PATHS,
  stagePaths, unstagePaths, statusGrouped, initRepo, createCheckpoint, restoreTrackedFile,
  commitStaged, parseBranchList, isValidBranchName, listBranches, switchBranch, createBranch
} from './git'

// 本机 git 不可用时，真实仓库 IO 用例整体跳过（纯函数用例不受影响）
const gitReady = spawnSync('git', ['--version'], { windowsHide: true }).status === 0
const itGit = gitReady ? it : it.skip

describe('parsePorcelain — git status --porcelain=v1 -z', () => {
  it('解析未跟踪文件 ??', () => {
    const changes = parsePorcelain('?? src/new-file.ts\0')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      path: 'src/new-file.ts',
      status: 'untracked',
      staged: false
    })
    expect(changes[0].rawCode).toBe('??')
  })

  it('解析工作区修改 " M"（未暂存）', () => {
    const changes = parsePorcelain(' M package.json\0')
    expect(changes[0]).toMatchObject({
      path: 'package.json',
      status: 'modified',
      staged: false
    })
  })

  it('解析暂存修改 "M "（已暂存）', () => {
    const changes = parsePorcelain('M  src/app.ts\0')
    expect(changes[0]).toMatchObject({ status: 'modified', staged: true })
  })

  it('解析暂存新增 "A "', () => {
    const changes = parsePorcelain('A  src/a.js\0')
    expect(changes[0].status).toBe('added')
    expect(changes[0].staged).toBe(true)
  })

  it('解析工作区删除 " D"', () => {
    const changes = parsePorcelain(' D old.js\0')
    expect(changes[0].status).toBe('deleted')
  })

  it('解析暂存删除 "D "', () => {
    const changes = parsePorcelain('D  gone.js\0')
    expect(changes[0].status).toBe('deleted')
    expect(changes[0].staged).toBe(true)
  })

  it('解析 rename："R  newPath\0oldPath\0" 双 token', () => {
    const changes = parsePorcelain('R  src/new-name.ts\0src/old-name.ts\0')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      path: 'src/new-name.ts',
      oldPath: 'src/old-name.ts',
      status: 'renamed',
      staged: true
    })
  })

  it('连续多个条目且路径含空格', () => {
    const out = '?? my file.txt\0 M src/a b.ts\0'
    const changes = parsePorcelain(out)
    expect(changes).toHaveLength(2)
    expect(changes[0].path).toBe('my file.txt')
    expect(changes[1].path).toBe('src/a b.ts')
  })

  it('中文路径正确解析（quotepath=false 时为 UTF-8 原文）', () => {
    const changes = parsePorcelain('?? docs/项目结构说明.md\0')
    expect(changes[0].path).toBe('docs/项目结构说明.md')
  })

  it('空输出返回空数组', () => {
    expect(parsePorcelain('')).toEqual([])
    expect(parsePorcelain('\0')).toEqual([])
  })

  it('多条目混合状态', () => {
    const out = 'M  a.ts\0 M b.ts\0?? c.ts\0 D d.ts\0'
    const changes = parsePorcelain(out)
    expect(changes.map((c) => c.status)).toEqual([
      'modified',
      'modified',
      'untracked',
      'deleted'
    ])
  })
})

describe('classifyStatus 状态码映射', () => {
  it('双端修改 MM 仍为 modified', () => {
    expect(classifyStatus('M', 'M')).toBe('modified')
  })
  it('未知状态码回落 unknown', () => {
    expect(classifyStatus('!', '!')).toBe('unknown')
  })
})

describe('groupChanges — SCM 三组拆分', () => {
  it('?? 只进 untracked', () => {
    const g = groupChanges(parsePorcelain('?? new.ts\0'))
    expect(g.untracked).toHaveLength(1)
    expect(g.staged).toHaveLength(0)
    expect(g.unstaged).toHaveLength(0)
  })

  it('工作区修改 " M" 只进 unstaged', () => {
    const g = groupChanges(parsePorcelain(' M a.ts\0'))
    expect(g.unstaged).toHaveLength(1)
    expect(g.staged).toHaveLength(0)
    expect(g.unstaged[0].worktreeLetter).toBe('M')
    expect(g.unstaged[0].indexLetter).toBe(' ')
  })

  it('暂存修改 "M " 只进 staged', () => {
    const g = groupChanges(parsePorcelain('M  a.ts\0'))
    expect(g.staged).toHaveLength(1)
    expect(g.unstaged).toHaveLength(0)
    expect(g.staged[0].indexLetter).toBe('M')
  })

  it('暂存新增 A 与暂存删除 D 都进 staged', () => {
    const g = groupChanges(parsePorcelain('A  a.ts\0D  b.ts\0'))
    expect(g.staged.map((i) => i.path)).toEqual(['a.ts', 'b.ts'])
    expect(g.staged[0].indexLetter).toBe('A')
    expect(g.staged[1].indexLetter).toBe('D')
  })

  it('「暂存后再改」MM 同一文件同现两组', () => {
    const changes = parsePorcelain('MM a.ts\0')
    const g = groupChanges(changes)
    expect(g.staged).toHaveLength(1)
    expect(g.unstaged).toHaveLength(1)
    expect(g.staged[0].path).toBe('a.ts')
    expect(g.unstaged[0].path).toBe('a.ts')
  })

  it('AM（暂存新增后又修改）同现两组且字母正确', () => {
    const g = groupChanges(parsePorcelain('AM a.ts\0'))
    expect(g.staged[0].indexLetter).toBe('A')
    expect(g.unstaged[0].worktreeLetter).toBe('M')
  })

  it('MD（暂存修改后工作区删除）同现两组', () => {
    const g = groupChanges(parsePorcelain('MD a.ts\0'))
    expect(g.staged[0].indexLetter).toBe('M')
    expect(g.unstaged[0].worktreeLetter).toBe('D')
  })

  it('rename 暂存携带 oldPath', () => {
    const g = groupChanges(parsePorcelain('R  new.ts\0old.ts\0'))
    expect(g.staged).toHaveLength(1)
    expect(g.staged[0].path).toBe('new.ts')
    expect(g.staged[0].oldPath).toBe('old.ts')
    expect(g.staged[0].indexLetter).toBe('R')
  })

  it('混合列表三组归类与顺序保持', () => {
    const out = 'M  a.ts\0 M b.ts\0?? c.ts\0 D d.ts\0MM e.ts\0'
    const g = groupChanges(parsePorcelain(out))
    expect(g.staged.map((i) => i.path)).toEqual(['a.ts', 'e.ts'])
    expect(g.unstaged.map((i) => i.path)).toEqual(['b.ts', 'd.ts', 'e.ts'])
    expect(g.untracked.map((i) => i.path)).toEqual(['c.ts'])
  })

  it('空输入三组均为空数组', () => {
    const g = groupChanges([])
    expect(g.staged).toEqual([])
    expect(g.unstaged).toEqual([])
    expect(g.untracked).toEqual([])
  })
})

describe('toScmItem', () => {
  it('拆出双字母并保留路径信息', () => {
    const [c] = parsePorcelain('R  src/新名.ts\0src/旧名.ts\0')
    const item = toScmItem(c)
    expect(item.rawCode).toBe('R ')
    expect(item.indexLetter).toBe('R')
    expect(item.worktreeLetter).toBe(' ')
    expect(item.path).toBe('src/新名.ts')
    expect(item.oldPath).toBe('src/旧名.ts')
  })
})

describe('sanitizeCommitMessage', () => {
  it('换行被替换为空格（防多行注入）', () => {
    expect(sanitizeCommitMessage('line1\nline2\r\nline3')).toBe('line1 line2 line3')
  })
  it('空标签回落默认文案', () => {
    expect(sanitizeCommitMessage('   ')).toBe('检查点')
  })
  it('超长标签截断到 200 字符', () => {
    const long = 'x'.repeat(300)
    expect(sanitizeCommitMessage(long)).toHaveLength(200)
  })
})

describe('parseLog 检查点历史', () => {
  it('解析自定义分隔输出并识别 trae 检查点', () => {
    const out = [
      ['abc1234def567890', 'abc1234', 'TraeCode', '2026-09-29 10:00', 'trae-checkpoint: AI 任务前自动检查点'].join('\x1f'),
      ['9876543210fedcba', '9876543', 'Zhang San', '2026-09-28 09:30', 'feat: 初始提交'].join('\x1f')
    ].join('\n')
    const list = parseLog(out)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({
      hash: 'abc1234def567890',
      shortHash: 'abc1234',
      author: 'TraeCode',
      isTrae: true
    })
    expect(list[1].isTrae).toBe(false)
  })

  it('空输出返回空数组', () => {
    expect(parseLog('')).toEqual([])
  })
})

// ㊜ 1b：放弃回滚后，只删任务新建的未跟踪文件，检查点固化的预存文件必须保留
describe('planCreatedFileCleanup', () => {
  const root = 'D:/ws'
  it('未跟踪的新建文件 → 删除', () => {
    const r = planCreatedFileCleanup(root, ['D:\\ws\\new.txt'], new Set())
    expect(r).toEqual(['D:\\ws\\new.txt'])
  })
  it('回滚后仍被跟踪（预存文件）→ 保留', () => {
    const r = planCreatedFileCleanup(root, ['D:\\ws\\keep.txt'], new Set(['keep.txt']))
    expect(r).toEqual([])
  })
  it('工作区外路径 → 保留', () => {
    const r = planCreatedFileCleanup(root, ['D:\\other\\x.txt'], new Set())
    expect(r).toEqual([])
  })
  it('重复/混合名单去重，只删未跟踪项', () => {
    const r = planCreatedFileCleanup(
      root,
      ['D:\\ws\\a.txt', 'D:/ws/a.txt', 'D:\\ws\\sub\\b.txt'],
      new Set(['sub/b.txt'])
    )
    expect(r).toEqual(['D:\\ws\\a.txt'])
  })
})

// s12：暂存路径校验（纯函数）
describe('validateScmPaths', () => {
  const root = join(tmpdir(), 'scm-validate-root').replaceAll('\\', '/')

  it('合法相对路径通过并统一正斜杠、去重', () => {
    const r = validateScmPaths(root, ['src/a.ts', 'src\\b.ts', 'src/a.ts', '  '])
    expect(r.ok).toBe(true)
    expect(r.data).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('非数组 / 超上限拒绝', () => {
    expect(validateScmPaths(root, 'x' as unknown as string[]).ok).toBe(false)
    const tooMany = Array.from({ length: MAX_SCM_PATHS + 1 }, (_, i) => `f${i}.ts`)
    expect(validateScmPaths(root, tooMany).ok).toBe(false)
  })

  it('目录穿越路径拒绝（.. 解析后落在 root 外）', () => {
    expect(validateScmPaths(root, ['../evil.txt']).ok).toBe(false)
    expect(validateScmPaths(root, ['src/../../evil.txt']).ok).toBe(false)
  })

  it('绝对路径拒绝（POSIX 与 Windows 盘符）', () => {
    expect(validateScmPaths(root, ['/etc/passwd']).ok).toBe(false)
    expect(validateScmPaths(root, ['D:/other/x.ts']).ok).toBe(false)
  })

  it('pathspec 魔法前缀与选项前缀拒绝', () => {
    expect(validateScmPaths(root, [':(glob)*.ts']).ok).toBe(false)
    expect(validateScmPaths(root, ['--all']).ok).toBe(false)
  })

  it('空数组合法（语义=全部）', () => {
    const r = validateScmPaths(root, [])
    expect(r).toEqual({ ok: true, data: [] })
  })
})

// s12：tmpdir 下真实 git 仓库的暂存/取消暂存
describe('stagePaths / unstagePaths — 真实仓库', () => {
  let root: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'scm-stage-'))
    await initRepo(root)
    // 基线提交：固化 a.ts
    writeFileSync(join(root, 'a.ts'), 'one\n')
    const cp = await createCheckpoint(root, '基线')
    expect(cp.ok).toBe(true)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  itGit('暂存未跟踪文件后进入 staged 组', async () => {
    writeFileSync(join(root, 'b.ts'), 'b\n')
    const r = await stagePaths(root, ['b.ts'])
    expect(r.ok).toBe(true)
    const g = await statusGrouped(root)
    expect(g.data?.staged.map((i) => i.path)).toContain('b.ts')
    expect(g.data?.staged[0].indexLetter).toBe('A')
  })

  itGit('取消暂存后回到 untracked 组', async () => {
    const r = await unstagePaths(root, ['b.ts'])
    expect(r.ok).toBe(true)
    const g = await statusGrouped(root)
    expect(g.data?.staged.map((i) => i.path)).not.toContain('b.ts')
    expect(g.data?.untracked.map((i) => i.path)).toContain('b.ts')
  })

  itGit('空数组暂存全部 / 取消暂存全部', async () => {
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sub', 'c.ts'), 'c\n')
    expect((await stagePaths(root, [])).ok).toBe(true)
    let g = await statusGrouped(root)
    expect(g.data?.staged.map((i) => i.path).sort()).toEqual(['b.ts', 'sub/c.ts'])
    expect((await unstagePaths(root, [])).ok).toBe(true)
    g = await statusGrouped(root)
    expect(g.data?.staged).toHaveLength(0)
    expect(g.data?.untracked.map((i) => i.path).sort()).toEqual(['b.ts', 'sub/c.ts'])
  })

  itGit('已跟踪文件修改：staged 字母 M，取消后转 unstaged 字母 M', async () => {
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\n')
    expect((await stagePaths(root, ['a.ts'])).ok).toBe(true)
    let g = await statusGrouped(root)
    const stagedA = g.data?.staged.find((i) => i.path === 'a.ts')
    expect(stagedA?.indexLetter).toBe('M')
    expect((await unstagePaths(root, ['a.ts'])).ok).toBe(true)
    g = await statusGrouped(root)
    expect(g.data?.staged.map((i) => i.path)).not.toContain('a.ts')
    const unstagedA = g.data?.unstaged.find((i) => i.path === 'a.ts')
    expect(unstagedA?.worktreeLetter).toBe('M')
  })

  itGit('中文路径与含空格文件可暂存/取消', async () => {
    const name = '文档 目录/说明 文件.txt'
    mkdirSync(join(root, '文档 目录'), { recursive: true })
    writeFileSync(join(root, '文档 目录', '说明 文件.txt'), '中文内容\n')
    expect((await stagePaths(root, [name])).ok).toBe(true)
    let g = await statusGrouped(root)
    expect(g.data?.staged.map((i) => i.path)).toContain(name)
    expect((await unstagePaths(root, [name])).ok).toBe(true)
    g = await statusGrouped(root)
    expect(g.data?.untracked.map((i) => i.path)).toContain(name)
  })

  itGit('越界路径在真实调用中仍被拒绝', async () => {
    expect((await stagePaths(root, ['../evil.txt'])).ok).toBe(false)
    expect((await unstagePaths(root, [join(tmpdir(), 'abs.ts')])).ok).toBe(false)
  })

  itGit('已跟踪文件删除：暂存字母 D，取消后转工作区字母 D，再还原文件', async () => {
    rmSync(join(root, 'a.ts'))
    expect((await stagePaths(root, ['a.ts'])).ok).toBe(true)
    let g = await statusGrouped(root)
    expect(g.data?.staged.find((i) => i.path === 'a.ts')?.indexLetter).toBe('D')
    expect((await unstagePaths(root, ['a.ts'])).ok).toBe(true)
    g = await statusGrouped(root)
    expect(g.data?.unstaged.find((i) => i.path === 'a.ts')?.worktreeLetter).toBe('D')
    // 恢复 a.ts，保持仓库环境整洁
    const restore = await restoreTrackedFile(root, {
      path: 'a.ts', status: 'deleted', staged: false, rawCode: ' D'
    })
    expect(restore.ok).toBe(true)
  })
})

// s13：分支名校验（纯函数）
describe('isValidBranchName', () => {
  const valid = ['main', 'dev', 'feature/login', 'release-1.2', 'feat_x', 'a.b', 'hotfix/123-fix']
  valid.forEach((n) => {
    it(`合法：${n}`, () => expect(isValidBranchName(n)).toBe(true))
  })

  const invalid: Array<[string, string]> = [
    ['', '空串'], ['   ', '空白'], ['@', '单字符@'], ['-foo', '选项前缀'],
    ['/foo', '斜杠开头'], ['foo/', '斜杠结尾'], ['foo.', '点结尾'],
    ['foo.lock', 'lock 结尾'], ['foo..bar', '双点'], ['foo//bar', '双斜杠'],
    ['foo@{bar', '@{序列'], ['foo~1', '波浪号'], ['foo^', '脱字符'],
    ['foo:bar', '冒号'], ['foo?', '问号'], ['foo*bar', '星号'],
    ['foo[bar', '方括号'], ['foo bar', '空格'], ['foo\\bar', '反斜杠'],
    ['x'.repeat(129), '超长']
  ]
  invalid.forEach(([n, label]) => {
    it(`非法：${label}`, () => expect(isValidBranchName(n)).toBe(false))
  })
})

// s13：分支列表解析（纯函数）
describe('parseBranchList', () => {
  it('逐行解析并标记当前分支', () => {
    const list = parseBranchList('dev\nfeat/x\nmain\n', 'main')
    expect(list).toEqual([
      { name: 'dev', current: false },
      { name: 'feat/x', current: false },
      { name: 'main', current: true }
    ])
  })
  it('detached/unborn（current=null）时无当前标记', () => {
    const list = parseBranchList('main\n', null)
    expect(list[0].current).toBe(false)
  })
  it('空输出 / 多余空白安全处理', () => {
    expect(parseBranchList('', 'main')).toEqual([])
    expect(parseBranchList('\n\n', null)).toEqual([])
  })
})

// s13：真实仓库的提交与分支操作
describe('commitStaged / branches — 真实仓库', () => {
  let root: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'scm-commit-'))
    await initRepo(root)
    writeFileSync(join(root, 'a.ts'), 'one\n')
    const cp = await createCheckpoint(root, '基线')
    expect(cp.ok).toBe(true)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  itGit('空暂存提交被拒绝', async () => {
    const r = await commitStaged(root, '不该成功')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('暂存区')
  })

  itGit('只提交暂存区：未暂存改动保留，提交消息原样、无 trae 前缀', async () => {
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\n')
    writeFileSync(join(root, 'b.ts'), 'b-only\n')
    expect((await stagePaths(root, ['a.ts'])).ok).toBe(true)
    const r = await commitStaged(root, '修改 a 文件')
    expect(r.ok).toBe(true)
    // b.ts 仍未跟踪，未被带入提交
    const g = await statusGrouped(root)
    expect(g.data?.untracked.map((i) => i.path)).toContain('b.ts')
    expect(g.data?.staged).toHaveLength(0)
  })

  itGit('消息清洗：换行变空格、空消息回落默认、超长截断', async () => {
    writeFileSync(join(root, 'b.ts'), 'b-only\nmore\n')
    expect((await stagePaths(root, ['b.ts'])).ok).toBe(true)
    const r = await commitStaged(root, '第一行\n第二行')
    expect(r.ok).toBe(true)
  })

  itGit('listBranches 返回分支并标记当前项', async () => {
    const r = await listBranches(root)
    expect(r.ok).toBe(true)
    const names = (r.data ?? []).map((b) => b.name)
    // 默认分支名（git 2.47 本机配置为 master）
    expect(names.length).toBeGreaterThan(0)
    const currents = (r.data ?? []).filter((b) => b.current)
    expect(currents).toHaveLength(1)
    const g = await statusGrouped(root)
    expect(currents[0].name).toBe(g.data?.currentBranch)
  })

  itGit('createBranch 新建并切换，文件继承；switchBranch 切回', async () => {
    const cur = (await statusGrouped(root)).data?.currentBranch
    expect(cur).toBeTruthy()
    expect((await createBranch(root, 'feature/test')).ok).toBe(true)
    let g = await statusGrouped(root)
    expect(g.data?.currentBranch).toBe('feature/test')
    // 分支上可见原有文件
    expect(readFileSync(join(root, 'a.ts'), 'utf-8')).toContain('two')
    expect((await switchBranch(root, cur!)).ok).toBe(true)
    g = await statusGrouped(root)
    expect(g.data?.currentBranch).toBe(cur)
  })

  itGit('重名分支创建失败；非法分支名被前置拦截', async () => {
    expect((await createBranch(root, 'feature/test')).ok).toBe(false)
    const r = await createBranch(root, 'bad name')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('非法分支名')
  })

  itGit('切换到不存在分支失败', async () => {
    const r = await switchBranch(root, 'not-exists-x')
    expect(r.ok).toBe(false)
  })

  itGit('工作区改动与目标分支冲突时切换被拒绝，本地改动保留', async () => {
    // 在新分支上把 a.ts 改成分叉内容并提交
    expect((await createBranch(root, 'feature/conflict')).ok).toBe(true)
    writeFileSync(join(root, 'a.ts'), 'conflict-branch\n')
    expect((await stagePaths(root, ['a.ts'])).ok).toBe(true)
    expect((await commitStaged(root, '冲突提交')).ok).toBe(true)
    // 回到默认分支（非 feature 开头的分支）
    const master = (await listBranches(root)).data?.find(
      (b) => !b.current && !b.name.startsWith('feature')
    )?.name
    expect(master).toBeTruthy()
    expect((await switchBranch(root, master!)).ok).toBe(true)
    // 工作区制造未提交修改，再切向冲突分支
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\nlocal-edit\n')
    const r = await switchBranch(root, 'feature/conflict')
    expect(r.ok).toBe(false)
    // 本地改动原样保留，错误由 git 原样透传
    expect(readFileSync(join(root, 'a.ts'), 'utf-8')).toContain('local-edit')
    // 清理工作区改动
    const restore = await restoreTrackedFile(root, {
      path: 'a.ts', status: 'modified', staged: false, rawCode: ' M'
    })
    expect(restore.ok).toBe(true)
  })
})
