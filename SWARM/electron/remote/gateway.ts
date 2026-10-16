// Gateway: the ONLY bridge between the remote protocol and SWARM's existing main-process logic.
// It calls existing IPC handlers by name (through an injected `invoke`) and enforces a strict allow-list,
// per-channel argument sanitising, and the remote approval rules. No business logic is duplicated here.
import type { ApprovalRequest, Project, Run } from '../../shared/types';
import { HIGH_RISK_APPROVALS, REMOTE_CHANNEL_ALLOWLIST, REMOTE_CHANNEL_DENYLIST, type RemoteAgent } from './protocol';

export type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown> | unknown;

export class GatewayError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}

const MAX_TEXT = 8000;
const str = (v: unknown, name: string, max = 256): string => {
  if (typeof v !== 'string' || !v.length || v.length > max) throw new GatewayError(400, 'bad_request', `${name} must be a non-empty string`);
  return v;
};
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);

export function toRemoteAgent(p: Project, run: Run | undefined, waitingApproval: boolean): RemoteAgent {
  let status: RemoteAgent['status'] = 'idle';
  if (run) status = run.status === 'running' ? (waitingApproval ? 'waiting' : 'running') : run.status === 'paused' || run.status === 'attention' ? 'waiting' : 'running';
  else if (p.status === 'failed') status = 'error';
  else if (p.status === 'attention') status = 'waiting';
  return {
    id: p.id, name: p.name, status,
    task: run ? trunc(run.objective ?? '', 200) : null,
    updatedAt: new Date(run?.startedAt ?? p.updatedAt ?? Date.now()).toISOString(),
  };
}

export interface RemoteApproval { id: string; ts: number; runId: string | null; projectId: string | null; kind: string; title: string; detail: string; risk: unknown; needsConfirm: boolean }

export class Gateway {
  constructor(private invoke: Invoke, private info: { pcName: string; appVersion: string }) {}

  private async projects(): Promise<Project[]> { return ((await this.invoke('projects:list')) as Project[]) ?? []; }
  private async activeRuns(): Promise<Run[]> { return ((await this.invoke('runs:active')) as Run[]) ?? []; }
  private async rawApprovals(): Promise<ApprovalRequest[]> { return ((await this.invoke('approvals:list')) as ApprovalRequest[]) ?? []; }

  async listAgents(): Promise<RemoteAgent[]> {
    const [projects, runs, approvals] = await Promise.all([this.projects(), this.activeRuns(), this.rawApprovals()]);
    return projects.filter((p) => !p.archived).map((p) => {
      const run = runs.find((r) => r.projectId === p.id);
      return toRemoteAgent(p, run, !!run && approvals.some((a) => a.runId === run.id));
    });
  }

  private async find(id: string): Promise<{ project: Project; run: Run | undefined }> {
    str(id, 'agent id', 128);
    const [projects, runs] = await Promise.all([this.projects(), this.activeRuns()]);
    const project = projects.find((p) => p.id === id);
    if (!project) throw new GatewayError(404, 'agent_not_found');
    return { project, run: runs.find((r) => r.projectId === id) };
  }

  async getAgent(id: string): Promise<RemoteAgent> {
    const { project, run } = await this.find(id);
    const approvals = run ? await this.rawApprovals() : [];
    return toRemoteAgent(project, run, !!run && approvals.some((a) => a.runId === run.id));
  }

  async start(id: string): Promise<RemoteAgent> {
    const { project, run } = await this.find(id);
    if (run?.status === 'paused') await this.invoke('runs:resume', run.id);
    else if (run) throw new GatewayError(409, 'invalid_state', 'Already running');
    else {
      if (!project.objective?.trim()) throw new GatewayError(409, 'invalid_state', 'Project has no objective; send a task instead');
      await this.invoke('runs:start', project.id, project.objective, {});
    }
    return this.getAgent(id);
  }

  async stop(id: string): Promise<RemoteAgent> {
    const { run } = await this.find(id);
    if (!run) throw new GatewayError(409, 'invalid_state', 'Not running');
    await this.invoke('runs:cancel', run.id);
    const a = await this.getAgent(id);
    return { ...a, status: 'stopped' }; // the run is cancelled; the list endpoint settles to idle/stopped shortly after
  }

  async task(id: string, text: unknown): Promise<RemoteAgent> {
    const t = str(text, 'text', MAX_TEXT).trim();
    if (!t) throw new GatewayError(400, 'bad_request', 'text is empty');
    const { project, run } = await this.find(id);
    if (run) {
      // Guidance to the running manager. Generation can take long, so only surface early failures.
      const p = Promise.resolve(this.invoke('run:chat:send', { runId: run.id, text: t }));
      const early = await Promise.race([p.then(() => null, (e: unknown) => e), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      if (early) throw new GatewayError(409, 'invalid_state', early instanceof Error ? early.message : String(early));
      p.catch(() => undefined);
    } else {
      await this.invoke('runs:start', project.id, t, {});
    }
    return this.getAgent(id);
  }

  async status() {
    const agents = await this.listAgents();
    return {
      v: 1, pcName: this.info.pcName, appVersion: this.info.appVersion, time: new Date().toISOString(),
      agentCount: agents.length, runningCount: agents.filter((a) => a.status === 'running').length,
    };
  }

  async listApprovals(): Promise<RemoteApproval[]> {
    return (await this.rawApprovals()).map((a) => ({
      id: a.id, ts: a.ts, runId: a.runId, projectId: a.projectId, kind: a.kind, title: trunc(a.title, 200), detail: trunc(a.detail, 1000), risk: a.risk,
      needsConfirm: HIGH_RISK_APPROVALS.has(a.kind),
    }));
  }

  /** Remote approvals never set "always"; high-risk kinds need an explicit confirm flag when approving. */
  async resolveApproval(id: unknown, approved: unknown, confirm: unknown): Promise<{ ok: true }> {
    const aid = str(id, 'approval id', 128);
    if (typeof approved !== 'boolean') throw new GatewayError(400, 'bad_request', 'approved must be boolean');
    const a = (await this.rawApprovals()).find((x) => x.id === aid);
    if (!a) throw new GatewayError(404, 'approval_not_found');
    if (approved && HIGH_RISK_APPROVALS.has(a.kind) && confirm !== true) throw new GatewayError(428, 'confirm_required', `Approving "${a.kind}" requires confirm:true`);
    await this.invoke('approvals:resolve', aid, approved, false);
    return { ok: true };
  }

  /** Generic allow-listed passthrough to existing IPC handlers (WebSocket `invoke` command). */
  async invokeChannel(channel: unknown, args: unknown): Promise<unknown> {
    const ch = str(channel, 'channel', 64);
    if (REMOTE_CHANNEL_DENYLIST.has(ch) || !REMOTE_CHANNEL_ALLOWLIST.has(ch)) throw new GatewayError(403, 'forbidden_channel');
    const a = Array.isArray(args) ? args : args === undefined ? [] : null;
    if (!a || a.length > 4) throw new GatewayError(400, 'bad_request', 'args must be an array');
    switch (ch) {
      case 'projects:create': {
        const o = (a[0] ?? {}) as Record<string, unknown>;
        // Remote creation is confined to the configured workspace; never accept a filesystem path.
        return this.invoke(ch, { objective: str(o.objective, 'objective', MAX_TEXT) });
      }
      case 'chat:list': return this.invoke(ch);
      case 'chat:new': {
        const o = (a[0] ?? {}) as Record<string, unknown>;
        return this.invoke(ch, { ...(o.agentRole === undefined ? {} : { agentRole: str(o.agentRole, 'agentRole', 32) }), ...(o.runId === undefined ? {} : { runId: str(o.runId, 'runId', 128) }), ...(o.projectId === undefined ? {} : { projectId: str(o.projectId, 'projectId', 128) }) });
      }
      case 'workspace:snapshot': {
        const o = (a[0] ?? {}) as Record<string, unknown>;
        return this.invoke(ch, { ...(o.conversationId === undefined ? {} : { conversationId: str(o.conversationId, 'conversationId', 180) }), ...(o.runId === undefined ? {} : { runId: str(o.runId, 'runId', 128) }), ...(o.projectId === undefined ? {} : { projectId: str(o.projectId, 'projectId', 128) }), ...(typeof o.after === 'number' && Number.isFinite(o.after) ? { after: Math.max(0, Math.floor(o.after)) } : {}), limit: typeof o.limit === 'number' && Number.isFinite(o.limit) ? Math.max(1, Math.min(300, Math.floor(o.limit))) : 150 });
      }
      case 'workspace:file': return this.invoke(ch, str(a[0], 'changeId', 128));
      case 'chat:get': case 'chat:stop': case 'run:chat:stop': return this.invoke(ch, str(a[0], 'conversationId', 180));
      case 'run:chat:history': return this.invoke(ch, str(a[0], 'conversationId', 180), 100);
      case 'chat:send': {
        const o = (a[0] ?? {}) as Record<string, unknown>;
        const attachments = Array.isArray(o.attachments) ? o.attachments.slice(0, 5).map(value => {
          const file = value as Record<string, unknown>;
          return { name: str(file.name, 'attachment name', 200).replace(/^.*[\\/]/, ''), text: str(file.text, 'attachment text', 16000) };
        }) : undefined;
        if ((attachments?.reduce((total, file) => total + file.text.length, 0) ?? 0) > 40000) throw new GatewayError(400, 'bad_request', 'Attachments exceed the request limit');
        return this.invoke(ch, { id: str(o.id, 'conversationId', 128), text: str(o.text, 'text', MAX_TEXT), ...(attachments ? { attachments } : {}) });
      }
      case 'projects:list': return this.invoke(ch, { archived: false });
      case 'runs:active': return this.invoke(ch);
      case 'runs:list': return this.invoke(ch, a[0] === undefined ? undefined : str(a[0], 'projectId', 128));
      case 'runs:snapshot': case 'runs:cancel': case 'runs:pause': case 'runs:resume': return this.invoke(ch, str(a[0], 'runId', 128));
      case 'runs:events': {
        const o = (a[0] ?? {}) as Record<string, unknown>;
        const limit = typeof o.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(o.limit))) : 50;
        return this.invoke(ch, {
          runId: typeof o.runId === 'string' ? o.runId : undefined, projectId: typeof o.projectId === 'string' ? o.projectId : undefined,
          limit, before: typeof o.before === 'number' ? o.before : undefined, compact: true,
        });
      }
      case 'runs:start': {
        const o = (a[2] ?? {}) as Record<string, unknown>;
        return this.invoke(ch, str(a[0], 'projectId', 128), str(a[1], 'objective', MAX_TEXT), typeof o.webResearch === 'boolean' ? { webResearch: o.webResearch } : {});
      }
      case 'run:chat:send': {
        const o = (a[0] ?? {}) as Record<string, unknown>;
        return this.invoke(ch, { runId: str(o.runId, 'runId', 128), text: str(o.text, 'text', MAX_TEXT) });
      }
      case 'run:chat:agent:send': {
        const o = (a[0] ?? {}) as Record<string, unknown>;
        return this.invoke(ch, { runId: str(o.runId, 'runId', 128), agentRole: str(o.agentRole, 'agentRole', 32), text: str(o.text, 'text', MAX_TEXT) });
      }
      case 'approvals:list': return this.listApprovals();
      case 'approvals:resolve': return this.resolveApproval(a[0], a[1], (a[2] as Record<string, unknown> | undefined)?.confirm);
      default: throw new GatewayError(403, 'forbidden_channel');
    }
  }

  async snapshot() { return { agents: await this.listAgents(), approvals: await this.listApprovals() }; }
}
