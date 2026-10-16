/**
 * OWNER: Kiro. Command approvals and saved "Always allow" rules.
 *
 * Security model
 *  - Only the user can answer: decisions arrive through the trusted-renderer
 *    IPC (`permissions.respond`). No AI tool can reach `respond()`.
 *  - An approval is bound to a fingerprint of the exact shell, normalised
 *    command text and working folder. The operation object is frozen, and the
 *    executor re-checks the fingerprint and re-classifies the command right
 *    before it spawns, so an approved command can't be swapped for another.
 *  - "Always allow" saves a rule that matches only the same shell + program +
 *    normalised command + working folder, and only while the command still
 *    classifies at or below the saved risk. High-risk and critical commands
 *    can never be saved, and critical commands are never even offered.
 *  - Unanswered requests expire (deny) after a few minutes.
 *
 * Pure Node (no Electron) so it is unit-tested directly.
 */
import { createHash, randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import type { CommandRule, CommandShell, PermissionRequest, RiskLevel } from '../../shared/contract'
import { approvalReason, normalizeCommand, riskAtMost, type CommandClassification } from './commandRisk'
import type { JsonDoc } from './jsonDoc'

export interface RulesState {
  rules: CommandRule[]
}

export interface CommandOp {
  readonly shell: CommandShell
  readonly command: string
  readonly cwd: string
  readonly fingerprint: string
  readonly classification: Readonly<CommandClassification>
  /** Who asked: the AI agent/voice session, or the user typing in the Terminal module. */
  readonly source: 'agent' | 'user'
}

export type ApprovalOutcome = 'allow_once' | 'allow_always' | 'deny' | 'expired'

export const APPROVAL_TTL_MS = 5 * 60_000

const cwdKey = (p: string) => win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase()

export function fingerprint(shell: CommandShell, command: string, cwd: string): string {
  return createHash('sha256').update(JSON.stringify([shell, normalizeCommand(command), cwdKey(cwd)])).digest('hex')
}

export function makeOp(shell: CommandShell, command: string, cwd: string, classification: CommandClassification, source: CommandOp['source']): CommandOp {
  return Object.freeze({ shell, command, cwd, fingerprint: fingerprint(shell, command, cwd), classification: Object.freeze({ ...classification }), source })
}

/** Does a saved rule allow this exact operation right now? */
export function ruleMatches(rule: CommandRule, op: CommandOp): boolean {
  if (op.classification.risk === 'critical' || op.classification.risk === 'high') return false
  if (rule.shell !== op.shell) return false
  if (cwdKey(rule.cwd) !== cwdKey(op.cwd)) return false
  if (normalizeCommand(rule.command) !== normalizeCommand(op.command)) return false
  if ((op.classification.programs[0] ?? '') !== rule.program) return false
  return riskAtMost(op.classification.risk, rule.risk)
}

/** Whether the operation must be shown to the user before it runs. */
export function needsApproval(op: CommandOp): boolean {
  if (op.classification.risk === 'low') return false
  // Commands the user typed themselves only prompt when they are high risk.
  if (op.source === 'user') return op.classification.risk === 'high'
  return true
}

interface Pending {
  request: PermissionRequest
  op: CommandOp
  resolve: (o: ApprovalOutcome) => void
  timer: NodeJS.Timeout
}

export interface ApprovalHooks {
  requested(r: PermissionRequest): void
  resolved(id: string, decision: ApprovalOutcome): void
  rulesChanged?(rules: CommandRule[]): void
}

export class ApprovalService {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly doc: JsonDoc<RulesState>,
    private readonly hooks: ApprovalHooks,
    private readonly ttlMs = APPROVAL_TTL_MS
  ) {}

  owns(id: string) {
    return this.pending.has(id)
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  rules(): CommandRule[] {
    return this.doc.get().rules
  }

  findRule(op: CommandOp): CommandRule | undefined {
    return this.rules().find((r) => ruleMatches(r, op))
  }

  /** Marks a rule as used (for the review list). */
  touchRule(id: string) {
    this.doc.set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, uses: r.uses + 1, lastUsedAt: new Date().toISOString() } : r)) }))
  }

  revoke(id: string): CommandRule[] {
    const next = this.rules().filter((r) => r.id !== id)
    this.doc.set({ rules: next })
    this.hooks.rulesChanged?.(next)
    return next
  }

  private saveRule(op: CommandOp): CommandRule | null {
    const risk = op.classification.risk
    if (risk !== 'medium' && risk !== 'low') return null
    const existing = this.findRule(op)
    if (existing) return existing
    const rule: CommandRule = {
      id: randomUUID(),
      shell: op.shell,
      program: op.classification.programs[0] ?? '',
      command: normalizeCommand(op.command),
      cwd: op.cwd,
      risk: risk as RiskLevel,
      createdAt: new Date().toISOString(),
      uses: 0
    }
    const next = [rule, ...this.rules()].slice(0, 200)
    this.doc.set({ rules: next })
    this.hooks.rulesChanged?.(next)
    return rule
  }

  /** Shows the request to the user and resolves with their decision. Critical ops are never asked. */
  request(op: CommandOp, meta: { taskTitle?: string } = {}): { id: string; outcome: Promise<ApprovalOutcome> } {
    if (op.classification.risk === 'critical') throw new Error('Critical commands are blocked and cannot be approved')
    const id = `cmd-${randomUUID()}`
    const c = op.classification
    const risk: RiskLevel = c.risk === 'high' ? 'high' : c.risk === 'medium' ? 'medium' : 'low'
    const now = Date.now()
    const request: PermissionRequest = {
      id,
      category: c.targets.length && /delet/i.test(c.summary) ? 'delete_files' : 'run_commands',
      title: c.summary.length > 90 ? `${c.summary.slice(0, 88)}…` : c.summary,
      description: meta.taskTitle ? `ZVYRA wants to run this for “${meta.taskTitle}”.` : 'ZVYRA wants to run this command.',
      risk,
      reason: approvalReason(c),
      targets: c.targets.slice(0, 6),
      canAlwaysAllow: risk === 'medium',
      command: { shell: op.shell, text: op.command, cwd: op.cwd },
      details: [
        { label: 'Command', value: op.command.length > 2000 ? `${op.command.slice(0, 2000)}…` : op.command },
        { label: 'Shell', value: op.shell === 'cmd' ? 'Command Prompt (cmd.exe)' : 'Windows PowerShell' },
        { label: 'Folder', value: op.cwd },
        ...(c.targets.length ? [{ label: 'Affects', value: c.targets.slice(0, 6).join('\n') }] : []),
        ...(c.reasons.length > 1 ? [{ label: 'Also', value: c.reasons.slice(1).join('; ') }] : [])
      ],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString()
    }
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(id, 'expired'), this.ttlMs)
      timer.unref?.()
      this.pending.set(id, { request, op, resolve, timer })
    })
    this.hooks.requested(request)
    return { id, outcome }
  }

  /** Called only from the trusted renderer IPC path. */
  respond(id: string, decision: string): void {
    const p = this.pending.get(id)
    if (!p) throw new Error('This approval request has expired or was already answered')
    if (decision === 'deny') return this.finish(id, 'deny')
    if (decision === 'allow_once' || decision === 'allow_task') return this.finish(id, 'allow_once')
    if (decision === 'allow_always') {
      if (!p.request.canAlwaysAllow) throw new Error('High-risk commands can only be approved one at a time')
      this.saveRule(p.op)
      return this.finish(id, 'allow_always')
    }
    throw new Error(`Unknown decision: ${decision}`)
  }

  /** Denies everything still waiting (Stop all, shutdown). */
  denyAll() {
    for (const id of [...this.pending.keys()]) this.finish(id, 'deny')
  }

  private finish(id: string, outcome: ApprovalOutcome) {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    this.hooks.resolved(id, outcome)
    p.resolve(outcome)
  }
}

/** Immediately before spawning: the approved operation must still be exactly what was approved. */
export function verifyBeforeRun(approved: CommandOp, shell: CommandShell, command: string, cwd: string, reclassified: CommandClassification): string | null {
  if (fingerprint(shell, command, cwd) !== approved.fingerprint) return 'The command changed after it was approved, so it was not run.'
  if (reclassified.risk === 'critical') return 'The command is blocked by ZVYRA’s safety rules.'
  if (!riskAtMost(reclassified.risk, approved.classification.risk)) return 'The command became riskier after approval, so it was not run.'
  return null
}
