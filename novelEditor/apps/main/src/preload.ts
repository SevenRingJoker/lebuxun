/** preload：contextBridge 暴露 window.nv.invoke / window.nv.onStreamEvent */

import { contextBridge, ipcRenderer } from 'electron';
import { STREAM_EVENT_CHANNEL } from './stream-channel.js';

contextBridge.exposeInMainWorld('nv', {
  invoke: (channel: string, req?: unknown): Promise<unknown> => ipcRenderer.invoke(channel, req),
  onStreamEvent: (cb: (event: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(STREAM_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(STREAM_EVENT_CHANNEL, listener);
    };
  },
});
