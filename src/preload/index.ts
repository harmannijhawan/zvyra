/**
 * Preload bridge (SHARED, contract-derived). Exposes a narrow, typed API on
 * window.zvyra. No Node, filesystem or shell primitives reach the renderer:
 * only whitelisted contract method names are forwarded.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CONTRACT_VERSION, METHOD_NAMES, type ZvyraEvent } from '../shared/contract'
import { SHELL_METHOD_NAMES, type ShellEvent } from '../shared/shell'
import type { ZvyraBridge } from './types'

const methods = new Set<string>(METHOD_NAMES)
const shellMethods = new Set<string>(SHELL_METHOD_NAMES)

function reject(method: string) {
  return Promise.resolve({
    ok: false as const,
    error: { code: 'INVALID_ARGS' as const, message: `Unknown method: ${method}` }
  })
}

function subscribe<T>(channel: string, listener: (event: T) => void) {
  const handler = (_e: IpcRendererEvent, event: T) => listener(event)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const bridge: ZvyraBridge = {
  contractVersion: CONTRACT_VERSION,
  invoke: (method, args) => (methods.has(method) ? ipcRenderer.invoke('zvyra:invoke', method, args) : reject(method)),
  onEvent: (listener) => subscribe<ZvyraEvent>('zvyra:event', listener),
  shell: {
    invoke: (method, args) =>
      shellMethods.has(method) ? ipcRenderer.invoke('zvyra:shell', method, args) : reject(method),
    onEvent: (listener) => subscribe<ShellEvent>('zvyra:shell-event', listener)
  }
}

contextBridge.exposeInMainWorld('zvyra', bridge)
