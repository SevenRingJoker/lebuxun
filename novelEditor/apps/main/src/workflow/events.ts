/** 轻量事件总线（SPEC §4.1 StreamEvent）：引擎 → IPC 层 → webContents.send → Renderer */

import type { StreamEvent } from '@novel-forge/shared';

export type StreamEventListener = (event: StreamEvent) => void;

export class EventBus {
  private readonly listeners = new Set<StreamEventListener>();

  /** 订阅；返回取消订阅函数 */
  on(listener: StreamEventListener): () => void {
    this.listeners.add(listener);
    return () => this.off(listener);
  }

  off(listener: StreamEventListener): void {
    this.listeners.delete(listener);
  }

  emit(event: StreamEvent): void {
    // 拷贝快照，容忍监听器在回调中 on/off
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[novel-forge] StreamEvent 监听器异常（已隔离）：', err);
      }
    }
  }
}
