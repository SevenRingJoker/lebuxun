/** Main → Renderer 流式事件频道名（SPEC §4.1 StreamEvent 走此频道）
 *
 * preload.ts 与 ipc/index.ts 共用此常量，防止两端频道名漂移。
 * 与 Phase 1 preload 已暴露的 window.nv.onStreamEvent 监听名一致。
 */
export const STREAM_EVENT_CHANNEL = 'nv:stream-event';
