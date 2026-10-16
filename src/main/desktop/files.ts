/**
 * OWNER: Kiro. File access restricted to authorised roots: project folders
 * (from the engine) plus folders the user picks in a native dialog.
 */
import { BrowserWindow, dialog, shell } from 'electron'
import { open, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ZvyraError, type FileContent, type FileEntry, type FileRoot, type Project } from '../../shared/contract'
import type { JsonDoc } from './jsonDoc'
import { isInside } from './pure'

const MAX_READ = 512 * 1024
const MAX_ENTRIES = 2000

export interface FilesState {
  roots: { path: string; label: string }[]
}

export class FileService {
  constructor(
    private readonly doc: JsonDoc<FilesState>,
    private readonly projects: () => Promise<Project[]>,
    private readonly onActivity: (type: string, title: string, detail?: string) => void
  ) {}

  async roots(): Promise<FileRoot[]> {
    const projects = await this.projects().catch(() => [] as Project[])
    const out: FileRoot[] = projects.filter((p) => p.path).map((p) => ({ path: p.path, label: p.name, source: 'project', projectId: p.id }))
    for (const r of this.doc.get().roots) if (!out.some((o) => isInside(o.path, r.path) && isInside(r.path, o.path))) out.push({ ...r, source: 'user' })
    return out
  }

  /** Resolves a path and verifies it is inside an authorised root. */
  async resolve(p: string): Promise<string> {
    if (typeof p !== 'string' || !p || p.length > 4096) throw new ZvyraError('INVALID_ARGS', 'Invalid path')
    let real: string
    try {
      real = await realpath(p)
    } catch {
      throw new ZvyraError('NOT_FOUND', `Path not found: ${p}`)
    }
    for (const r of await this.roots()) {
      const rootReal = await realpath(r.path).catch(() => null)
      if (rootReal && isInside(rootReal, real)) return real
    }
    throw new ZvyraError('PERMISSION_DENIED', 'That location is outside the folders you have authorised. Add it in Files → Authorise folder.')
  }

  async addRoot(): Promise<FileRoot | null> {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], title: 'Authorise a folder for ZVYRA' }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    const path = await realpath(r.filePaths[0])
    const root = { path, label: basename(path) || path }
    this.doc.set((s) => ({ roots: [...s.roots.filter((x) => x.path !== path), root] }))
    this.onActivity('file.authorised', `Folder authorised: ${root.label}`, path)
    return { ...root, source: 'user' }
  }

  removeRoot(path: string) {
    this.doc.set((s) => ({ roots: s.roots.filter((x) => x.path !== path) }))
  }

  async list(path: string): Promise<FileEntry[]> {
    const dir = await this.resolve(path)
    const entries = (await readdir(dir, { withFileTypes: true })).slice(0, MAX_ENTRIES)
    const out: FileEntry[] = []
    for (const e of entries) {
      if (!e.isFile() && !e.isDirectory()) continue
      const full = join(dir, e.name)
      const st = await stat(full).catch(() => null)
      out.push({ name: e.name, path: full, type: e.isDirectory() ? 'directory' : 'file', size: st && e.isFile() ? st.size : undefined, modifiedAt: st?.mtime.toISOString() })
    }
    return out
  }

  async read(path: string): Promise<FileContent> {
    const file = await this.resolve(path)
    const st = await stat(file)
    if (!st.isFile()) throw new ZvyraError('INVALID_ARGS', 'Not a file')
    const fh = await open(file, 'r')
    try {
      const len = Math.min(st.size, MAX_READ)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, 0)
      const binary = buf.subarray(0, Math.min(len, 8000)).includes(0)
      return { path: file, content: binary ? '' : buf.toString('utf8'), encoding: binary ? 'binary' : 'utf8', truncated: st.size > MAX_READ, size: st.size }
    } finally {
      await fh.close()
    }
  }

  async write(path: string, content: string): Promise<FileContent> {
    if (typeof content !== 'string' || content.length > 5 * 1024 * 1024) throw new ZvyraError('INVALID_ARGS', 'Content too large')
    const file = await this.resolve(path)
    await writeFile(file, content, 'utf8')
    this.onActivity('file.modified', `Saved ${basename(file)}`, file)
    return this.read(file)
  }

  async reveal(path: string) {
    shell.showItemInFolder(await this.resolve(path))
  }

  async openExternal(path: string) {
    const err = await shell.openPath(await this.resolve(path))
    if (err) throw new ZvyraError('BACKEND_ERROR', err)
    this.onActivity('file.opened', `Opened ${basename(path)}`, path)
  }
}
