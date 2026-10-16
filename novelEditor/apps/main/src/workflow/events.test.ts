/** EventBus：on/off/emit、取消订阅、监听器异常隔离 */

import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@novel-forge/shared';
import { EventBus } from './events.js';

const ev = (nodeId: string): StreamEvent => ({ type: 'workflow:node-start', runId: 'r1', nodeId });

describe('EventBus', () => {
  it('on 订阅收到 emit 的事件', () => {
    const bus = new EventBus();
    const got: StreamEvent[] = [];
    bus.on((e) => got.push(e));
    bus.emit(ev('n1'));
    bus.emit(ev('n2'));
    expect(got.map((e) => ('nodeId' in e ? e.nodeId : ''))).toEqual(['n1', 'n2']);
  });

  it('off 与 on 返回的取消函数都能退订', () => {
    const bus = new EventBus();
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    const listenerA = (e: StreamEvent): void => { a.push(e); };
    const offB = bus.on((e) => b.push(e));
    bus.on(listenerA);
    bus.emit(ev('n1'));
    bus.off(listenerA);
    offB();
    bus.emit(ev('n2'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('单个监听器抛异常不影响其他监听器', () => {
    const bus = new EventBus();
    const got: StreamEvent[] = [];
    bus.on(() => { throw new Error('boom'); });
    bus.on((e) => got.push(e));
    bus.emit(ev('n1'));
    expect(got).toHaveLength(1);
  });
});
