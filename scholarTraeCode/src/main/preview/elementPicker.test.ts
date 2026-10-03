import { describe, it, expect } from 'vitest'
import { buildSelectorScript, buildPickerScript, parsePickedMessage } from './elementPicker'

describe('buildSelectorScript', () => {
  it('生成可执行的 IIFE 字符串', () => {
    const s = buildSelectorScript()
    expect(s).toContain('(function(){')
    expect(s).toContain('data-id')
    expect(s).toContain('data-testid')
    expect(s).toContain('nth-child')
    expect(s).toContain('return getSelector')
  })
})

describe('buildPickerScript', () => {
  it('生成包含高亮/点击/Escape 清理的脚本', () => {
    const s = buildPickerScript()
    expect(s).toContain('__scholarPickerActive')
    expect(s).toContain('__scholar-picker-overlay')
    expect(s).toContain('#00D4FF')
    expect(s).toContain('mousemove')
    expect(s).toContain('click')
    expect(s).toContain('Escape')
    expect(s).toContain('__SCHOLAR_PICKED__')
    expect(s).toContain('cleanup')
  })

  it('outerHTML 截断阈值 8000', () => {
    const s = buildPickerScript()
    expect(s).toContain('8000')
    expect(s).toContain('[truncated]')
  })

  it('返回注入状态字符串', () => {
    const s = buildPickerScript()
    expect(s).toContain("return 'injected'")
    expect(s).toContain("return 'already'")
  })
})

describe('parsePickedMessage', () => {
  it('解析合法 JSON', () => {
    const data = {
      selector: '[data-id="btn"]',
      outerHTML: '<button data-id="btn">Click</button>',
      bounds: { x: 10, y: 20, width: 100, height: 40 },
      tagName: 'button',
      text: 'Click'
    }
    const msg = '__SCHOLAR_PICKED__' + JSON.stringify(data)
    expect(parsePickedMessage(msg)).toEqual(data)
  })

  it('非采集消息返回 null', () => {
    expect(parsePickedMessage('normal log')).toBeNull()
    expect(parsePickedMessage('__OTHER__{}')).toBeNull()
    expect(parsePickedMessage('')).toBeNull()
  })

  it('坏 JSON 返回 null', () => {
    expect(parsePickedMessage('__SCHOLAR_PICKED__{bad')).toBeNull()
    expect(parsePickedMessage('__SCHOLAR_PICKED__')).toBeNull()
  })
})
