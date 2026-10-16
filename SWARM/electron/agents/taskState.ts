// Task lifecycle state machine.
// QUEUED(waiting) → READY → RUNNING → VERIFYING → COMPLETED, plus BLOCKED, FAILED, CANCELLED, RETRY_WAIT, SKIPPED.
// Terminal states never return to an active state unless the caller declares an explicit retry.
import type { TaskStatus } from '../../shared/types';

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'failed', 'skipped', 'cancelled']);
export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['running', 'verifying']);
export const isTerminal = (s: TaskStatus) => TERMINAL_STATUSES.has(s);

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  waiting: ['ready', 'running', 'blocked', 'skipped', 'cancelled', 'failed'],
  ready: ['waiting', 'running', 'blocked', 'skipped', 'cancelled'],
  // running → waiting: the user stopped one agent; the task is queued again.
  running: ['verifying', 'completed', 'failed', 'cancelled', 'skipped', 'blocked', 'retry_wait', 'waiting'],
  verifying: ['running', 'completed', 'failed', 'cancelled', 'blocked'],
  retry_wait: ['waiting', 'failed', 'cancelled', 'blocked'],
  blocked: ['waiting', 'failed', 'cancelled', 'skipped'],
  completed: [],
  failed: [],
  skipped: [],
  cancelled: [],
};
/** Allowed only with an explicit retry/resume decision. */
const RETRY_FROM_TERMINAL: TaskStatus[] = ['waiting', 'retry_wait'];

export class IllegalTransitionError extends Error {
  constructor(public from: TaskStatus, public to: TaskStatus, taskId: string) {
    super(`Illegal task transition ${from} → ${to} for ${taskId}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus, opts: { retry?: boolean } = {}): boolean {
  if (from === to) return true;
  if (ALLOWED[from]?.includes(to)) return true;
  return !!opts.retry && isTerminal(from) && RETRY_FROM_TERMINAL.includes(to);
}

export function assertTransition(taskId: string, from: TaskStatus, to: TaskStatus, opts: { retry?: boolean } = {}) {
  if (!canTransition(from, to, opts)) throw new IllegalTransitionError(from, to, taskId);
}
