// The public workspace journal is a safe projection of the existing authoritative
// bus. It never forwards model token/thinking streams or raw tool internals.
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import type { Conversation, ChatTurn } from '../../shared/chat';
import type { AgentState, FileChange, Run, SwarmEvent, Task } from '../../shared/types';
import type { WorkspaceEvent, WorkspaceEventType, WorkspaceFilePreview, WorkspaceQuery, WorkspaceSnapshot } from '../../shared/workspace';
import { bus } from '../core/bus';
import { db } from '../core/db';
import { redact, uid } from '../core/util';
import { ROLES } from '../agents/roles';
import { listApprovals } from '../tools/approvals';

const querySchema = z.object({ conversationId: z.string().max(180).optional(), runId: z.string().max(128).optional(), projectId: z.string().max(128).optional(), after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional() });
const mappings: Record<string, WorkspaceEventType> = {
  AGENT_STARTED: 'agent_started', AGENT_STATUS: 'agent_status', AGENT_MESSAGE: 'agent_message',
  TASK_CREATED: 'task_progress', TASK_STARTED: 'task_started', TASK_UPDATED: 'task_progress', TASK_COMPLETED: 'task_completed', TASK_FAILED: 'task_failed', TASK_STALLED: 'task_failed',
  FILE_CREATED: 'file_created', FILE_MODIFIED: 'file_modified', FILE_DELETED: 'file_deleted', FILE_RENAMED: 'file_modified', FILE_REVERTED: 'file_modified',
  COMMAND_STARTED: 'command_started', COMMAND_COMPLETED: 'command_finished', COMMAND_DENIED: 'command_finished',
  WEB_SEARCH: 'search_finished', SEARCH_STARTED: 'search_started', SEARCH_FINISHED: 'search_finished',
  TOOL_STARTED: 'tool_started', TOOL_FINISHED: 'tool_finished', COMPUTER_STARTED: 'computer_started', COMPUTER_ACTION: 'computer_action', COMPUTER_OBSERVATION: 'computer_observation', SCREENSHOT_CAPTURED: 'computer_observation',
  TEST_STARTED: 'task_progress', TEST_PASSED: 'task_progress', TEST_FAILED: 'task_progress', TEST_SKIPPED: 'task_progress',
  APPROVAL_REQUIRED: 'approval_required', APPROVAL_RESOLVED: 'approval_resolved',
  RUN_STARTED: 'run_started', RUN_COMPLETED: 'run_completed', RUN_FAILED: 'run_failed', RUN_PAUSED: 'run_paused', RUN_RESUMED: 'run_resumed', RUN_CANCELLED: 'run_stopped', NOTIFICATION: 'notification',
};
let installed = false;
let associationDb: ReturnType<typeof db> | null = null;
const associations = new Map<string, Set<string>>();
const safe = (text: unknown, limit = 1200) => redact(String(text ?? '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').replace(/```(?:decision|escalate)[\s\S]*?(?:```|$)/gi, '')).slice(0, limit);

function publicData(e: SwarmEvent): Record<string, unknown> {
  const d = e.data ?? {}; const out: Record<string, unknown> = { sourceType: e.type };
  for (const key of ['changeId', 'path', 'kind', 'additions', 'deletions', 'commandId', 'exitCode', 'durationMs', 'status', 'approvalId', 'approved', 'risk', 'query', 'count', 'engine', 'action', 'tool', 'activityId', 'width', 'height', 'windowCount', 'conversationId', 'gate']) {
    const value = d[key]; if (typeof value === 'string') out[key] = safe(value); else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  if (e.type === 'AGENT_STATUS' && d.agent) {
    const a = d.agent as AgentState;
    out.agent = { role: a.role, status: a.status, taskId: a.taskId, taskTitle: safe(a.taskTitle), lastAction: safe(a.lastAction), tasksDone: a.tasksDone, errors: a.errors, tokens: a.tokens, filesTouched: a.filesTouched, updatedAt: a.updatedAt, modelId: a.modelId };
  }
  if (e.type.startsWith('TASK_') && d.task) {
    const t = d.task as Task;
    out.task = { id: t.id, title: safe(t.title), role: t.role, kind: t.kind, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, filesTouched: t.filesTouched, error: safe(t.error) };
  }
  if (e.type.startsWith('COMMAND_') && typeof d.commandId === 'string') {
    const cmd = db().get<import('../../shared/types').CommandExecution>('commands', d.commandId);
    if (cmd) { out.command = safe(cmd.command); out.output = safe(cmd.output, 12000); out.status = cmd.status; }
  }
  return out;
}

function linkedConversations(runId?: string): Conversation[] {
  if (!runId) return [];
  if (associationDb !== db()) {
    associationDb = db(); associations.clear();
    for (const c of db().list<Conversation>('conversations')) registerWorkspaceConversation(c);
  }
  return [...associations.get(runId) ?? []].map(id => db().get<Conversation>('conversations', id)).filter((c): c is Conversation => !!c && c.runId === runId);
}

export function registerWorkspaceConversation(c: Conversation) {
  if (!c.runId) return;
  const ids = associations.get(c.runId) ?? new Set<string>(); ids.add(c.id); associations.set(c.runId, ids);
}

function journal(value: Omit<WorkspaceEvent, 'sequence'>) {
  const sequence = Number(db().prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM workspace_events').get()?.n ?? 0) + 1;
  const event: WorkspaceEvent = { ...value, sequence };
  db().put('workspace_events', event.id, event, { sequence, conversation_id: event.conversationId ?? null, run_id: event.runId ?? null, project_id: event.projectId ?? null, ts: event.ts });
  bus.send('workspace:event', event);
  return event;
}

function narrative(e: WorkspaceEvent, source?: SwarmEvent) {
  let text = '';
  const task = source?.data?.task as Task | undefined;
  const name = e.agent ? ROLES[e.agent]?.name ?? e.agent : 'SWARM';
  if (e.type === 'task_started' && task) text = `${name} is working on ${safe(task.title, 180)}.`;
  if (e.type === 'task_completed' && task) text = `${name} finished ${safe(task.title, 180)}.`;
  if (e.type === 'task_failed' && task) text = `${name} needs attention on ${safe(task.title, 180)}${task.error ? `: ${safe(task.error, 220)}` : '.'}`;
  if (['run_completed', 'run_failed', 'run_stopped', 'run_paused', 'run_resumed', 'approval_required'].includes(e.type)) text = safe(e.message, 500);
  if (source?.type === 'TEST_PASSED' || source?.type === 'TEST_FAILED') text = safe(source.message, 300);
  if (!text) return;
  for (const c of linkedConversations(e.runId)) {
    if (c.agentRole && c.agentRole !== e.agent && !e.type.startsWith('run_')) continue;
    if (c.turns.some(t => t.eventId === e.id)) continue;
    const turn: ChatTurn = { id: uid('msg_'), ts: e.ts, role: 'assistant', agent: c.agentRole ?? 'manager', taskId: e.taskId, eventId: e.id, runId: e.runId, text, status: e.type === 'task_failed' || e.type === 'run_failed' ? 'error' : 'complete' };
    c.turns.push(turn); c.updatedAt = Date.now();
    db().put('conversations', c.id, c, { updated_at: c.updatedAt });
    bus.send('chat:turn', { conversationId: c.id, turn, runId: c.runId, projectId: c.projectId });
    bus.send('chat:updated', c);
  }
}

export function initializeWorkspace() {
  if (installed) return; installed = true;
  bus.on('event', (source: SwarmEvent) => {
    const type = mappings[source.type];
    if (!type) return;
    if (source.type === 'RUN_STARTED' && source.projectId && source.runId) {
      for (const c of db().list<Conversation>('conversations').filter(c => c.projectId === source.projectId && !c.runId)) {
        c.runId = source.runId; db().put('conversations', c.id, c, { updated_at: Date.now() }); registerWorkspaceConversation(c);
      }
    }
    const conversationId = typeof source.data?.conversationId === 'string' ? source.data.conversationId : linkedConversations(source.runId ?? undefined).find(c => !c.agentRole)?.id;
    const event = journal({ id: source.id, ts: source.ts, type, message: safe(source.message), conversationId, runId: source.runId ?? undefined, projectId: source.projectId ?? undefined, taskId: source.taskId ?? undefined, agent: source.agent ?? undefined, status: type === 'approval_required' ? 'approval' : source.level === 'error' || source.data?.status === 'failed' || source.data?.status === 'error' ? 'error' : source.data?.status === 'complete' || source.data?.status === 'completed' || source.data?.status === 'exited' ? 'complete' : /(?:started|action)$/.test(type) ? 'running' : 'complete', data: publicData(source) });
    narrative(event, source);
  });
  bus.on('chat:turn', (payload: { conversationId: string; turn: ChatTurn; runId?: string; projectId?: string }) => {
    const { turn } = payload;
    // Token deltas remain on chat:turn. The replay journal stores complete turns
    // and safe coordinator progress, not hundreds of partial copies.
    if (turn.status === 'streaming') return;
    journal({ id: `turn:${turn.id}`, ts: Date.now(), type: turn.role === 'user' ? 'message' : turn.agent && turn.agent !== 'manager' ? 'agent_message' : 'assistant_message', conversationId: payload.conversationId, runId: payload.runId, projectId: payload.projectId, agent: turn.agent, taskId: turn.taskId, message: safe(turn.text, 12000), status: turn.status === 'error' ? 'error' : turn.status === 'stopped' ? 'stopped' : 'complete', data: { turnId: turn.id, role: turn.role, eventId: turn.eventId } });
  });
}

export async function workspaceSnapshot(raw: WorkspaceQuery = {}): Promise<WorkspaceSnapshot> {
  initializeWorkspace();
  const q = querySchema.parse(raw);
  const c = q.conversationId ? db().get<Conversation>('conversations', q.conversationId) : null;
  if (q.conversationId && !c) throw new Error('Conversation not found');
  const runId = q.runId ?? c?.runId, projectId = q.projectId ?? c?.projectId;
  const where: string[] = []; const values: (string | number)[] = [];
  if (q.conversationId && runId) { where.push('(conversation_id = ? OR run_id = ?)'); values.push(q.conversationId, runId); }
  else if (q.conversationId) { where.push('(conversation_id = ? OR run_id = ?)'); values.push(q.conversationId, q.conversationId); }
  else if (runId) { where.push('run_id = ?'); values.push(runId); }
  else if (projectId) { where.push('project_id = ?'); values.push(projectId); }
  if (q.after !== undefined) { where.push('sequence > ?'); values.push(q.after); }
  const limit = q.limit ?? 300;
  const rows = db().list<WorkspaceEvent>('workspace_events', where.join(' AND '), values, q.after === undefined ? 'sequence DESC' : 'sequence ASC', limit + 1);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit); if (q.after === undefined) events.reverse();
  let agents: AgentState[] = [], run: Run | undefined;
  if (runId && db().get<Run>('runs', runId)) {
    const { runSnapshot } = await import('../agents/orchestrator');
    const snapshot = runSnapshot(runId); run = snapshot?.run; agents = snapshot?.agents ?? [];
  }
  const files = projectId ? db().list<FileChange>('file_changes', runId ? 'project_id = ? AND run_id = ?' : 'project_id = ?', runId ? [projectId, runId] : [projectId], 'ts DESC', 500).map(({ before: _before, after: _after, ...file }) => file) : [];
  const approvals = listApprovals().filter(a => runId ? a.runId === runId || a.runId === q.conversationId : q.conversationId ? a.runId === q.conversationId : projectId ? a.projectId === projectId : true);
  return { events, cursor: events.at(-1)?.sequence ?? q.after ?? 0, hasMore, agents, run, files, approvals, conversationId: q.conversationId, runId, projectId };
}

export function workspaceFile(changeId: string): WorkspaceFilePreview {
  const change = db().get<FileChange>('file_changes', z.string().min(1).max(128).parse(changeId));
  if (!change) throw new Error('File change not found');
  if (/(^|[\\/])(?:\.env(?:\.(?!example|sample)[^/]+)?|\.ssh|credentials|[^/]+\.(?:pem|key|pfx))$/i.test(change.path)) throw new Error('Sensitive file contents are withheld');
  const before = change.before === null ? null : redact(change.before), after = change.after === null ? null : redact(change.after);
  const limit = 64000;
  const diff = createTwoFilesPatch(change.renamedFrom ?? change.path, change.path, before ?? '', after ?? '', 'before', 'after');
  return { ...change, before: before?.slice(0, limit) ?? null, after: after?.slice(0, limit) ?? null, diff: diff.slice(0, limit), truncated: diff.length > limit || (before?.length ?? 0) > limit || (after?.length ?? 0) > limit || change.kind === 'modified' && (before === null || after === null) };
}
