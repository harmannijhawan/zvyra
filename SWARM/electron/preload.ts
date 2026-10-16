import { contextBridge, ipcRenderer } from 'electron';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const ALLOWED_EVENTS = new Set(['account:changed', 'chat:updated', 'chat:turn', 'workspace:event', 'computer:activity', 'events', 'run:updated', 'models:changed', 'settings:changed', 'notification', 'approvals:changed', 'menu', 'run:chat:updated', 'remote:changed']);

contextBridge.exposeInMainWorld('swarm', {
  invoke,
  on(channel: string, fn: (payload: unknown) => void) {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`Channel not allowed: ${channel}`);
    const listener = (_e: unknown, payload: unknown) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: process.platform,
});
