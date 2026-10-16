import type { Action } from '../agents/protocol';

/** Retry failed operations only after a successful state-changing tool. */
export class ToolRetryGuard {
  private errors = new Map<string, string>();
  private key(action: Action, projectId?: string) {
    if (!projectId && ['run', 'read', 'list', 'write', 'edit'].includes(action.type)) return 'missing-project';
    if (action.type === 'computer' || action.type === 'swarm') {
      try { const data = JSON.parse(action.json); delete data.intent; delete data.risk; return JSON.stringify({ type: action.type, projectId, data }); } catch { /* execution validates malformed input */ }
    }
    return JSON.stringify({ action, projectId });
  }
  blocked(action: Action, projectId?: string) {
    const error = this.errors.get(this.key(action, projectId));
    return error ? `This operation already failed and nothing has changed: ${error}. Do not retry it. Explain the limitation using the available evidence.` : undefined;
  }
  failed(action: Action, projectId: string | undefined, error: string) { this.errors.set(this.key(action, projectId), error); }
  changed() { this.errors.clear(); }
}
