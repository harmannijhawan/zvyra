import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { z } from 'zod';
import { schemas, Preferences, type Operation, type Input, type Result } from './contract';
import { Store, type Memory, type Automation } from './store';
import { VoiceService } from './voice';
import { db } from '../../SWARM/electron/core/db';
import { getSettings, updateSettings } from '../../SWARM/electron/core/settings';
import { setSecret } from '../../SWARM/electron/core/secrets';
import { errMsg, redact } from '../../SWARM/electron/core/util';
import { listChats, getChat, newChat, sendChat, stopChat, renameChat, deleteChat } from '../../SWARM/electron/chat/service';
import { startRun, pauseRun, resumeRun, cancelRun, runSnapshot, listActiveRuns } from '../../SWARM/electron/agents/orchestrator';
import { listProjects, getProject, createProject, listRuns } from '../../SWARM/electron/projects/projects';
import { listModels, listProviders, discoverProvider, probeModel, adapter, providerConfig, refreshProviderInfo, BYOK_PROVIDER_IDS } from '../../SWARM/electron/providers/registry';
import { testConnection } from '../../SWARM/electron/providers/connection';
import { listApprovals, resolveApproval, requestApproval } from '../../SWARM/electron/tools/approvals';
import { pcControl } from '../../SWARM/electron/computer/service';
import { queryEvents } from '../../SWARM/electron/core/bus';
import { ROLES } from '../../SWARM/electron/agents/roles';
import { listNotifications, markNotificationsRead } from '../../SWARM/electron/core/notify';

export class BackendService {
  readonly store = new Store();
  readonly voice: VoiceService;
  private operations = new Map<string, AbortController>();
  private voiceConversation: string | null = null;
  constructor(script: string, private publish: (topic: string, payload: unknown) => void) {
    this.voice = new VoiceService(script, publish, text => {
      try {
        this.voiceConversation ??= newChat().id;
        const routing = JSON.parse(db().kvGet('zvyra.ui.routingRoles') ?? '{}');
        sendChat({ id: this.voiceConversation, text, model: routing.voice ?? undefined });
      } catch (e) { publish('voice.error', { message: errMsg(e) }); }
    });
  }
  preferences() { return Preferences.parse(JSON.parse(db().kvGet('zvyra.preferences') ?? '{}')); }
  quiet(now = new Date()) { const p = this.preferences(); const h = now.getHours(); return p.doNotDisturb || p.quietHours && (p.quietStart === p.quietEnd || (p.quietStart < p.quietEnd ? h >= p.quietStart && h < p.quietEnd : h >= p.quietStart || h < p.quietEnd)); }
  private model(id?: string | null) { if (id && !listModels().some(m => m.id === id)) throw new Error('Unknown model ID. Discover models first.'); }
  private project(id: string) { const p = getProject(id); if (!p) throw new Error('Project not found'); return p; }
  private run(id: string) { const r = runSnapshot(id); if (!r) throw new Error('Task not found'); return r; }
  readonly handlers = {
    'status.get': () => ({ version: 1, running: true, backgroundTasks: listActiveRuns().length, providers: listProviders(), voice: this.voice.snapshot(), telephony: { available: false, reason: 'No telephony provider configured' }, database: 'ready', computer: { enabled: getSettings().computer.native, platform: process.platform } }),
    'conversation.list': () => listChats(), 'conversation.get': (p: { id: string }) => getChat(p.id),
    'conversation.create': (p: { projectId?: string }) => { if (p.projectId) this.project(p.projectId); return newChat(p); },
    'conversation.rename': (p: { id: string; title: string }) => renameChat(p.id, p.title),
    'conversation.delete': (p: { id: string }) => deleteChat(p.id), 'conversation.cancel': (p: { id: string }) => stopChat(p.id),
    'conversation.send': (p: { id: string; text: string; model?: string }) => { this.model(p.model); return sendChat(p); },
    'task.list': (p: { projectId?: string }) => listRuns(p.projectId), 'task.get': (p: { id: string }) => this.run(p.id),
    'task.create': (p: { projectId: string; instruction: string; model?: string }) => { this.model(p.model); return startRun(p.projectId, p.instruction, { pinnedModel: p.model, autonomy: 'manual' }); },
    'task.pause': (p: { id: string }) => pauseRun(p.id), 'task.resume': (p: { id: string }) => resumeRun(p.id), 'task.cancel': (p: { id: string }) => cancelRun(p.id),
    'task.retry': (p: { id: string }) => { const { run } = this.run(p.id); if (!['failed', 'cancelled'].includes(run.status)) throw new Error('Retry requires a failed or cancelled task'); return startRun(run.projectId, run.objective, { ...run.options, autonomy: 'manual' }); },
    'task.logs': (p: { id: string; limit: number }) => { this.run(p.id); return queryEvents({ runId: p.id, limit: p.limit }); },
    'agents.list': () => ({ roles: ROLES, assignments: listActiveRuns().map(r => runSnapshot(r.id)) }),
    'routing.get': () => { const s = getSettings(); return { ai: s.ai, routing: s.routing, modelPreference: s.agents.modelPreference }; },
    'routing.models': () => ({ models: listModels(), providers: listProviders() }),
    'routing.discover': async (p: { provider?: typeof BYOK_PROVIDER_IDS[number] }) => { for (const id of p.provider ? [p.provider] : BYOK_PROVIDER_IDS) await discoverProvider(id, AbortSignal.timeout(30000)); return this.handlers['routing.models'](); },
    'routing.test': (p: { provider: string }) => testConnection(adapter(p.provider)!, providerConfig(p.provider), AbortSignal.timeout(30000)),
    'routing.probe': (p: { id: string }) => { this.model(p.id); return probeModel(p.id, AbortSignal.timeout(30000)); },
    'routing.configure': (p: z.infer<typeof schemas['routing.configure']>) => { this.model(p.ai?.pinnedModel); for (const id of p.routing?.fallbacks ?? []) this.model(id); for (const id of Object.values(p.modelPreference ?? {})) this.model(id); updateSettings({ ...(p.ai ? { ai: p.ai } : {}), ...(p.routing ? { routing: p.routing } : {}), ...(p.modelPreference ? { agents: { modelPreference: p.modelPreference } } : {}) }); return this.handlers['routing.get'](); },
    'routing.credential': (p: { provider: string; key: string | null }) => { setSecret(p.provider, p.key); if (!p.key) { const disabled = JSON.parse(db().kvGet('account.disabledProviders') ?? '[]') as string[]; db().kvSet('account.disabledProviders',JSON.stringify([...new Set([...disabled,p.provider])])); } refreshProviderInfo(p.provider); return { saved: !!p.key }; },
    'computer.status': () => ({ enabled: getSettings().computer.native, available: process.platform === 'win32' || process.platform === 'darwin', hardwareVerified: false, actions: ['screenshot', 'move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'wait', 'focus_window', 'open_application'], controlling: pcControl.controlling }),
    'computer.permission': async (p: { enabled: boolean }) => { updateSettings({ computer: { native: p.enabled } }); if (!p.enabled) { for (const c of this.operations.values()) c.abort(); await pcControl.releaseInput(); } return this.handlers['computer.status'](); },
    'computer.execute': async (p: z.infer<typeof schemas['computer.execute']>) => {
      if (!getSettings().computer.native) throw new Error('Computer permission is disabled');
      if (this.operations.has(p.id)) throw new Error('Operation ID is already running');
      const ctrl = new AbortController(); this.operations.set(p.id, ctrl); const timeout = setTimeout(() => ctrl.abort(), 120000);
      try {
        return await pcControl.execute(p.action, { runId: 'zvyra-direct', agent: 'manager' }, ctrl.signal);
      } finally { clearTimeout(timeout); this.operations.delete(p.id); }
    },
    'computer.cancel': (p: { id: string }) => { const c = this.operations.get(p.id); c?.abort(); return !!c; },
    'approval.list': () => listApprovals(), 'approval.resolve': (p: { id: string; approved: boolean }) => resolveApproval(p.id, p.approved, false),
    'project.list': () => listProjects(), 'project.get': (p: { id: string }) => this.project(p.id), 'project.create': (p: { name: string; objective?: string }) => createProject(p),
    'memory.search': (p: { query: string; projectId?: string }) => this.preferences().memoryEnabled ? this.store.list<Memory>('memory').filter(m => (!p.projectId || m.projectId === p.projectId) && m.text.toLowerCase().includes(p.query.toLowerCase())) : [],
    'memory.save': (p: { id?: string; text: string; projectId?: string }) => { if (!this.preferences().memoryEnabled) throw new Error('Saved memory is disabled'); if (p.projectId) this.project(p.projectId); const m = this.store.memory(p); this.publish('memory.changed', { id: m.id }); return m; },
    'memory.delete': (p: { id: string }) => this.store.remove('memory', p.id), 'memory.clear': () => this.store.clear('memory'),
    'preferences.get': () => this.preferences(),
    'preferences.update': (p: z.input<typeof Preferences>) => { const next = Preferences.parse({ ...this.preferences(), ...p }); if (next.startAtLogin !== this.preferences().startAtLogin) app.setLoginItemSettings({ openAtLogin: next.startAtLogin }); db().kvSet('zvyra.preferences', JSON.stringify(next)); this.publish('preferences.changed', next); return next; },
    'privacy.get': () => getSettings().privacy, 'privacy.update': (p: unknown) => updateSettings({ privacy: p }).privacy,
    'notifications.list': () => listNotifications(), 'notifications.read': () => { markNotificationsRead(); return true; },
    'voice.get': () => this.voice.snapshot(), 'voice.configure': (p: unknown) => this.voice.configure(p),
    'voice.start': () => this.voice.listen(), 'voice.stop': () => this.voice.stop(), 'voice.finish': () => this.voice.finish(), 'voice.speak': (p: { text: string }) => this.voice.speak(p.text), 'voice.stopPlayback': () => this.voice.stopPlayback(),
    'automation.list': () => this.store.list<Automation>('automation'),
    'automation.create': (p: { projectId: string; instruction: string; at: number }) => { this.project(p.projectId); if (p.at <= Date.now()) throw new Error('Schedule time must be in the future'); return this.store.put<Automation>('automation', { ...p, id: randomUUID(), state: 'scheduled' }); },
    'automation.cancel': (p: { id: string }) => { const item = this.store.list<Automation>('automation').find(a => a.id === p.id); if (!item || item.state !== 'scheduled') return false; this.store.put('automation', { ...item, state: 'cancelled' }); return true; },
  };
  async invoke<K extends Operation>(operation: K, input: Input<K>): Promise<Result<unknown>> {
    try {
      if (!Object.hasOwn(schemas, operation)) return { ok: false, error: { code: 'UNKNOWN_OPERATION', message: 'Unknown operation', retryable: false } };
      const parsed = schemas[operation].parse(input);
      const handler = this.handlers[operation] as (input: unknown) => unknown;
      return { ok: true, data: await handler(parsed) };
    } catch (e) {
      const code = e instanceof z.ZodError ? 'INVALID_INPUT' : typeof (e as { category?: string })?.category === 'string' ? (e as { category: string }).category : 'OPERATION_FAILED';
      return { ok: false, error: { code, message: e instanceof z.ZodError ? 'Request does not match the operation schema' : redact(errMsg(e)), retryable: ['timeout','network','rate_limit','server'].includes(code) } };
    }
  }
  tick(now = Date.now()) {
    for (const item of this.store.list<Automation>('automation')) {
      if (item.state !== 'scheduled' || item.at > now) continue;
      // Claim durably before dispatch. Crash in this gap requires review, never blind replay.
      this.store.put('automation', { ...item, state: 'dispatching' });
      let result: Automation;
      try { const run = startRun(item.projectId, item.instruction, { autonomy: 'manual' }); result = { ...item, state: 'started', runId: run.id }; }
      catch (e) { result = { ...item, state: 'failed', error: errMsg(e) }; }
      this.store.put('automation', result); this.publish('automation.changed', result);
    }
  }
  onChat(payload: any) {
    if (payload?.conversationId === this.voiceConversation && payload.turn?.role === 'assistant' && payload.turn.status === 'complete' && this.voice.settings.speakReplies && !this.quiet()) this.voice.speak(payload.turn.text);
  }
  close() { this.voice.stop(); for (const c of this.operations.values()) c.abort(); }
}
