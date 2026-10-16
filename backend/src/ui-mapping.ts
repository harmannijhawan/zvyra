import type * as UI from '../../src/shared/contract/types';
import type { Run, Project, ApprovalRequest, AppNotification, SwarmEvent } from '../../SWARM/shared/types';
import type { Conversation, ChatTurn } from '../../SWARM/shared/chat';
import { runSnapshot } from '../../SWARM/electron/agents/orchestrator';
import { listApprovals } from '../../SWARM/electron/tools/approvals';
export const iso = (n: number) => new Date(n).toISOString();
export function task(run: Run): UI.Task {
  const snapshot = runSnapshot(run.id);
  const status: UI.TaskStatus = run.status === 'running' ? listApprovals().some(a => a.runId === run.id) ? 'waiting_permission' : run.progress?.phase === 'planning' ? 'planning' : run.progress?.phase === 'verifying' ? 'verifying' : 'running' : run.status === 'cancelled' && run.summary?.startsWith('Interrupted') ? 'interrupted' : run.status === 'completed' ? 'completed' : run.status === 'paused' ? 'paused' : run.status === 'cancelled' ? 'cancelled' : 'failed';
  return { id: run.id, title: run.objective.slice(0, 80), instruction: run.objective, status, source: 'home', projectId: run.projectId, createdAt: iso(run.startedAt), updatedAt: iso(run.endedAt ?? run.startedAt), startedAt: iso(run.startedAt), finishedAt: run.endedAt ? iso(run.endedAt) : undefined,
    plan: (snapshot?.tasks ?? []).map(t => ({ id: t.id, title: t.title, status: t.status === 'completed' ? 'done' : t.status === 'failed' ? 'failed' : ['running','verifying'].includes(t.status) ? 'running' : ['skipped','cancelled'].includes(t.status) ? 'skipped' : 'pending' })),
    currentAction: run.progress?.currentTask?.title, progress: run.stats.tasks ? { completed: run.stats.completed, total: run.stats.tasks } : undefined,
    summary: run.summary ?? undefined, error: run.progress?.lastError?.message, canPause: run.status === 'running', canResume: ['paused','cancelled','failed'].includes(run.status), canRetry: ['cancelled','failed'].includes(run.status) };
}
export function conversation(c: Conversation): UI.Conversation { return { id:c.id,title:c.title,createdAt:iso(c.turns[0]?.ts ?? c.updatedAt),updatedAt:iso(c.updatedAt),projectId:c.projectId,messageCount:c.turns.length,preview:c.turns.at(-1)?.text.slice(0,140) }; }
export function message(id: string, t: ChatTurn): UI.ChatMessage { return {id:t.id,conversationId:id,role:t.role,content:t.text,createdAt:iso(t.ts ?? Date.now()),status:t.status,error:t.error,model:t.model,taskId:t.runId}; }
export function project(p: Project): UI.Project { return {id:p.id,name:p.name,path:p.path,favorite:p.favorite,status:p.archived?'closed':'open',createdAt:iso(p.createdAt),lastOpenedAt:iso(p.lastOpenedAt),context:p.memory.summary || p.objective}; }
export function permission(a: ApprovalRequest): UI.PermissionRequest { return {id:a.id,taskId:a.runId ?? undefined,agentId:a.agent ?? undefined,category:a.kind==='computer'?'computer_input':a.kind==='command'||a.kind==='install'?'run_commands':'write_files',title:a.title,description:a.detail,risk:a.risk==='blocked'?'high':a.risk,createdAt:iso(a.ts)}; }
export function notification(n: AppNotification): UI.AppNotification { return {id:n.id,ts:iso(n.ts),title:n.title,body:n.body,priority:n.level==='error'?'high':'normal',category:n.kind==='complete'?'task_completed':n.kind==='fail'?'error':n.kind==='approval'||n.kind==='blocked'?'task_blocked':'custom',read:n.read,taskId:n.runId ?? undefined,delivered:{desktop:false,spoken:false,call:false}}; }
export function activity(e: SwarmEvent): UI.ActivityEntry { return {id:e.id,ts:iso(e.ts),type:e.type.toLowerCase().replaceAll('_','.'),title:e.message,level:e.level==='debug'?'info':e.level,taskId:e.runId ?? undefined,projectId:e.projectId ?? undefined}; }

