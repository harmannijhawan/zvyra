/**
 * OWNER: Kiro. Runs user-entered commands in PowerShell. Every run needs an
 * explicit native confirmation from main (the renderer cannot bypass it),
 * output is streamed as events, and runs are time-limited and killable.
 */
import { BrowserWindow, dialog } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ZvyraError, type TerminalRun, type ZvyraEventMap } from '../../shared/contract'
import type { JsonDoc } from './jsonDoc'

const TIMEOUT_MS = 15 * 60_000
const POWERSHELL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export interface TerminalState {
  runs: TerminalRun[]
}

type Emit = <K extends keyof ZvyraEventMap>(type: K, payload: ZvyraEventMap[K]) => void

export class TerminalService {
  private procs = new Map<string, ChildProcess>()
  private buffers = new Map<string, string>()
  private waiters = new Map<string, (r: { exitCode: number | null; output: string; status: string }) => void>()
  private trustedThisSession = false

  constructor(
    private readonly doc: JsonDoc<TerminalState>,
    private readonly resolveCwd: (p: string) => Promise<string>,
    private readonly emit: Emit,
    private readonly onActivity: (type: string, title: string, detail?: string, level?: 'info' | 'success' | 'warning' | 'error') => void
  ) {
    // Anything persisted as running belongs to a previous process.
    doc.set((s) => ({ runs: s.runs.map((r) => (r.status === 'running' || r.status === 'awaiting_approval' ? { ...r, status: 'killed' as const, finishedAt: r.finishedAt ?? new Date().toISOString() } : r)) }))
  }

  runs(limit = 30) {
    return this.doc.get().runs.slice(0, limit)
  }

  private upsert(run: TerminalRun) {
    this.doc.set((s) => ({ runs: [run, ...s.runs.filter((r) => r.id !== run.id)].slice(0, 50) }))
    this.emit('terminal.run', run)
  }

  async run(command: string, cwd?: string): Promise<TerminalRun> {
    const cmd = command.trim()
    if (!cmd || cmd.length > 8000) throw new ZvyraError('INVALID_ARGS', 'Enter a command')
    const dir = cwd ? await this.resolveCwd(cwd) : homedir()
    const run: TerminalRun = { id: randomUUID(), command: cmd, cwd: dir, startedAt: new Date().toISOString(), status: 'awaiting_approval' }
    this.upsert(run)

    if (!this.trustedThisSession) {
      const win = BrowserWindow.getFocusedWindow()
      const opts = {
        type: 'warning' as const,
        title: 'Run command?',
        message: 'ZVYRA wants to run this command',
        detail: `${cmd}\n\nFolder: ${dir}`,
        buttons: ['Run', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        checkboxLabel: 'Don’t ask again until ZVYRA restarts',
        noLink: true
      }
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (res.response !== 0) {
        const denied = { ...run, status: 'denied' as const, finishedAt: new Date().toISOString() }
        this.upsert(denied)
        return denied
      }
      if (res.checkboxChecked) this.trustedThisSession = true
    }

    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${cmd}`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    let child: ChildProcess
    try {
      child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { cwd: dir, windowsHide: true })
    } catch (err) {
      const failed = { ...run, status: 'failed' as const, finishedAt: new Date().toISOString() }
      this.upsert(failed)
      throw new ZvyraError('BACKEND_ERROR', `Couldn’t start PowerShell: ${String(err)}`)
    }
    const running = { ...run, status: 'running' as const }
    this.upsert(running)
    this.procs.set(run.id, child)
    this.onActivity('command.executed', `Ran: ${cmd.slice(0, 80)}`, dir)
    const timer = setTimeout(() => this.kill(run.id), TIMEOUT_MS)
    this.buffers.set(run.id, '')
    const append = (s: string) => this.buffers.set(run.id, ((this.buffers.get(run.id) ?? '') + s).slice(-50_000))
    child.stdout?.on('data', (b: Buffer) => {
      append(b.toString('utf8'))
      this.emit('terminal.output', { runId: run.id, stream: 'stdout', chunk: b.toString('utf8') })
    })
    child.stderr?.on('data', (b: Buffer) => {
      append(b.toString('utf8'))
      this.emit('terminal.output', { runId: run.id, stream: 'stderr', chunk: b.toString('utf8') })
    })
    child.on('error', (err) => this.emit('terminal.output', { runId: run.id, stream: 'stderr', chunk: `\n${err.message}\n` }))
    child.on('close', (code) => {
      clearTimeout(timer)
      const wasKilled = !this.procs.has(run.id)
      this.procs.delete(run.id)
      this.waiters.get(run.id)?.({ exitCode: code, output: this.buffers.get(run.id) ?? '', status: wasKilled ? 'killed' : 'exited' })
      this.waiters.delete(run.id)
      setTimeout(() => this.buffers.delete(run.id), 60_000)
      const current = this.doc.get().runs.find((r) => r.id === run.id) ?? running
      if (current.status === 'killed' || wasKilled) return
      this.upsert({ ...current, status: 'exited', exitCode: code, finishedAt: new Date().toISOString() })
      this.emit('terminal.output', { runId: run.id, stream: code === 0 ? 'stdout' : 'stderr', chunk: `\n[exit ${code}]\n` })
    })
    return running
  }

  /** Runs a command (with the same native confirmation) and waits for its output. */
  async runAndWait(command: string, cwd?: string, timeoutMs = 120_000): Promise<{ exitCode: number | null; output: string; status: string }> {
    const run = await this.run(command, cwd)
    if (run.status !== 'running') return { exitCode: null, output: '', status: run.status === 'denied' ? 'denied by user' : run.status }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(run.id)
        resolve({ exitCode: null, output: this.buffers.get(run.id) ?? '', status: 'still running (see Terminal)' })
      }, timeoutMs)
      this.waiters.set(run.id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
    })
  }

  kill(id: string): TerminalRun {
    const run = this.doc.get().runs.find((r) => r.id === id)
    if (!run) throw new ZvyraError('NOT_FOUND', 'Run not found')
    const child = this.procs.get(id)
    if (child?.pid) {
      this.procs.delete(id)
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill())
      const killed = { ...run, status: 'killed' as const, finishedAt: new Date().toISOString() }
      this.upsert(killed)
      this.emit('terminal.output', { runId: id, stream: 'stderr', chunk: '\n[stopped]\n' })
      return killed
    }
    return run
  }

  killAll() {
    for (const id of [...this.procs.keys()]) this.kill(id)
  }

  async openExternal(cwd?: string) {
    const dir = cwd ? await this.resolveCwd(cwd) : homedir()
    await new Promise<void>((resolve) => {
      const wt = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore', windowsHide: false })
      wt.on('error', () => {
        spawn('cmd.exe', ['/c', 'start', '""', POWERSHELL, '-NoExit'], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
        resolve()
      })
      wt.on('spawn', () => {
        wt.unref()
        resolve()
      })
    })
    this.onActivity('app.opened', 'Opened terminal', dir)
  }
}
