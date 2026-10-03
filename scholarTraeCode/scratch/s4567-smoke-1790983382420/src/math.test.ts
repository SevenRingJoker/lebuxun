import { describe, expect, it } from 'vitest'
import { add } from './math'
describe('math', () => {
  it('add', () => {
    expect(add(1, 2)).toBe(3)
  })
})
