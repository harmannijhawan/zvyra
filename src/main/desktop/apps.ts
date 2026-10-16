/**
 * OWNER: Kiro. Launchable apps, integration detection, editor and browser
 * hand-off. Only launches things the user added or well-known system apps.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { ZvyraError, type Integration, type LaunchableApp } from '../../shared/contract'
import type { JsonDoc } from './jsonDoc'

export interface AppsState {
  apps: LaunchableApp[]
}

function where(cmd: string): string | null {
  try {
    const r = spawnSync('where.exe', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    const first = r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean) : null
    return first?.trim() || null
  } catch {
    return null
  }
}

let vscodeCache: string | null | undefined
export function findVSCode(): string | null {
  if (vscodeCache !== undefined) return vscodeCache
  const local = process.env['LOCALAPPDATA'] ?? ''
  const candidates = [
    join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft VS Code', 'Code.exe')
  ]
  const cli = where('code')
  if (cli) candidates.unshift(join(dirname(dirname(cli)), 'Code.exe'))
  vscodeCache = candidates.find((c) => existsSync(c)) ?? null
  return vscodeCache
}

export class AppsService {
  constructor(
    private readonly doc: JsonDoc<AppsState>,
    private readonly onActivity: (type: string, title: string, detail?: string) => void
  ) {}

  list() {
    return this.doc.get().apps
  }

  async add(): Promise<LaunchableApp | null> {
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: 'Add an app ZVYRA can launch',
      properties: ['openFile'] as 'openFile'[],
      filters: [{ name: 'Apps and shortcuts', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd', 'appref-ms'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = r.filePaths[0]
    if (r.canceled || !path) return null
    let iconDataUrl: string | undefined
    try {
      iconDataUrl = (await app.getFileIcon(path, { size: 'normal' })).toDataURL()
    } catch {
      iconDataUrl = undefined
    }
    const item: LaunchableApp = { id: randomUUID(), name: basename(path, extname(path)), path, iconDataUrl, pinned: true }
    this.doc.set((s) => ({ apps: [...s.apps.filter((a) => a.path !== path), item] }))
    return item
  }

  remove(id: string) {
    this.doc.set((s) => ({ apps: s.apps.filter((a) => a.id !== id) }))
  }

  setPinned(id: string, pinned: boolean): LaunchableApp {
    const a = this.doc.get().apps.find((x) => x.id === id)
    if (!a) throw new ZvyraError('NOT_FOUND', 'App not found')
    const next = { ...a, pinned }
    this.doc.set((s) => ({ apps: s.apps.map((x) => (x.id === id ? next : x)) }))
    return next
  }

  async launch(id: string) {
    const a = this.doc.get().apps.find((x) => x.id === id)
    if (!a?.path) throw new ZvyraError('NOT_FOUND', 'App not found')
    if (!existsSync(a.path)) throw new ZvyraError('NOT_FOUND', `${a.name} is no longer at ${a.path}`)
    const err = await shell.openPath(a.path)
    if (err) throw new ZvyraError('BACKEND_ERROR', err)
    this.doc.set((s) => ({ apps: s.apps.map((x) => (x.id === id ? { ...x, lastUsedAt: new Date().toISOString() } : x)) }))
    this.onActivity('app.opened', `Opened ${a.name}`)
  }

  async openUrl(url: string) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new ZvyraError('INVALID_ARGS', 'Invalid address')
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ZvyraError('INVALID_ARGS', 'Only http and https addresses can be opened')
    await shell.openExternal(u.toString())
    this.onActivity('browser.opened', `Opened ${u.hostname}`, u.toString())
  }

  async openInEditor(path: string) {
    const code = findVSCode()
    if (code) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(code, [path], { detached: true, stdio: 'ignore' })
        child.on('error', reject)
        child.on('spawn', () => {
          child.unref()
          resolve()
        })
      })
      this.onActivity('app.opened', `Opened ${basename(path)} in VS Code`, path)
      return
    }
    const err = await shell.openPath(path)
    if (err) throw new ZvyraError('BACKEND_ERROR', err)
    this.onActivity('app.opened', `Opened ${basename(path)}`, path)
  }

  integrations(extra: Integration[]): Integration[] {
    const code = findVSCode()
    const wt = where('wt')
    return [
      ...extra,
      { id: 'vscode', name: 'Visual Studio Code', category: 'editor', status: code ? 'connected' : 'not_installed', detail: code ?? 'Not found — Code Studio opens folders in File Explorer instead', setupHint: code ? undefined : 'Install VS Code from code.visualstudio.com' },
      { id: 'browser', name: 'Default browser', category: 'browser', status: 'connected', detail: 'Pages open in your default browser' },
      { id: 'terminal', name: wt ? 'Windows Terminal' : 'PowerShell', category: 'terminal', status: 'connected', detail: wt ? 'Opens in Windows Terminal' : 'Opens in PowerShell' },
      { id: 'explorer', name: 'File Explorer', category: 'files', status: 'connected', detail: 'Reveal and open files' }
    ]
  }
}
