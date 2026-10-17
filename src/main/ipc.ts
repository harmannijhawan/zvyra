/**
 * Contract transport (SHARED). Forwards whitelisted method calls to the
 * active backend and broadcasts backend events to every window.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  METHOD_NAMES,
  ZvyraError,
  type InvokeResult,
  type MethodName,
  type ZvyraBackend,
  type ZvyraErrorShape
} from '../shared/contract'
import type { ShellLogger } from './backendContext'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const allowed = new Set<string>(METHOD_NAMES)

export function toErrorShape(err: unknown): ZvyraErrorShape {
  if (err instanceof ZvyraError) return { code: err.code, message: err.message, fixRoute: err.fixRoute }
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: unknown; message: unknown; fixRoute?: unknown }
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return { code: e.code as ZvyraErrorShape['code'], message: e.message, fixRoute: typeof e.fixRoute === 'string' ? e.fixRoute : undefined }
    }
  }
  return { code: 'BACKEND_ERROR', message: err instanceof Error ? err.message : String(err) }
}

/** Only accept calls from our own windows (file:// or the dev server). */
export function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (e.senderFrame !== e.sender.mainFrame || !BrowserWindow.fromWebContents(e.sender)) return false
  if (dev) {
    try {
      const current = new URL(url), configured = new URL(dev)
      return current.origin === configured.origin && ['/', '/index.html', '/island.html', '/guide.html'].includes(current.pathname)
    } catch { return false }
  }
  const page = url.split('#')[0].split('?')[0]
  return ['index.html', 'island.html', 'guide.html'].some(name => page === pathToFileURL(resolve(__dirname, '../renderer', name)).href)
}

export function registerContractIpc(getBackend: () => ZvyraBackend, logger: ShellLogger) {
  ipcMain.handle('zvyra:invoke', async (e, method: unknown, args: unknown): Promise<InvokeResult<unknown>> => {
    if (!isTrustedSender(e)) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Untrusted sender' } }
    if (typeof method !== 'string' || !allowed.has(method)) {
      return { ok: false, error: { code: 'INVALID_ARGS', message: `Unknown method: ${String(method)}` } }
    }
    try {
      const result = await getBackend().invoke(method as MethodName, args as never)
      return { ok: true, result }
    } catch (err) {
      const shape = toErrorShape(err)
      if (shape.code === 'BACKEND_ERROR') logger.error('ipc', `${method} failed`, { message: shape.message })
      return { ok: false, error: shape }
    }
  })
}

export function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) continue
    if (win.webContents.getURL().includes('/voice.html')) continue // audio-only window has no UI bridge
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* frame went away mid-send */
    }
  }
}
