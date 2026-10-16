/**
 * Shell-owned persisted window state (island position/mode, main bounds).
 * Stored separately from backend data so geometry survives regardless of
 * which backend is active.
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IslandMode } from '../../shared/shell'

export interface PersistedShellState {
  island: { x: number; y: number; mode: IslandMode; visible: boolean } | null
  main: { x: number; y: number; width: number; height: number; maximized: boolean } | null
}

const EMPTY: PersistedShellState = { island: null, main: null }

export class ShellStateStore {
  private state: PersistedShellState
  private timer: NodeJS.Timeout | null = null
  private readonly file: string

  constructor(userDataPath: string) {
    this.file = join(userDataPath, 'shell-state.json')
    this.state = this.load()
  }

  private load(): PersistedShellState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedShellState>
      return { ...EMPTY, ...raw }
    } catch {
      return { ...EMPTY }
    }
  }

  get(): PersistedShellState {
    return this.state
  }

  update(patch: Partial<PersistedShellState>) {
    this.state = { ...this.state, ...patch }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 400)
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const tmp = this.file + '.tmp'
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(tmp, JSON.stringify(this.state, null, 2))
    await rename(tmp, this.file)
  }
}
