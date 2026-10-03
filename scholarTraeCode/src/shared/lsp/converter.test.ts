// converter.ts 单测：URI、位置区间偏移、严重度映射、补全/hover/location 转换
import { describe, it, expect } from 'vitest'
import {
  pathToUri,
  uriToPath,
  normalizeUri,
  lspPositionToMonaco,
  monacoPositionToLsp,
  lspRangeToMonaco,
  monacoRangeToLsp,
  diagnosticSeverityToMonaco,
  diagnosticToMarker,
  diagnosticsToMarkers,
  completionItemToMonaco,
  normalizeCompletionList,
  extractMarkupText,
  hoverToMonaco,
  locationToMonaco,
  MONACO_MARKER_SEVERITY
} from './converter'
import {
  LspDiagnosticSeverity,
  LspCompletionItemKind,
  type LspDiagnostic,
  type LspCompletionItem,
  type LspHover
} from './types'

describe('路径 ↔ URI', () => {
  it('Windows 路径 → file:/// + 盘符', () => {
    expect(pathToUri('d:\\a\\b.ts')).toBe('file:///d:/a/b.ts')
    expect(pathToUri('d:\\项目\\x.ts')).toBe('file:///d:/%E9%A1%B9%E7%9B%AE/x.ts')
  })

  it('POSIX 路径 → file:// + 绝对路径', () => {
    expect(pathToUri('/home/user/a.ts')).toBe('file:///home/user/a.ts')
  })

  it('URI → Windows 路径（反斜杠）', () => {
    expect(uriToPath('file:///d:/a/b.ts')).toBe('d:\\a\\b.ts')
  })

  it('URI → POSIX 路径', () => {
    expect(uriToPath('file:///home/user/a.ts')).toBe('/home/user/a.ts')
  })

  it('往返一致（含中文路径）', () => {
    const win = 'd:\\工作目录\\src\\main.ts'
    expect(uriToPath(pathToUri(win))).toBe(win)
    const posix = '/home/用户/main.ts'
    expect(uriToPath(pathToUri(posix))).toBe(posix)
  })
})

describe('normalizeUri — URI 形式归一化', () => {
  it('我方形式幂等', () => {
    expect(normalizeUri('file:///d:/a/b.ts')).toBe('file:///d:/a/b.ts')
  })

  it('Volar 编码盘符（d%3A）→ 我方形式', () => {
    expect(normalizeUri('file:///d%3A/a/b.ts')).toBe('file:///d:/a/b.ts')
  })

  it('编码盘符 + 中文路径', () => {
    expect(normalizeUri('file:///d%3A/a/%E9%A1%B9%E7%9B%AE/x.ts')).toBe(
      'file:///d:/a/%E9%A1%B9%E7%9B%AE/x.ts'
    )
  })

  it('POSIX URI 归一保持', () => {
    expect(normalizeUri('file:///home/user/a.ts')).toBe('file:///home/user/a.ts')
  })

  it('非 file URI 原样返回', () => {
    expect(normalizeUri('http://example.com/a')).toBe('http://example.com/a')
    expect(normalizeUri('untitled:Untitled-1')).toBe('untitled:Untitled-1')
  })
})

describe('位置转换（0-based ↔ 1-based）', () => {
  it('LSP → Monaco：行列各 +1', () => {
    expect(lspPositionToMonaco({ line: 0, character: 0 })).toEqual({ lineNumber: 1, column: 1 })
    expect(lspPositionToMonaco({ line: 9, character: 15 })).toEqual({ lineNumber: 10, column: 16 })
  })

  it('Monaco → LSP：行列各 -1', () => {
    expect(monacoPositionToLsp({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 })
  })
})

describe('区间转换', () => {
  it('LSP 区间 → Monaco 区间', () => {
    expect(
      lspRangeToMonaco({
        start: { line: 0, character: 0 },
        end: { line: 2, character: 10 }
      })
    ).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 11 })
  })

  it('Monaco → LSP 往返', () => {
    const lsp = { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } }
    expect(monacoRangeToLsp(lspRangeToMonaco(lsp))).toEqual(lsp)
  })
})

describe('诊断严重度映射', () => {
  it('LSP 四级 → Monaco marker 数值', () => {
    expect(diagnosticSeverityToMonaco(LspDiagnosticSeverity.Error)).toBe(MONACO_MARKER_SEVERITY.Error)
    expect(diagnosticSeverityToMonaco(LspDiagnosticSeverity.Warning)).toBe(MONACO_MARKER_SEVERITY.Warning)
    expect(diagnosticSeverityToMonaco(LspDiagnosticSeverity.Information)).toBe(MONACO_MARKER_SEVERITY.Info)
    expect(diagnosticSeverityToMonaco(LspDiagnosticSeverity.Hint)).toBe(MONACO_MARKER_SEVERITY.Hint)
  })

  it('缺省 severity 按 Error 处理', () => {
    expect(diagnosticSeverityToMonaco(undefined)).toBe(MONACO_MARKER_SEVERITY.Error)
  })
})

describe('诊断 → marker', () => {
  const diag: LspDiagnostic = {
    range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
    severity: LspDiagnosticSeverity.Warning,
    code: 2322,
    source: 'ts',
    message: '类型不匹配'
  }

  it('字段完整映射（位置 +1）', () => {
    const marker = diagnosticToMarker(diag)
    expect(marker).toEqual({
      severity: MONACO_MARKER_SEVERITY.Warning,
      message: '类型不匹配',
      startLineNumber: 5,
      startColumn: 3,
      endLineNumber: 5,
      endColumn: 9,
      code: 2322,
      source: 'ts'
    })
  })

  it('diagnosticsToMarkers 批量转换', () => {
    expect(diagnosticsToMarkers([diag, diag])).toHaveLength(2)
  })
})

describe('补全项转换', () => {
  it('基本字段 + kind 映射 + insertText 回退 label', () => {
    const item: LspCompletionItem = { label: 'console', kind: LspCompletionItemKind.Variable }
    const m = completionItemToMonaco(item)
    expect(m.label).toBe('console')
    expect(m.kind).toBe(4) // Monaco Variable=4
    expect(m.insertText).toBe('console')
  })

  it('insertText 优先', () => {
    const m = completionItemToMonaco({ label: 'log', insertText: 'console.log($1)' })
    expect(m.insertText).toBe('console.log($1)')
  })

  it('textEdit 的 newText 优先于 insertText，range 转换', () => {
    const m = completionItemToMonaco({
      label: 'x',
      insertText: 'ignored',
      textEdit: {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        newText: 'applied'
      }
    })
    expect(m.insertText).toBe('applied')
    expect(m.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 })
  })

  it('documentation 字符串/对象两种形态', () => {
    expect(completionItemToMonaco({ label: 'a', documentation: '说明' }).documentation).toBe('说明')
    expect(
      completionItemToMonaco({ label: 'b', documentation: { kind: 'markdown', value: '**粗**' } }).documentation
    ).toBe('**粗**')
  })

  it('未知 kind 回退 Text=18；无 kind 也回退', () => {
    expect(completionItemToMonaco({ label: 'a', kind: 999 as any }).kind).toBe(18)
    expect(completionItemToMonaco({ label: 'b' }).kind).toBe(18)
  })

  it('normalizeCompletionList 兼容数组与 CompletionList', () => {
    const a: LspCompletionItem[] = [{ label: 'x' }]
    const b = { isIncomplete: false, items: [{ label: 'y' }] }
    expect(normalizeCompletionList(a)).toHaveLength(1)
    expect(normalizeCompletionList(b)[0].label).toBe('y')
  })
})

describe('Hover 转换', () => {
  it('字符串 contents', () => {
    expect(extractMarkupText('hello')).toBe('hello')
  })

  it('数组 contents 拼接', () => {
    expect(extractMarkupText([{ value: 'a' }, { value: 'b' }])).toBe('a\nb')
  })

  it('MarkupContent 对象', () => {
    expect(extractMarkupText({ kind: 'markdown', value: '**doc**' })).toBe('**doc**')
  })

  it('hoverToMonaco 输出 contents + range', () => {
    const hover: LspHover = {
      contents: { kind: 'markdown', value: 'doc' },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
    }
    const m = hoverToMonaco(hover)
    expect(m.contents.value).toBe('doc')
    expect(m.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 })
  })

  it('无 range 的 hover', () => {
    expect(hoverToMonaco({ contents: 'x' }).range).toBeUndefined()
  })
})

describe('Location 转换', () => {
  it('locationToMonaco：path + range', () => {
    const m = locationToMonaco({
      uri: 'file:///d:/a/b.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 5 } }
    })
    expect(m.path).toBe('d:\\a\\b.ts')
    expect(m.range.startLineNumber).toBe(1)
    expect(m.range.endLineNumber).toBe(2)
  })
})
