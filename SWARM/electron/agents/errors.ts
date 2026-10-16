// Typed execution errors so recovery can act on the actual cause instead of retrying blindly.
import type { ErrorCategory } from '../../shared/types';
import { CancelledError } from '../core/util';
import { NoModelError, categoryOf } from '../router/router';
import { ProviderError } from '../providers/types';

/** A per-task or per-run budget (tokens, wall time) was exhausted. Never retried automatically. */
export class BudgetExceededError extends Error {
  readonly category: ErrorCategory = 'budget';
  /** 'run' budgets stop the whole run; 'task' budgets stop only the task. */
  constructor(msg: string, public scope: 'task' | 'run' = 'task') { super(msg); this.name = 'BudgetExceededError'; }
}

/** The agent repeated the same failing actions; continuing would only burn tokens. */
export class NoProgressError extends Error {
  readonly category: ErrorCategory = 'no_progress';
  constructor(msg: string) { super(msg); this.name = 'NoProgressError'; }
}

export function errorCategory(e: unknown): ErrorCategory {
  if (e instanceof BudgetExceededError || e instanceof NoProgressError) return e.category;
  if (e instanceof NoModelError) return e.category;
  if (e instanceof ProviderError) return categoryOf(e.kind);
  if (e instanceof CancelledError) return 'internal';
  const msg = e instanceof Error ? e.message : String(e);
  if (/step limit|no files were written|no executable actions|no file changes/i.test(msg)) return 'no_progress';
  if (/timed out|timeout/i.test(msg)) return 'timeout';
  return 'internal';
}

/** Permanent failures: retrying the same operation cannot succeed without a change in inputs or configuration. */
export function isPermanent(category: ErrorCategory): boolean {
  return ['auth', 'invalid_request', 'budget', 'no_progress', 'no_provider'].includes(category);
}
