/** SPEC §7.2 NodeRegistry：注册 / 获取 / 重复注册报错 / 未注册报错 */

import { describe, expect, it } from 'vitest';
import type { NodeType } from '@novel-forge/shared';
import { NodeRegistry } from './registry.js';
import type { NodeDefinition } from './types.js';

function mockDef(type: NodeType, overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    type,
    title: `mock ${type}`,
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [],
    execute: async () => ({ out: 'ok' }),
    ...overrides,
  };
}

describe('NodeRegistry（SPEC §7.2）', () => {
  it('register 后 get 取回同一定义', () => {
    const reg = new NodeRegistry();
    const def = mockDef('input.manual');
    reg.register(def);
    expect(reg.get('input.manual')).toBe(def);
  });

  it('has / list 反映已注册类型', () => {
    const reg = new NodeRegistry();
    expect(reg.has('input.manual')).toBe(false);
    reg.register(mockDef('input.manual'));
    reg.register(mockDef('generate.dialogue'));
    expect(reg.has('input.manual')).toBe(true);
    expect(reg.has('chapter.finalizer')).toBe(false);
    expect(reg.list().map((d) => d.type)).toEqual(['input.manual', 'generate.dialogue']);
  });

  it('重复注册同一 type 报错', () => {
    const reg = new NodeRegistry();
    reg.register(mockDef('input.manual'));
    expect(() => reg.register(mockDef('input.manual'))).toThrow(/重复注册/);
  });

  it('get 未注册 type 报错', () => {
    const reg = new NodeRegistry();
    expect(() => reg.get('style.discriminator')).toThrow(/未注册/);
  });

  it('pause 定义原样保留（人工节点标记）', () => {
    const reg = new NodeRegistry();
    reg.register(mockDef('review.candidate-picker', { pause: true }));
    expect(reg.get('review.candidate-picker').pause).toBe(true);
  });
});
