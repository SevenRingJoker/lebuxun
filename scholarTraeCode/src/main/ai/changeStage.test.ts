import { describe, it, expect } from 'vitest'
import {
  applyStaged,
  buildApplyOps,
  buildStageNotice,
  classifyMutationTool,
  checkConflict,
  createStage,
  deserializeStage,
  diffOf,
  hashContent,
  overlayExists,
  overlayGlob,
  overlayGrep,
  overlayRead,
  partitionStage,
  serializeStage,
  stageKey,
  summarize,
  type DiskView,
  type NormalizedCall,
  type StageState
} from './changeStage'

// ───────────── 测试夹具：内存假磁盘 ─────────────

/** 构造 readDisk 回调：路径 → 内容；未列出视为不存在 */
function fakeDisk(files: Record<string, string>) {
  return (path: string): DiskView => {
    const content = Object.prototype.hasOwnProperty.call(files, path) ? files[path] : undefined
    return content === undefined ? { exists: false, content: null } : { exists: true, content }
  }
}

/** 便捷执行：返回成功结局（失败时抛错，让用例直接暴露） */
function runOk(
  state: StageState,
  call: NormalizedCall,
  files: Record<string, string>,
  now = 1000
) {
  const out = applyStaged(state, call, fakeDisk(files), now)
  if (!out.ok) throw new Error(`applyStaged 意外失败：${out.error}`)
  return out
}

/** 执行并断言失败 */
function runFail(call: NormalizedCall, files: Record<string, string>, state = createStage()) {
  const out = applyStaged(state, call, fakeDisk(files), 1000)
  expect(out.ok).toBe(false)
  if (!out.ok) return out.error
  throw new Error('应当失败')
}

const WS = 'C:/work/demo'

describe('changeStage · 工具归类 classifyMutationTool', () => {
  it('write 提取 path/content，内容缺省为空串', () => {
    const r = classifyMutationTool('write', { path: 'a.ts', content: 'x' })
    expect(r).toEqual({ ok: true, call: { op: 'write', path: 'a.ts', content: 'x' } })
    const r2 = classifyMutationTool('write', { path: 'a.ts' })
    expect(r2?.ok).toBe(true)
  })

  it('write_file / create_file 同名归一', () => {
    expect(classifyMutationTool('write_file', { file_path: 'b', contents: 'c' })).toMatchObject({
      ok: true,
      call: { op: 'write', path: 'b', content: 'c' }
    })
    expect(classifyMutationTool('create_file', { filePath: 'd', text: 'e' })).toMatchObject({
      ok: true,
      call: { path: 'd', content: 'e' }
    })
  })

  it('edit / str_replace 多形态参数归一', () => {
    expect(classifyMutationTool('edit', { path: 'f', old_string: 'a', new_string: 'b' })).toMatchObject({
      ok: true, call: { op: 'edit', oldString: 'a', newString: 'b' }
    })
    expect(classifyMutationTool('str_replace', { path: 'f', old_str: 'a', new_str: 'b' })).toMatchObject({
      ok: true, call: { op: 'edit' }
    })
  })

  it('delete / remove_file 归一', () => {
    expect(classifyMutationTool('delete', { path: 'g' })).toMatchObject({ ok: true, call: { op: 'delete' } })
    expect(classifyMutationTool('remove_file', { file_path: 'g' })).toMatchObject({
      ok: true, call: { op: 'delete', path: 'g' }
    })
  })

  it('move / rename 取 source + destination', () => {
    const r = classifyMutationTool('move', { source: 'a', destination: 'b' })
    expect(r).toMatchObject({ ok: true, call: { op: 'move', path: 'b', oldPath: 'a' } })
    const r2 = classifyMutationTool('rename', { old_path: 'a', new_path: 'b' })
    expect(r2).toMatchObject({ ok: true, call: { op: 'move', path: 'b', oldPath: 'a' } })
  })

  it('copy 取 source + target', () => {
    expect(classifyMutationTool('copy', { src: 'a', dest: 'b' })).toMatchObject({
      ok: true, call: { op: 'copy', path: 'b', oldPath: 'a' }
    })
  })

  it('缺参数返回错误而非 null（工具名是认识的）', () => {
    expect(classifyMutationTool('write', {})).toMatchObject({ ok: false })
    expect(classifyMutationTool('edit', { path: 'a' })).toMatchObject({ ok: false })
    expect(classifyMutationTool('move', { source: 'a' })).toMatchObject({ ok: false })
  })

  it('未识别工具名返回 null（直走原通道）', () => {
    expect(classifyMutationTool('some_unknown', { x: 1 })).toBeNull()
  })

  it('显式 null 参数不炸（模型常见 cwd:null 形态）', () => {
    const r = classifyMutationTool('write', { path: 'a', content: 'x', cwd: null } as any)
    expect(r?.ok).toBe(true)
  })
})

describe('changeStage · write 操作代数', () => {
  it('磁盘无此文件 → create，基线为空', () => {
    const out = runOk(createStage(), { op: 'write', path: `${WS}/new.ts`, content: 'hello' }, {})
    const rec = out.state.get(stageKey(`${WS}/new.ts`))!
    expect(rec.kind).toBe('create')
    expect(rec.baseExists).toBe(false)
    expect(rec.baseHash).toBe('')
    expect(rec.content).toBe('hello')
  })

  it('磁盘已有 → modify，基线捕获原内容', () => {
    const path = `${WS}/old.ts`
    const out = runOk(createStage(), { op: 'write', path, content: 'new' }, { [path]: 'old' })
    const rec = out.state.get(stageKey(path))!
    expect(rec.kind).toBe('modify')
    expect(rec.baseContent).toBe('old')
    expect(rec.baseHash).toBe(hashContent('old'))
  })

  it('同文件多次 write：合并为一条、内容取最新', () => {
    const path = `${WS}/a.ts`
    let s = createStage()
    s = runOk(s, { op: 'write', path, content: 'v1' }, {}).state
    s = runOk(s, { op: 'write', path, content: 'v2' }, {}).state
    expect(s.size).toBe(1)
    expect(s.get(stageKey(path))!.content).toBe('v2')
    expect(s.get(stageKey(path))!.kind).toBe('create')
  })

  it('delete 后再 write：复活为 modify，基线是最初磁盘内容', () => {
    const path = `${WS}/old.ts`
    let s = createStage()
    s = runOk(s, { op: 'delete', path }, { [path]: 'orig' }).state
    s = runOk(s, { op: 'write', path, content: 'rebuilt' }, { [path]: 'orig' }).state
    const rec = s.get(stageKey(path))!
    expect(rec.kind).toBe('modify')
    expect(rec.content).toBe('rebuilt')
    expect(rec.baseContent).toBe('orig')
  })
})

describe('changeStage · delete 操作代数', () => {
  it('create 后 delete：记录消失，回到原状', () => {
    const path = `${WS}/new.ts`
    let s = createStage()
    s = runOk(s, { op: 'write', path, content: 'x' }, {}).state
    s = runOk(s, { op: 'delete', path }, {}).state
    expect(s.size).toBe(0)
  })

  it('modify 后 delete：转为 delete 并保留基线', () => {
    const path = `${WS}/old.ts`
    let s = createStage()
    s = runOk(s, { op: 'write', path, content: 'n' }, { [path]: 'o' }).state
    s = runOk(s, { op: 'delete', path }, { [path]: 'o' }).state
    const rec = s.get(stageKey(path))!
    expect(rec.kind).toBe('delete')
    expect(rec.content).toBeNull()
    expect(rec.baseContent).toBe('o')
  })

  it('删除不存在的文件 → 失败', () => {
    runFail({ op: 'delete', path: `${WS}/ghost.ts` }, {})
  })

  it('重复 delete 已暂存删除 → 失败', () => {
    const path = `${WS}/old.ts`
    let s = createStage()
    s = runOk(s, { op: 'delete', path }, { [path]: 'x' }).state
    const out = applyStaged(s, { op: 'delete', path }, fakeDisk({ [path]: 'x' }), 1000)
    expect(out.ok).toBe(false)
  })
})

describe('changeStage · edit 操作代数', () => {
  it('对磁盘文件 edit → modify 记录', () => {
    const path = `${WS}/old.ts`
    const out = runOk(
      createStage(),
      { op: 'edit', path, oldString: 'foo', newString: 'bar' },
      { [path]: 'foo baz' }
    )
    const rec = out.state.get(stageKey(path))!
    expect(rec.kind).toBe('modify')
    expect(rec.content).toBe('bar baz')
    expect(rec.baseContent).toBe('foo baz')
  })

  it('对暂存中的 create 再 edit：内容更新、类型不变', () => {
    const path = `${WS}/new.ts`
    let s = runOk(createStage(), { op: 'write', path, content: 'a1 a2' }, {}).state
    s = runOk(s, { op: 'edit', path, oldString: 'a1', newString: 'a0' }, {}).state
    const rec = s.get(stageKey(path))!
    expect(rec.kind).toBe('create')
    expect(rec.content).toBe('a0 a2')
  })

  it('old_string 未找到 → 失败', () => {
    runFail({ op: 'edit', path: `${WS}/a.ts`, oldString: 'zzz', newString: 'q' }, { [`${WS}/a.ts`]: 'aaa' })
  })

  it('old_string 多处匹配 → 失败', () => {
    runFail({ op: 'edit', path: `${WS}/a.ts`, oldString: 'a', newString: 'b' }, { [`${WS}/a.ts`]: 'a a' })
  })

  it('对暂存 delete 记录 edit → 失败', () => {
    const path = `${WS}/a.ts`
    let s = runOk(createStage(), { op: 'delete', path }, { [path]: 'x' }).state
    const out = applyStaged(s, { op: 'edit', path, oldString: 'x', newString: 'y' }, fakeDisk({ [path]: 'x' }), 1)
    expect(out.ok).toBe(false)
  })

  it('edit 不存在的文件 → 失败', () => {
    runFail({ op: 'edit', path: `${WS}/ghost.ts`, oldString: 'a', newString: 'b' }, {})
  })
})

describe('changeStage · move 操作代数', () => {
  it('移动干净磁盘文件：目标 move + 源头 delete（基线为磁盘）', () => {
    const from = `${WS}/a.ts`
    const to = `${WS}/b.ts`
    const s = runOk(createStage(), { op: 'move', path: to, oldPath: from }, { [from]: 'aaa' }).state
    expect(s.size).toBe(2)
    const t = s.get(stageKey(to))!
    expect(t.kind).toBe('move')
    expect(t.oldPath).toBe(from)
    expect(t.content).toBe('aaa')
    expect(s.get(stageKey(from))!.kind).toBe('delete')
  })

  it('移动新建文件：源头消失，目标为 create', () => {
    const from = `${WS}/new.ts`
    const to = `${WS}/renamed.ts`
    let s = runOk(createStage(), { op: 'write', path: from, content: 'x' }, {}).state
    s = runOk(s, { op: 'move', path: to, oldPath: from }, {}).state
    expect(s.size).toBe(1)
    const rec = s.get(stageKey(to))!
    expect(rec.kind).toBe('create')
    expect(rec.oldPath).toBeNull()
    expect(rec.content).toBe('x')
  })

  it('移动修改过的文件：源头转 delete，目标 move', () => {
    const from = `${WS}/a.ts`
    const to = `${WS}/b.ts`
    let s = runOk(createStage(), { op: 'edit', path: from, oldString: 'x', newString: 'y' }, { [from]: 'x' }).state
    s = runOk(s, { op: 'move', path: to, oldPath: from }, { [from]: 'x' }).state
    expect(s.get(stageKey(from))!.kind).toBe('delete')
    expect(s.get(stageKey(to))!.kind).toBe('move')
  })

  it('连续 move：目标继承最初源头，中间路径清空', () => {
    const a = `${WS}/a.ts`
    const b = `${WS}/b.ts`
    const c = `${WS}/c.ts`
    let s = runOk(createStage(), { op: 'move', path: b, oldPath: a }, { [a]: '1' }).state
    s = runOk(s, { op: 'move', path: c, oldPath: b }, { [a]: '1' }).state
    expect(s.size).toBe(2)
    const target = s.get(stageKey(c))!
    expect(target.kind).toBe('move')
    expect(target.oldPath).toBe(a)
    expect(s.get(stageKey(a))!.kind).toBe('delete')
  })

  it('move 到已有暂存/磁盘目标 → 失败', () => {
    const to = `${WS}/exists.ts`
    runFail({ op: 'move', path: to, oldPath: `${WS}/a.ts` }, { [`${WS}/a.ts`]: 'x', [to]: 'y' })
  })

  it('move 不存在的源头 → 失败', () => {
    runFail({ op: 'move', path: `${WS}/b.ts`, oldPath: `${WS}/ghost.ts` }, {})
  })

  it('move 目标之后再 delete：目标撤销，源头 delete 保留', () => {
    const a = `${WS}/a.ts`
    const b = `${WS}/b.ts`
    let s = runOk(createStage(), { op: 'move', path: b, oldPath: a }, { [a]: 'x' }).state
    s = runOk(s, { op: 'delete', path: b }, { [a]: 'x' }).state
    expect(s.size).toBe(1)
    expect(s.get(stageKey(a))!.kind).toBe('delete')
  })
})

describe('changeStage · copy 操作代数', () => {
  it('复制磁盘文件：目标 create 且源头不动', () => {
    const from = `${WS}/a.ts`
    const to = `${WS}/a-copy.ts`
    const s = runOk(createStage(), { op: 'copy', path: to, oldPath: from }, { [from]: 'data' }).state
    expect(s.size).toBe(1)
    expect(s.get(stageKey(to))).toMatchObject({ kind: 'create', content: 'data' })
  })

  it('源头不存在 → 失败', () => {
    runFail({ op: 'copy', path: `${WS}/b`, oldPath: `${WS}/ghost` }, {})
  })
})

describe('changeStage · 暂存覆盖视图', () => {
  it('overlayRead：create/modify 命中内容，delete 显不存在，无记录回落 null', () => {
    let s = runOk(createStage(), { op: 'write', path: `${WS}/n.ts`, content: 'new' }, {}).state
    s = runOk(s, { op: 'delete', path: `${WS}/d.ts` }, { [`${WS}/d.ts`]: 'x' }).state
    expect(overlayRead(s, `${WS}/n.ts`)).toEqual({ found: true, content: 'new' })
    expect(overlayRead(s, `${WS}/d.ts`)).toEqual({ found: false, content: '' })
    expect(overlayRead(s, `${WS}/other.ts`)).toBeNull()
  })

  it('overlayExists 三态', () => {
    const s = runOk(createStage(), { op: 'write', path: `${WS}/n.ts`, content: '' }, {}).state
    expect(overlayExists(s, `${WS}/n.ts`)).toBe(true)
    expect(overlayExists(s, `${WS}/other.ts`)).toBeNull()
  })

  it('overlayGlob：剔除删除、并入新增', () => {
    let s = runOk(createStage(), { op: 'write', path: `${WS}/new.ts`, content: 'x' }, {}).state
    s = runOk(s, { op: 'delete', path: `${WS}/gone.ts` }, { [`${WS}/gone.ts`]: 'x' }).state
    const merged = overlayGlob(s, [`${WS}/gone.ts`, `${WS}/keep.ts`].map(stageKey))
    expect(merged).toContain(stageKey(`${WS}/keep.ts`))
    expect(merged).toContain(stageKey(`${WS}/new.ts`))
    expect(merged).not.toContain(stageKey(`${WS}/gone.ts`))
  })

  it('overlayGrep：暂存内容补扫并产出同格式行', () => {
    const s = runOk(createStage(), { op: 'write', path: `${WS}/src/new.ts`, content: 'hello\nneedle here' }, {}).state
    const hits = overlayGrep(s, 'needle', (p) => p.slice(`${WS}/`.length))
    expect(hits).toEqual(['src/new.ts:2: needle here'])
  })

  it('overlayGrep：非法正则返回空数组不炸', () => {
    const s = createStage()
    expect(overlayGrep(s, '([a', (p) => p)).toEqual([])
  })

  it('反斜杠路径与正斜杠命中同一条（中文路径）', () => {
    const path = `${WS}/目录/新 文件.ts`
    const winPath = path.replace(/\//g, '\\')
    const s = runOk(createStage(), { op: 'write', path: winPath, content: '中' }, {}).state
    expect(overlayRead(s, path)).toEqual({ found: true, content: '中' })
  })
})

describe('changeStage · 审阅辅助', () => {
  it('summarize 分类计数，items 按路径排序', () => {
    let s = runOk(createStage(), { op: 'write', path: `${WS}/z.ts`, content: 'x' }, {}).state
    s = runOk(s, { op: 'write', path: `${WS}/a.ts`, content: 'y' }, {}).state
    const sum = summarize(s)
    expect(sum.total).toBe(2)
    expect(sum.counts.create).toBe(2)
    expect(sum.items[0].path).toBe(`${WS}/a.ts`)
  })

  it('diffOf：create 左空右新；modify 左基线右新；delete 右空', () => {
    const path = `${WS}/a.ts`
    let s = runOk(createStage(), { op: 'write', path, content: 'new' }, { [path]: 'old' }).state
    expect(diffOf(s.get(stageKey(path))!)).toMatchObject({ original: 'old', modified: 'new' })
    let s2 = runOk(createStage(), { op: 'write', path: `${WS}/n.ts`, content: 'new' }, {}).state
    expect(diffOf(s2.get(stageKey(`${WS}/n.ts`))!)).toMatchObject({ original: '', modified: 'new' })
    let s3 = runOk(createStage(), { op: 'delete', path: `${WS}/d.ts` }, { [`${WS}/d.ts`]: 'old' }).state
    expect(diffOf(s3.get(stageKey(`${WS}/d.ts`))!)).toMatchObject({ original: 'old', modified: '' })
  })

  it('checkConflict：基线改动即冲突；create 目标冒出即冲突', () => {
    const path = `${WS}/a.ts`
    let s = runOk(createStage(), { op: 'write', path, content: 'new' }, { [path]: 'old' }).state
    const modify = s.get(stageKey(path))!
    expect(checkConflict(modify, true, hashContent('old'))).toBe(false)
    expect(checkConflict(modify, true, hashContent('changed'))).toBe(true)
    expect(checkConflict(modify, false, null)).toBe(true)

    let s2 = runOk(createStage(), { op: 'write', path: `${WS}/n.ts`, content: 'x' }, {}).state
    const create = s2.get(stageKey(`${WS}/n.ts`))!
    expect(checkConflict(create, false, null)).toBe(false)
    expect(checkConflict(create, true, hashContent('x'))).toBe(true)
  })
})

describe('changeStage · 序列化与落盘规划', () => {
  it('serialize/deserialize 往返一致', () => {
    const path = `${WS}/a.ts`
    const s = runOk(createStage(), { op: 'write', path, content: 'new' }, { [path]: 'old' }).state
    const back = deserializeStage(JSON.parse(JSON.stringify(serializeStage(s))))
    expect(back.get(stageKey(path))).toEqual(s.get(stageKey(path)))
  })

  it('deserialize 宽容坏数据：null/非数组/坏条目均安全跳过', () => {
    expect(deserializeStage(null).size).toBe(0)
    expect(deserializeStage('x').size).toBe(0)
    expect(deserializeStage([null, 1, {}, { path: 'a' }, { path: 'b', kind: 'wrong' }]).size).toBe(0)
    const ok = deserializeStage([{ path: 'b.ts', kind: 'create', content: 'x' }])
    expect(ok.size).toBe(1)
  })

  it('buildApplyOps：write/delete/move 语义与去重', () => {
    const from = `${WS}/a.ts`
    const to = `${WS}/b.ts`
    const s = runOk(createStage(), { op: 'move', path: to, oldPath: from }, { [from]: 'x' }).state
    // move 记录 + 同源 delete 同批接受：ops 应恰好 目标 write + 源头 delete
    const ops = buildApplyOps(Array.from(s.values()))
    expect(ops).toHaveLength(2)
    expect(ops).toContainEqual({ type: 'write', path: to, content: 'x' })
    expect(ops).toContainEqual({ type: 'delete', path: from })
  })

  it('partitionStage：按路径选中/剩余；all 全选', () => {
    let s = runOk(createStage(), { op: 'write', path: `${WS}/a.ts`, content: '1' }, {}).state
    s = runOk(s, { op: 'write', path: `${WS}/b.ts`, content: '2' }, {}).state
    const part = partitionStage(s, [`${WS}/a.ts`])
    expect(part.selected).toHaveLength(1)
    expect(part.rest.size).toBe(1)
    expect(partitionStage(s, 'all').selected).toHaveLength(2)
  })

  it('hashContent 确定性：相同输入相同哈希、不同输入不同', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'))
    expect(hashContent('abc')).not.toBe(hashContent('abd'))
  })

  it('buildStageNotice 含四条关键约定', () => {
    const t = buildStageNotice()
    expect(t).toContain('待审阅暂存区')
    expect(t).toContain('自动基于暂存')
    expect(t).toContain('bash')
    expect(t).toContain('接受变更后')
  })
})

describe('changeStage · 入参不被修改（纯函数保证）', () => {
  it('applyStaged 返回新 Map，失败时原 state 不变', () => {
    const s = createStage()
    const out = applyStaged(s, { op: 'write', path: `${WS}/a.ts`, content: 'x' }, fakeDisk({}), 1)
    expect(out.state).not.toBe(s)
    const failOut = applyStaged(s, { op: 'delete', path: `${WS}/ghost.ts` }, fakeDisk({}), 1)
    expect(failOut.state).toBe(s)
    expect(s.size).toBe(0)
  })
})
