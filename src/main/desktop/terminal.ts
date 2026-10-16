/**
 * OWNER: Kiro. Runs CMD / PowerShell commands for the Terminal module and for
 * the AI (voice session + typed agent).
 *
 * Every run goes through the same pipeline:
 *   classify (commandRisk) → policy (critical = blocked, low = run,
 *   saved rule = run, otherwise ask) → approval popup in the Dynamic Island
 *   (approvals) → re-verify the exact approved command → execute (exec).
 * Output is streamed as `terminal.output`, results are real exit codes, and
 * runs are time-limited and killable. Nothing runs before approval.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ZvyraError, type CommandShell, type DesktopToast, type TerminalRun, type ZvyraEventMap } from '../../shared/contract'
import { classifyCommand, type CommandClassification, type CommandContext } from './commandRisk'
import { ApprovalService, makeOp, needsApproval, verifyBeforeRun, type CommandOp } from './approvals'
import { describeResult, startCommand, DEFAULT_TIMEOUT_MS, POWERSHELL_EXE, type ExecHandle, type ExecResult } from './exec'
import type { JsonDoc } from './jsonDoc'

const UI_TIMEOUT_MS = 15 * 60_000
const MAX_COMMAND = 200_000

export interface TerminalState {
  runs: TerminalRun[]
}

type Emit = <K extends keyof ZvyraEventMap>(type: K, payload: ZvyraEventMap[K]) => void
type Activity = (type: string, title: string, detail?: string, level?: 'info' | 'success' | 'warning' | 'error') => void
export type Notify = (t: Omit<DesktopToast, 'id' | 'ts'> & { id?: string }) => void

export interface RunOptions {
  shell?: CommandShell
  source: 'agent' | 'user'
  /** Leave long-running commands (dev servers) running and return after `waitMs`. */
  background?: boolean
  waitMs?: number
  timeoutMs?: number
  taskTitle?: string
  signal?: AbortSignal
  /** Called with every state change of this run (awaiting approval, running, finished). */
  onRun?: (run: TerminalRun) => void
}

/** What the AI gets back: always the real outcome, never an assumed success. */
export interface CommandOutcome {
  status: 'completed' | 'failed' | 'denied' | 'blocked' | 'expired' | 'timeout' | 'cancelled' | 'running' | 'error'
  ok: boolean
  exitCode: number | null
  output: string
  summary: string
  risk: CommandClassification['risk']
  shell: CommandShell
  cwd: string
  runId?: string
  url?: string
  approvedBy?: 'policy' | 'user' | 'rule'
}

const shortCmd = (c: string) => (c.length > 90 ? `${c.slice(0, 88)}…` : c).replace(/\s+/g, ' ')
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>)]*)?/i

export class TerminalService {
  private procs = new Map<string, ExecHandle>()

  constructor(
    private readonly doc: JsonDoc<TerminalState>,
    /** Resolves and authorises a working folder (throws when it isn't allowed). */
    private readonly resolveCwd: (p: string) => Promise<string>,
    private readonly emit: Emit,
    private readonly onActivity: Activity,
    private readonly approvals: ApprovalService,
    private readonly classifyContext: (cwd: string) => Promise<CommandContext>,
    private readonly notify: Notify
  ) {
    // Anything persisted as running belongs to a previous process.
    doc.set((s) => ({ runs: s.runs.map((r) => (r.status === 'running' || r.status === 'awaiting_approval' ? { ...r, status: 'killed' as const, finishedAt: r.finishedAt ?? new Date().toISOString() } : r)) }))
  }

  runs(limit = 30) {
    return this.doc.get().runs.slice(0, limit)
  }

  private upsert(run: TerminalRun, o?: RunOptions) {
    try {
      o?.onRun?.(run)
    } catch {
      /* listener errors must not break the run */
    }
    this.doc.set((s) => ({ runs: [run, ...s.runs.filter((r) => r.id !== run.id)].slice(0, 50) }))
    this.emit('terminal.run', run)
  }

  async classify(command: string, shell: CommandShell, cwd: string) {
    return classifyCommand(command, shell, await this.classifyContext(cwd))
  }

  /**
   * Classifies, asks when needed, runs. Resolves once the command has finished
   * (or, for background runs, after `waitMs` while it keeps running).
   */
  async execute(command: string, cwd: string | undefined, o: RunOptions): Promise<CommandOutcome> {
    const shell: CommandShell = o.shell === 'cmd' ? 'cmd' : 'powershell'
    const text = (command ?? '').replace(/^\uFEFF/, '').trimEnd()
    if (!text.trim()) throw new ZvyraError('INVALID_ARGS', 'Enter a command')
    if (text.length > MAX_COMMAND) throw new ZvyraError('INVALID_ARGS', 'That script is too long to review safely')
    const dir = cwd ? await this.resolveCwd(cwd) : homedir()
    const classification = await this.classify(text, shell, dir)
    const op = makeOp(shell, text, dir, classification, o.source)
    const base = { risk: classification.risk, shell, cwd: dir }
    const run: TerminalRun = { id: randomUUID(), command: text, cwd: dir, shell, startedAt: new Date().toISOString(), status: 'awaiting_approval' }

    // 1. Critical: never runs, can't be approved or saved.
    if (classification.risk === 'critical') {
      this.upsert({ ...run, status: 'denied', finishedAt: new Date().toISOString() }, o)
      this.emit('terminal.output', { runId: run.id, stream: 'stderr', chunk: `Blocked by ZVYRA safety rules: ${classification.summary}\n` })
      this.onActivity('command.blocked', `Blocked: ${shortCmd(text)}`, classification.summary, 'error')
      this.notify({ key: `blocked:${op.fingerprint}`, kind: 'denied', title: 'Command blocked', body: classification.summary, detail: shortCmd(text), timeoutMs: 9000 })
      return { ...base, status: 'blocked', ok: false, exitCode: null, output: '', summary: `Blocked by ZVYRA’s safety rules: ${classification.summary}. Do not try to work around this; tell the user what was blocked and why.`, runId: run.id }
    }

    // 2. Policy / saved rule / approval.
    let approvedBy: CommandOutcome['approvedBy'] = 'policy'
    if (needsApproval(op)) {
      const rule = this.approvals.findRule(op)
      if (rule) {
        approvedBy = 'rule'
        this.approvals.touchRule(rule.id)
        this.onActivity('permission.rule', `Allowed by a saved rule: ${shortCmd(text)}`, dir)
      } else {
        this.upsert(run, o)
        const { id, outcome } = this.approvals.request(op, { taskTitle: o.taskTitle })
        const onAbort = () => this.approvals.respond(id, 'deny')
        o.signal?.addEventListener('abort', onAbort, { once: true })
        const decision = await outcome
        o.signal?.removeEventListener('abort', onAbort)
        if (decision === 'deny' || decision === 'expired') {
          this.upsert({ ...run, status: 'denied', finishedAt: new Date().toISOString() }, o)
          this.emit('terminal.output', { runId: run.id, stream: 'stderr', chunk: decision === 'expired' ? 'No answer — the command was not run.\n' : 'Denied — the command was not run.\n' })
          this.onActivity('command.denied', `${decision === 'expired' ? 'Approval expired' : 'Denied'}: ${shortCmd(text)}`, dir, 'warning')
          this.notify({ key: `denied:${id}`, kind: 'denied', title: decision === 'expired' ? 'Approval expired' : 'Command denied', body: 'ZVYRA did not run it.', detail: shortCmd(text), timeoutMs: 6000 })
          return {
            ...base,
            status: decision === 'expired' ? 'expired' : 'denied',
            ok: false,
            exitCode: null,
            output: '',
            summary: decision === 'expired' ? 'The user did not answer the approval request in time, so the command was NOT run.' : 'The user denied this command, so it was NOT run. Stop this operation and tell the user.',
            runId: run.id
          }
        }
        approvedBy = 'user'
        this.notify({ key: `approved:${id}`, kind: 'approved', title: decision === 'allow_always' ? 'Always allowed' : 'Command approved', body: decision === 'allow_always' ? 'Saved as a rule for this exact command and folder.' : 'Running it once.', detail: shortCmd(text), timeoutMs: 3500 })
      }
    }

    // 3. Re-validate the exact operation right before it runs.
    const recheck = await this.classify(op.command, op.shell, op.cwd)
    const problem = verifyBeforeRun(op, op.shell, op.command, op.cwd, recheck)
    if (problem) {
      this.upsert({ ...run, status: 'denied', finishedAt: new Date().toISOString() }, o)
      this.notify({ key: `verify:${run.id}`, kind: 'denied', title: 'Command not run', body: problem, detail: shortCmd(text), timeoutMs: 8000 })
      return { ...base, status: 'blocked', ok: false, exitCode: null, output: '', summary: problem, runId: run.id }
    }

    return this.spawnApproved(op, run, o, approvedBy)
  }

  private async spawnApproved(op: CommandOp, run: TerminalRun, o: RunOptions, approvedBy: CommandOutcome['approvedBy']): Promise<CommandOutcome> {
    const running: TerminalRun = { ...run, status: 'running' }
    this.upsert(running, o)
    this.outputBuffers.set(run.id, '')
    this.onActivity('command.executed', `Ran: ${shortCmd(op.command)}`, op.cwd)
    let url: string | undefined
    const handle = startCommand({
      shell: op.shell,
      command: op.command,
      cwd: op.cwd,
      timeoutMs: o.background ? Math.max(o.timeoutMs ?? 0, 4 * 3600_000) : (o.timeoutMs ?? (o.source === 'user' ? UI_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)),
      signal: o.background ? undefined : o.signal,
      onOutput: (stream, chunk) => {
        if (!url) url = LOCAL_URL.exec(chunk)?.[0]
        this.outputBuffers.set(run.id, ((this.outputBuffers.get(run.id) ?? '') + chunk).slice(-20_000))
        this.emit('terminal.output', { runId: run.id, stream, chunk })
      }
    })
    this.procs.set(run.id, handle)
    const base = { risk: op.classification.risk, shell: op.shell, cwd: op.cwd, runId: run.id, approvedBy }
    const finished = handle.done.then((r) => {
      this.procs.delete(run.id)
      const status: TerminalRun['status'] = r.status === 'spawn_error' ? 'failed' : r.status === 'exited' ? 'exited' : 'killed'
      setTimeout(() => this.outputBuffers.delete(run.id), 60_000).unref?.()
      this.upsert({ ...running, status, exitCode: r.exitCode, finishedAt: new Date().toISOString() }, o)
      this.emit('terminal.output', { runId: run.id, stream: r.exitCode === 0 ? 'stdout' : 'stderr', chunk: `\n[${describeResult(r)}]\n` })
      const ok = r.status === 'exited' && r.exitCode === 0
      if (!ok) this.onActivity('command.failed', `Command ${r.status === 'timeout' ? 'timed out' : 'failed'}: ${shortCmd(op.command)}`, describeResult(r), 'error')
      // Outcomes of commands the user had to think about are always reported.
      if (approvedBy !== 'policy' || !ok) {
        this.notify({ key: `done:${run.id}`, kind: ok ? 'success' : 'error', title: ok ? 'Command finished' : 'Command failed', body: describeResult(r), detail: shortCmd(op.command), timeoutMs: ok ? 4500 : 9000 })
      }
      return r
    })

    if (o.background) {
      const waitMs = Math.min(30_000, Math.max(1500, o.waitMs ?? 8000))
      const early = await Promise.race([finished, new Promise<null>((r) => setTimeout(() => r(null), waitMs))])
      const output = this.outputSoFar(run.id)
      if (!early) {
        this.notify({ key: `launch:${run.id}`, kind: 'launch', title: 'Project launched', body: url ? `Running at ${url}` : 'Still running in the background.', detail: shortCmd(op.command), timeoutMs: 6000 })
        return { ...base, status: 'running', ok: true, exitCode: null, output, url, summary: `Started and still running after ${Math.round(waitMs / 1000)} s${url ? ` — serving ${url}` : ''}. Run id ${run.id}; it keeps running until stopped.` }
      }
      return this.toOutcome(early, base, url)
    }
    return this.toOutcome(await finished, base, url)
  }

  private outputBuffers = new Map<string, string>()
  private outputSoFar(runId: string) {
    return (this.outputBuffers.get(runId) ?? '').slice(-8000)
  }

  private toOutcome(r: ExecResult, base: Omit<CommandOutcome, 'status' | 'ok' | 'exitCode' | 'output' | 'summary'>, url?: string): CommandOutcome {
    const ok = r.status === 'exited' && r.exitCode === 0
    const status: CommandOutcome['status'] = r.status === 'exited' ? (ok ? 'completed' : 'failed') : r.status === 'spawn_error' ? 'error' : r.status
    return { ...base, status, ok, exitCode: r.exitCode, output: r.output.slice(-12_000), url, summary: describeResult(r) }
  }

  /** Terminal module (user-typed). Resolves with the run as soon as it is waiting for approval, running, denied or blocked. */
  run(command: string, cwd?: string, shell: CommandShell = 'powershell'): Promise<TerminalRun> {
    return new Promise<TerminalRun>((resolve, reject) => {
      let settled = false
      const onRun = (r: TerminalRun) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      this.execute(command, cwd, { source: 'user', shell, timeoutMs: UI_TIMEOUT_MS, onRun }).then(
        (o) => {
          if (settled) return
          const r = o.runId ? this.doc.get().runs.find((x) => x.id === o.runId) : undefined
          if (r) onRun(r)
          else reject(new ZvyraError('BACKEND_ERROR', o.summary))
        },
        (err) => {
          if (!settled) reject(err)
        }
      )
    })
  }

  kill(id: string): TerminalRun {
    const run = this.doc.get().runs.find((r) => r.id === id)
    if (!run) throw new ZvyraError('NOT_FOUND', 'Run not found')
    const h = this.procs.get(id)
    if (h) {
      h.kill('cancelled')
      this.emit('terminal.output', { runId: id, stream: 'stderr', chunk: '\n[stopping…]\n' })
    }
    return run
  }

  killAll() {
    for (const h of this.procs.values()) h.kill('cancelled')
    this.approvals.denyAll()
  }

  async openExternal(cwd?: string) {
    const dir = cwd ? await this.resolveCwd(cwd) : homedir()
    await new Promise<void>((resolve) => {
      const wt = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore', windowsHide: false })
      wt.on('error', () => {
        spawn(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/c', 'start', '""', POWERSHELL_EXE, '-NoExit'], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
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
