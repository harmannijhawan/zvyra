/**
 * OWNER: Kiro. Approvals for consequential non-command actions: sending a
 * message, starting a call, submitting a web form, publishing.
 *
 * Security model (same as command approvals):
 *  - Only the user answers, through the trusted renderer IPC (`permissions.respond`).
 *  - The request is bound to a fingerprint of the exact payload (recipient + text…);
 *    the executor re-checks it right before acting, so an approved message can't
 *    be swapped for another.
 *  - Never auto-approved: Bypass/autonomous mode does not apply to communication.
 *  - Unanswered requests expire (deny).
 *
 * Pure Node (no Electron) so it is unit-tested directly.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { PermissionCategory, PermissionRequest, RiskLevel } from '../../shared/contract'

export type ActionOutcome = 'allow_once' | 'deny' | 'expired'

export interface ActionRequest {
  category: PermissionCategory
  title: string
  description: string
  risk: RiskLevel
  details?: { label: string; value: string }[]
  taskId?: string
  /** Exactly what will be done; fingerprinted. */
  payload: unknown
}

export const ACTION_TTL_MS = 5 * 60_000

export function actionFingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

interface Pending {
  request: PermissionRequest
  fingerprint: string
  resolve: (o: ActionOutcome) => void
  timer: NodeJS.Timeout
}

export interface ActionApprovalHooks {
  requested(r: PermissionRequest): void
  resolved(id: string, decision: ActionOutcome): void
}

export class ActionApprovals {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly hooks: ActionApprovalHooks,
    private readonly ttlMs = ACTION_TTL_MS
  ) {}

  owns(id: string) {
    return this.pending.has(id)
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  request(a: ActionRequest): { id: string; fingerprint: string; outcome: Promise<ActionOutcome> } {
    const id = `act-${randomUUID()}`
    const now = Date.now()
    const fingerprint = actionFingerprint(a.payload)
    const request: PermissionRequest = {
      id,
      taskId: a.taskId,
      category: a.category,
      title: a.title.length > 90 ? `${a.title.slice(0, 88)}…` : a.title,
      description: a.description,
      risk: a.risk,
      details: a.details,
      reason: 'ZVYRA always asks before it contacts someone or acts for you outside this PC.',
      canAlwaysAllow: false,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString()
    }
    const outcome = new Promise<ActionOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(id, 'expired'), this.ttlMs)
      timer.unref?.()
      this.pending.set(id, { request, fingerprint, resolve, timer })
    })
    this.hooks.requested(request)
    return { id, fingerprint, outcome }
  }

  /** Called only from the trusted renderer IPC path. */
  respond(id: string, decision: string) {
    if (!this.pending.has(id)) throw new Error('This approval request has expired or was already answered')
    if (decision === 'deny') return this.finish(id, 'deny')
    if (decision === 'allow_once' || decision === 'allow_task') return this.finish(id, 'allow_once')
    throw new Error('Messages, calls and submissions are approved one at a time')
  }

  denyAll() {
    for (const id of [...this.pending.keys()]) this.finish(id, 'deny')
  }

  private finish(id: string, outcome: ActionOutcome) {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    this.hooks.resolved(id, outcome)
    p.resolve(outcome)
  }
}

/** Right before acting: is the payload still exactly what the user approved? */
export function stillApproved(fingerprint: string, payload: unknown) {
  return actionFingerprint(payload) === fingerprint
}
