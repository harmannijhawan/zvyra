// Human-in-the-loop approvals. Agents await a decision; the renderer resolves it.
import type { ApprovalRequest } from '../../shared/types';
import { bus, emit } from '../core/bus';
import { notify } from '../core/notify';
import { CancelledError, uid } from '../core/util';

interface Pending { req: ApprovalRequest; resolve: (ok: boolean) => void }
const pending = new Map<string, Pending>();
const sessionAllow = new Set<string>(); // "always allow this session" keys

export function listApprovals(): ApprovalRequest[] { return [...pending.values()].map((p) => p.req); }

export function requestApproval(req: Omit<ApprovalRequest, 'id' | 'ts'>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  const key = `${req.projectId}:${req.runId}:${req.kind}:${req.detail}`;
  if (sessionAllow.has(key)) return Promise.resolve(true);
  const full: ApprovalRequest = { ...req, id: uid('ap_'), ts: Date.now() };
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = () => { pending.delete(full.id); bus.send('approvals:changed', listApprovals()); reject(new CancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(full.id, { req: full, resolve: (ok) => { signal?.removeEventListener('abort', onAbort); resolve(ok); } });
    emit('APPROVAL_REQUIRED', `Approval required: ${full.title}`, { projectId: full.projectId, runId: full.runId, agent: full.agent }, 'warning', { approvalId: full.id, kind: full.kind, detail: full.detail, risk: full.risk });
    notify('approval', 'warning', 'Approval required', full.title, { projectId: full.projectId, runId: full.runId });
    bus.send('approvals:changed', listApprovals());
  });
}

export function resolveApproval(id: string, approved: boolean, always = false) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  if (approved && always && p.req.kind !== 'computer') sessionAllow.add(`${p.req.projectId}:${p.req.runId}:${p.req.kind}:${p.req.detail}`);
  emit('APPROVAL_RESOLVED', `${approved ? 'Approved' : 'Denied'}: ${p.req.title}`, { projectId: p.req.projectId, runId: p.req.runId, agent: p.req.agent }, approved ? 'success' : 'warning', { approvalId: id, approved });
  p.resolve(approved);
  bus.send('approvals:changed', listApprovals());
  return true;
}

export function denyAllForRun(runId: string) {
  for (const key of sessionAllow) if (key.includes(`:${runId}:`)) sessionAllow.delete(key);
  for (const [id, p] of pending) if (p.req.runId === runId) resolveApproval(id, false);
}
