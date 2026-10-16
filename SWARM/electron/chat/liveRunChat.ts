// Live Run Chat — conversational control plane for active builds.
// Routes user messages to the active Manager (run-level) or directly to individual agents.
// Runs concurrently with the execution engine — never blocks execution.
import type {
  AgentRole, RunChatTurn, RunChatInput, AgentChatInput, LiveRunSnapshot,
  LiveMessageClassification, AgentChatClassification, RunChatEvent, GraphVersion,
} from '../../shared/types';
import { db } from '../core/db';
import { bus, emit } from '../core/bus';
import { uid, errMsg } from '../core/util';
import { getSettings } from '../core/settings';
import { complete } from '../router/router';
import { activeRun, cancelRun, pauseRun, resumeRun, controlAgent } from '../agents/orchestrator';
import { publicChatText } from './tools';
import { ROLES } from '../agents/roles';

// ─── in-process streaming controllers ────────────────────────────────────────
const active = new Map<string, AbortController>();

// ─── graph version counter ────────────────────────────────────────────────────
const graphVersions = new Map<string, number>();

function nextGraphVersion(runId: string): number {
  const v = currentGraphVersion(runId) + 1;
  graphVersions.set(runId, v);
  return v;
}

export function currentGraphVersion(runId: string): number {
  const saved = db().list<GraphVersion>('graph_versions', 'run_id = ?', [runId], 'ts DESC', 1)[0]?.version ?? 0;
  return Math.max(graphVersions.get(runId) ?? 0, saved);
}

// ─── persistence helpers ──────────────────────────────────────────────────────
function saveTurn(turn: RunChatTurn): void {
  db().put('run_chat_turns', turn.id, turn, {
    run_id: turn.runId,
    conversation_id: turn.conversationId,
    ts: turn.ts,
  });
}

function loadTurns(conversationId: string, limit = 200): RunChatTurn[] {
  return db().list<RunChatTurn>('run_chat_turns', 'conversation_id = ?', [conversationId], 'ts DESC, rowid DESC', limit).reverse();
}

function saveGraphVersion(gv: GraphVersion): void {
  db().put('graph_versions', `${gv.runId}:v${gv.version}`, gv, { run_id: gv.runId, ts: gv.ts });
}

// ─── conversation ID helpers ─────────────────────────────────────────────────
export const managerConversationId = (runId: string) => `${runId}:manager`;
export const agentConversationId = (runId: string, role: AgentRole) => `${runId}:${role}`;

// ─── live snapshot ────────────────────────────────────────────────────────────
function buildLiveSnapshot(runId: string): LiveRunSnapshot {
  const ctx = activeRun(runId);
  if (!ctx) {
    // Run not in memory — try from DB
    const run = db().get<import('../../shared/types').Run>('runs', runId);
    if (!run) throw new Error('Run not found');
    return {
      runId, projectId: run.projectId, objective: run.objective,
      target: run.target ?? null, phase: run.status,
      currentTaskTitle: null, completedCount: run.stats.completed,
      activeCount: 0, blockedCount: 0, totalCount: run.stats.tasks,
      failedCount: run.stats.failed, recentDecisions: [],
      architectureSummary: '', designSummary: '',
      activeAgents: [], recentUserInstructions: [],
      graphVersion: currentGraphVersion(runId),
    };
  }

  const tasks = [...ctx.tasks.values()];
  const agents = [...ctx.agents.values()];
  const runningTask = tasks.find(t => t.status === 'running');

  // recent user instructions from manager conversation
  const managerTurns = loadTurns(managerConversationId(runId), 20);
  const recentUserInstructions = managerTurns
    .filter(t => t.senderType === 'user')
    .slice(-4)
    .map(t => t.text.slice(0, 200));

  // recent decisions from project memory
  const project = ctx.project;
  const recentDecisions = (project.memory.decisions ?? []).slice(-5).map(d => d.text.slice(0, 160));

  return {
    runId,
    projectId: ctx.run.projectId,
    objective: ctx.run.objective,
    target: ctx.run.target ?? null,
    phase: ctx.run.status,
    currentTaskTitle: runningTask?.title ?? null,
    completedCount: tasks.filter(t => t.status === 'completed').length,
    activeCount: tasks.filter(t => t.status === 'running').length,
    blockedCount: tasks.filter(t => t.status === 'blocked').length,
    totalCount: tasks.length,
    failedCount: tasks.filter(t => t.status === 'failed').length,
    recentDecisions,
    architectureSummary: ctx.architecture ? `${ctx.architecture.stack}. ${ctx.architecture.summary}`.slice(0, 400) : '',
    designSummary: (ctx.design ?? '').split('\n').slice(0, 5).join(' ').slice(0, 300),
    activeAgents: agents
      .filter(a => a.status === 'working' || a.status === 'planning' || a.status === 'waiting')
      .map(a => ({ role: a.role, status: a.status, taskTitle: a.taskTitle })),
    recentUserInstructions,
    graphVersion: currentGraphVersion(runId),
  };
}

// ─── classification (pure, zero-model) ───────────────────────────────────────
function classifyRunMessage(text: string): LiveMessageClassification {
  const t = text.toLowerCase().trim();
  if (/^(stop|cancel)\b/.test(t)) return 'STOP';
  if (/^pause\b/.test(t)) return 'PAUSE';
  if (/^(resume|continue)\b/.test(t)) return 'RESUME';
  if (/\b(what|how|why|when|status|progress|happening|going|working on|doing)\b/.test(t) && t.length < 120) return 'STATUS';
  if (/\bsqlite|postgresql|mysql|mongo|supabase|firebase|redis|database\b/i.test(text)) return 'ARCHITECTURE_CHANGE';
  if (/\b(android|ios|windows|macos|linux|web|browser)\b.*\b(app|application|instead)\b/i.test(text)) return 'TARGET_CHANGE';
  if (/\b(color|colour|font|spacing|radius|dark mode|light mode|theme|minimal|layout|ui|ux|design|style|look)\b/i.test(text)) return 'DESIGN_CHANGE';
  if (/\b(remove|delete|skip|don.t|no longer|without)\b.*\b(page|section|feature|component|gallery|route)\b/i.test(text)) return 'TASK_UPDATE';
  if (/\b(add|include|implement|build|create)\b.*\b(auth|login|page|feature|component|section)\b/i.test(text)) return 'TASK_UPDATE';
  if (/\b(focus|prioritize|do first|work on first)\b/i.test(text)) return 'PRIORITY_CHANGE';
  if (/\b(change|use|switch|replace)\b/i.test(text)) return 'PLAN_CHANGE';
  if (/^(?:please\s+)?(?:fix|make|update|implement|test|add|remove)\b/i.test(text)) return 'TASK_UPDATE';
  return 'CLARIFICATION';
}

export function classifyAgentMessage(text: string): AgentChatClassification {
  const t = text.toLowerCase().trim();
  if (/^(stop|cancel)\b/.test(t)) return 'STOP';
  if (/^pause\b/.test(t)) return 'PAUSE';
  if (/\b(what|how|why|status|progress|doing|working|explain)\b/.test(t) && t.length < 120) return 'STATUS_REQUEST';
  if (/\b(change|switch|replace|use|add|remove)\b.*\b(database|architecture|stack|platform|framework)\b/i.test(text)) return 'ARCHITECTURE_CHANGE';
  if (/\b(change|update|redesign|make|use)\b.*\b(design|layout|color|font|ui|ux|style)\b/i.test(text)) return 'DESIGN_CHANGE';
  if (/\b(fix|change|update|add|remove)\b.*\b(code|function|file|component|bug|error)\b/i.test(text)) return 'CODE_CHANGE';
  if (/\b(fix|change)\b.*\b(requirement|feature|entire|whole|all)\b/i.test(text)) return 'PROJECT_CHANGE';
  if (/^(?:please\s+)?(?:fix|change|update|add|remove|make|test|check|inspect|run|implement|build|open|go|look|research)\b/i.test(text)) return 'CODE_CHANGE';
  return 'QUESTION';
}

/** Delivery is independent of model generation: a direct instruction always
 * reaches the real role inbox and schedules executable work when appropriate. */
export function deliverAgentInstruction(runId: string, role: AgentRole, text: string): { text: string; taskId?: string } | null {
  if (!Object.hasOwn(ROLES, role)) throw new Error('Unknown agent role');
  const ctx = activeRun(runId);
  if (!ctx) return null;
  const classification = classifyAgentMessage(text);
  if (classification === 'STATUS_REQUEST') return null;
  if (classification === 'STOP' || classification === 'PAUSE') {
    controlAgent(runId, role, 'stop');
    return { text: 'I have stopped my assigned work. Say continue when you want me to resume.' };
  }
  if (/^(?:continue|resume)\b/i.test(text.trim())) {
    controlAgent(runId, role, 'resume');
    return { text: 'I am continuing my assigned work.' };
  }
  ctx.message('manager', role, `[DIRECT USER MESSAGE] ${text}`, null, classification === 'QUESTION' ? 'REQUEST' : 'REQUIREMENT_CHANGE', { source: 'user' });
  if (classification === 'QUESTION') return null;
  const barrier = [...ctx.tasks.values()].filter(t => t.status === 'running' && ['code', 'repair', 'optimize', 'agent_request'].includes(t.kind)).map(t => t.id);
  const task = ctx.addTask({ key: ctx.newTaskKey('agent_request'), role, kind: 'agent_request', title: text.slice(0, 100), description: text, deps: barrier, scope: [] });
  for (const queued of ctx.tasks.values()) if (queued.id !== task.id && queued.status === 'waiting' && ['test', 'review', 'visual_qa', 'finalize'].includes(queued.kind)) ctx.updateTask(queued, { deps: [...new Set([...queued.deps, task.id])] });
  ctx.saveRun(); ctx.wakeExecution();
  return { text: `Got it. Your instruction is in my real task queue: ${task.title}.`, taskId: task.id };
}

// ─── deterministic status answers (zero model calls) ─────────────────────────
function tryAnswerFromState(classification: LiveMessageClassification, snap: LiveRunSnapshot): string | null {
  if (classification !== 'STATUS') return null;
  const { completedCount, totalCount, activeCount, failedCount, activeAgents, currentTaskTitle } = snap;
  const parts: string[] = [];
  if (currentTaskTitle) parts.push(`Currently working on: ${currentTaskTitle}.`);
  if (activeAgents.length > 0) {
    const working = activeAgents.filter(a => a.status === 'working' || a.status === 'planning');
    if (working.length > 0) parts.push(`${working.map(a => ROLES[a.role]?.name ?? a.role).join(', ')} ${working.length === 1 ? 'is' : 'are'} active.`);
  }
  parts.push(`Run ${snap.phase}: ${totalCount} total tasks, ${completedCount} complete, ${activeCount} active.`);
  if (failedCount > 0) parts.push(`${failedCount} task${failedCount > 1 ? 's' : ''} failed.`);
  return parts.join(' ');
}

// ─── structured command execution (no model) ─────────────────────────────────
function handleStructuredCommand(
  classification: LiveMessageClassification,
  runId: string,
): { handled: boolean; response?: string } {
  const ctx = activeRun(runId);
  if (!ctx && classification === 'RESUME') {
    resumeRun(runId);
    return { handled: true, response: 'Resumed this run from its persistent checkpoint.' };
  }
  if (!ctx && ['STOP', 'CANCEL', 'PAUSE'].includes(classification)) return { handled: true, response: 'This run is not executing.' };
  if (!ctx) return { handled: false };

  if (classification === 'STOP' || classification === 'CANCEL') {
    cancelRun(runId);
    emit('RUN_CHAT_ASSISTANT', 'Stopping execution. All agents will finish their current operation safely.', ctx.scope(), 'info', { conversationId: managerConversationId(runId) });
    return { handled: true, response: 'Stop requested. Active model calls and processes are being cancelled; the checkpoint is preserved.' };
  }
  if (classification === 'PAUSE') {
    pauseRun(runId);
    return { handled: true, response: 'Paused. In-flight operations may finish safely; no new tasks will start.' };
  }
  if (classification === 'RESUME') {
    if (ctx.run.status === 'paused') resumeRun(runId);
    return { handled: true, response: 'Execution is continuing in the same run.' };
  }
  return { handled: false };
}

// ─── Manager system prompt ────────────────────────────────────────────────────
function buildManagerSystemPrompt(snap: LiveRunSnapshot): string {
  return `You are the SWARM Manager, the control plane for an active software build session.

You are running a live build. Here is the compact execution state:

Run: ${snap.runId}
Objective: ${snap.objective}
Platform: ${snap.target ?? 'auto'}
Phase: ${snap.phase}
Progress: ${snap.completedCount}/${snap.totalCount} tasks complete · ${snap.activeCount} active · ${snap.failedCount} failed
Current task: ${snap.currentTaskTitle ?? 'none'}
Active agents: ${snap.activeAgents.map(a => `${ROLES[a.role]?.name ?? a.role} (${a.status}${a.taskTitle ? ': ' + a.taskTitle : ''})`).join(', ') || 'none'}
${snap.architectureSummary ? `Architecture: ${snap.architectureSummary}` : ''}
${snap.designSummary ? `Design: ${snap.designSummary}` : ''}
${snap.recentDecisions.length ? `Recent decisions:\n${snap.recentDecisions.map(d => '- ' + d).join('\n')}` : ''}
${snap.recentUserInstructions.length ? `Recent user instructions:\n${snap.recentUserInstructions.map(i => '- ' + i).join('\n')}` : ''}

Rules:
- Respond naturally and concisely. You are the authoritative orchestrator.
- For small changes (design/colour/style): acknowledge and note you will update the relevant agents.
- For major changes (architecture/database/target): explain what will change, what is affected, what is unaffected.
- For ambiguous requests: ask exactly ONE clarifying question.
- For status questions: answer from the execution state above.
- NEVER claim to have completed work you haven't. NEVER invent test results or file contents.
- When you make a decision that changes the plan, end your message with a JSON fence:
  \`\`\`decision
  {"classification":"ARCHITECTURE_CHANGE","affectedAreas":["list"],"unaffectedAreas":["list"],"summary":"short decision summary"}
  \`\`\`
- Keep responses concise: 2-5 sentences for small changes, up to 8 sentences for major ones.`;
}

// ─── Agent system prompt ──────────────────────────────────────────────────────
function buildAgentSystemPrompt(role: AgentRole, snap: LiveRunSnapshot): string {
  const roleDef = ROLES[role];
  const ctx2 = activeRun(snap.runId);
  const agentState = ctx2?.agents.get(role);
  const agentTasks = ctx2 ? [...ctx2.tasks.values()].filter(t => t.role === role) : [];
  const currentTask = agentTasks.find(t => t.status === 'running');
  const completedTasks = agentTasks.filter(t => t.status === 'completed');

  return `You are the SWARM ${roleDef.name}, an autonomous AI specialist operating within an active build session.

Your role: ${roleDef.description}
Current build: ${snap.objective}
Platform: ${snap.target ?? 'auto'}
Your current task: ${currentTask?.title ?? agentState?.taskTitle ?? 'waiting for assignment'}
Your status: ${agentState?.status ?? 'waiting'}
Your completed tasks: ${completedTasks.length}/${agentTasks.length}
${completedTasks.length ? `Latest completed: ${completedTasks.slice(-2).map(t => t.title).join(', ')}` : ''}
${snap.architectureSummary ? `Architecture context: ${snap.architectureSummary}` : ''}
${snap.designSummary && ['designer', 'coder', 'tester', 'vision'].includes(role) ? `Design context: ${snap.designSummary}` : ''}

Rules:
- Answer from your actual work and role. Do not fabricate results.
- For status questions: answer from your task state above.
- For task-specific guidance: apply it to your current task context.
- If the user's request changes requirements, architecture, or the overall plan, state: "This is a project-level change — escalating to Manager." and end your message with: \`\`\`escalate\n{"reason":"short reason","instruction":"the original user message"}\n\`\`\`
- For questions within your expertise, answer directly and concisely.
- You can reference files, test results, and design artifacts you have actually worked on.
- Keep responses to 2-6 sentences unless a detailed explanation is clearly needed.`;
}

// ─── parse decision block from Manager response ───────────────────────────────
function extractDecisionBlock(text: string): { classification: string; affectedAreas: string[]; unaffectedAreas: string[]; summary: string } | null {
  const m = text.match(/```decision\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

function stripDecisionBlock(text: string): string {
  return text.replace(/```decision[\s\S]*?```/g, '').trim();
}

// ─── parse escalate block from agent response ─────────────────────────────────
function extractEscalateBlock(text: string): { reason: string; instruction: string } | null {
  const m = text.match(/```escalate\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

function stripEscalateBlock(text: string): string {
  return text.replace(/```escalate[\s\S]*?```/g, '').trim();
}

// ─── graph mutation ────────────────────────────────────────────────────────────
export function applyDecisionToGraph(
  runId: string,
  decision: { classification: string; affectedAreas: string[]; summary: string },
  userInstruction: string,
): RunChatEvent[] {
  const ctx = activeRun(runId);
  if (!ctx) throw new Error('This run is no longer executing. Resume it before changing requirements.');
  const cls = decision.classification;
  if (!['DESIGN_CHANGE', 'ARCHITECTURE_CHANGE', 'TASK_UPDATE', 'PLAN_CHANGE', 'PRIORITY_CHANGE', 'TARGET_CHANGE'].includes(cls)) return [];
  if (cls === 'TARGET_CHANGE') throw new Error('Changing the target platform requires a new project. The current run was preserved.');
  const version = nextGraphVersion(runId);
  const gv: GraphVersion = { version, runId, ts: Date.now(), reason: decision.summary,
    userInstruction, tasksAdded: [], tasksRemoved: [], tasksInvalidated: [], agentsNotified: [] };
  const existing = [...ctx.tasks.values()];
  // Running operations finish safely before the change chain starts. Preserve their results.
  const barrier = existing.filter(t => (t.status === 'running' && !['research', 'review', 'visual_qa', 'finalize'].includes(t.kind)) || ['plan', 'decompose'].includes(t.kind) && t.status === 'waiting').map(t => t.id);
  const areas = decision.affectedAreas.filter(a => typeof a === 'string' && a.trim()).map(a => a.toLowerCase());
  for (const task of existing) {
    const affected = areas.some(a => (task.title + ' ' + task.description + ' ' + task.scope.join(' ')).toLowerCase().includes(a));
    if (affected && !['plan', 'decompose', 'research'].includes(task.kind)) {
      gv.tasksInvalidated.push(task.id);
      if (task.status === 'waiting') ctx.updateTask(task, { status: 'skipped', error: 'Superseded by requirement change', endedAt: Date.now() });
    }
  }
  // Queued verification must follow the changed implementation, not the old plan.
  for (const task of existing) if (task.status === 'waiting' && ['test', 'visual_qa', 'review', 'finalize'].includes(task.kind)) {
    ctx.updateTask(task, { status: 'skipped', error: 'Superseded by requirement change', endedAt: Date.now() });
    if (!gv.tasksInvalidated.includes(task.id)) gv.tasksInvalidated.push(task.id);
  }
  ctx.run.objective += '\nRequirement update: ' + userInstruction;
  if (ctx.run.brief) ctx.run.brief.requirements.push(userInstruction);
  ctx.project.memory.decisions.push({ ts: Date.now(), text: decision.summary });
  const description = 'Apply the latest user requirement, replacing conflicting earlier requirements. Preserve unrelated work.\n' + userInstruction;
  let deps = barrier;
  const add = (role: AgentRole, kind: import('../../shared/types').TaskKind, title: string) => {
    const task = ctx.addTask({ key: ctx.newTaskKey(kind), role, kind, title, description, deps: [...deps], scope: [] });
    gv.tasksAdded.push(task.id); deps = [task.id];
    if (!gv.agentsNotified.includes(role)) {
      ctx.message('manager', role, 'Requirement update v' + version + ': ' + userInstruction, task.id, 'REQUIREMENT_CHANGE');
      gv.agentsNotified.push(role);
    }
  };
  if (cls === 'ARCHITECTURE_CHANGE') add('architect', 'architecture', 'Update architecture: ' + decision.summary.slice(0, 60));
  if (cls === 'DESIGN_CHANGE' || cls === 'TASK_UPDATE' || cls === 'PLAN_CHANGE') add('designer', 'design', 'Update design: ' + decision.summary.slice(0, 60));
  add('coder', 'code', 'Implement change: ' + decision.summary.slice(0, 60));
  // Include unaffected queued implementations so this verification covers the complete objective.
  deps = [...new Set([...deps, ...existing.filter(t => t.status === 'waiting' && ['code', 'optimize', 'repair'].includes(t.kind)).map(t => t.id)])];
  add('tester', 'test', 'Verify updated requirements');
  if (ctx.run.target === 'web' && ctx.settings.experimental.visionQA) add('vision', 'visual_qa', 'Inspect updated application');
  if (ctx.settings.agents.enabled.reviewer !== false) add('reviewer', 'review', 'Review updated requirements');
  add('finalizer', 'finalize', 'Deliver updated application');
  ctx.saveRun();
  db().put('projects', ctx.project.id, ctx.project, { updated_at: Date.now() });
  saveGraphVersion(gv);
  emit('GRAPH_VERSION_CREATED', 'Graph v' + version + ': ' + decision.summary, ctx.scope(), 'info', { graphVersion: gv });
  return [
    { kind: 'task_added', label: gv.tasksAdded.length + ' executable tasks added', taskIds: gv.tasksAdded },
    ...(gv.tasksInvalidated.length ? [{ kind: 'task_invalidated' as const, label: gv.tasksInvalidated.length + ' affected tasks superseded or followed by new work', taskIds: gv.tasksInvalidated }] : []),
    ...gv.agentsNotified.map(role => ({ kind: 'agent_notified' as const, label: (ROLES[role]?.name ?? role) + ' notified', agentRoles: [role] })),
    { kind: 'graph_updated', label: 'Graph updated · v' + version },
  ];
}

// ─── escalate from agent to Manager ──────────────────────────────────────────
function escalateToManager(
  runId: string,
  fromRole: AgentRole,
  instruction: string,
  reason: string,
): void {
  const ctx = activeRun(runId);
  if (!ctx) return;
  ctx.message(fromRole, 'manager', `[USER ESCALATION] ${reason}: "${instruction.slice(0, 400)}"`, null);
  emit('AGENT_MESSAGE', `${ROLES[fromRole].name} escalated to Manager: ${reason}`, ctx.scope(fromRole), 'info', {});
}

// ─── public API ───────────────────────────────────────────────────────────────

/** Send a message to the active run Manager. Streams response via bus events. */
export async function sendManagerChat(input: RunChatInput): Promise<RunChatTurn> {
  const { runId, text } = input;
  if (active.has(`manager:${runId}`)) throw new Error('A response is already being generated for this conversation.');

  const settings = getSettings();
  const conversationId = managerConversationId(runId);

  // Persist user turn
  const userTurn: RunChatTurn = {
    id: uid('rct_'), ts: Date.now(), runId, conversationId,
    senderType: 'user', senderId: 'user',
    recipientType: 'manager', recipientId: 'manager',
    text, status: 'complete',
  };
  saveTurn(userTurn);
  emit('RUN_CHAT_USER', text, activeRun(runId)?.scope() ?? { runId }, 'info', { turn: userTurn, conversationId });

  // Build response turn (streaming)
  const responseTurn: RunChatTurn = {
    id: uid('rct_'), ts: Date.now(), runId, conversationId,
    senderType: 'manager', senderId: 'manager',
    recipientType: 'manager', recipientId: 'user',
    text: '', status: 'streaming',
    relatedGraphVersion: currentGraphVersion(runId),
  };
  saveTurn(responseTurn);
  bus.send('run:chat:updated', { conversationId, turn: responseTurn });

  const ctrl = new AbortController();
  active.set(`manager:${runId}`, ctrl);
  const changeContext = activeRun(runId);
  if (changeContext) changeContext.pendingChanges++;

  void (async () => {
    try {
      // 1. Build live snapshot
      const snap = buildLiveSnapshot(runId);

      // 2. Classify the message
      const classification = classifyRunMessage(text);
      userTurn.classification = classification;
      saveTurn(userTurn);

      // 3. Structured commands — no model needed
      const structured = handleStructuredCommand(classification, runId);
      if (structured.handled) {
        responseTurn.text = structured.response ?? '';
        responseTurn.status = 'complete';
        saveTurn(responseTurn);
        bus.send('run:chat:updated', { conversationId, turn: responseTurn });
        return;
      }

      // 4. Status queries — answer from state, zero model calls
      const stateAnswer = tryAnswerFromState(classification, snap);
      if (stateAnswer) {
        responseTurn.text = stateAnswer;
        responseTurn.status = 'complete';
        saveTurn(responseTurn);
        bus.send('run:chat:updated', { conversationId, turn: responseTurn });
        return;
      }

      // Explicit requirement changes reach the executing task graph even if the
      // conversational model is unavailable. This acknowledges queued work,
      // never a fabricated completion.
      if (['DESIGN_CHANGE', 'ARCHITECTURE_CHANGE', 'TASK_UPDATE', 'PLAN_CHANGE', 'PRIORITY_CHANGE', 'TARGET_CHANGE'].includes(classification)) {
        responseTurn.events = applyDecisionToGraph(runId, { classification, affectedAreas: [], summary: text.slice(0, 100) }, text);
        responseTurn.text = 'Got it. I have updated the task requirements and queued the relevant agents to implement and verify your change.';
        responseTurn.status = 'complete'; responseTurn.relatedGraphVersion = currentGraphVersion(runId);
        saveTurn(responseTurn);
        emit('RUN_CHAT_ASSISTANT', responseTurn.text, { runId }, 'info', { turn: responseTurn, conversationId, classification });
        bus.send('run:chat:updated', { conversationId, turn: responseTurn });
        return;
      }

      // 5. Build context messages for the model
      const history = loadTurns(conversationId, 10).filter(t => t.id !== userTurn.id && t.id !== responseTurn.id);
      const messages: import('../providers/types').ChatMessage[] = [
        { role: 'system', content: buildManagerSystemPrompt(snap) },
        ...history.filter(t => t.status === 'complete').slice(-6).map(t => ({
          role: (t.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: t.text,
        })),
        { role: 'user', content: text },
      ];

      // 6. Stream from model
      let lastUpdate = 0;
      const r = await complete({
        route: { purpose: 'plan', maxTokens: 800, pinned: settings.ai?.pinnedModel ?? '' },
        messages,
        scope: activeRun(runId)?.scope() ?? { runId },
        signal: ctrl.signal,
        stream: true,
        quiet: true,
        onToken: (delta) => {
          responseTurn.text += delta;
          if (Date.now() - lastUpdate > 40) {
            bus.send('run:chat:updated', { conversationId, turn: { ...responseTurn, text: stripDecisionBlock(publicChatText(responseTurn.text)).replace(/```decision[\s\S]*$/g, '') } });
            lastUpdate = Date.now();
          }
        },
        onReset: () => { responseTurn.text = ''; },
      });

      responseTurn.text = r.text;
      responseTurn.model = r.model.displayName;
      responseTurn.tokens = r.result.promptTokens + r.result.completionTokens;
      responseTurn.status = ctrl.signal.aborted ? 'error' : 'complete';

      // 7. Extract decision block and apply to graph
      const decision = extractDecisionBlock(responseTurn.text) ?? (['DESIGN_CHANGE', 'ARCHITECTURE_CHANGE', 'TASK_UPDATE', 'PLAN_CHANGE', 'PRIORITY_CHANGE', 'TARGET_CHANGE'].includes(classification) ? { classification, affectedAreas: [], unaffectedAreas: [], summary: text.slice(0, 100) } : null);
      if (decision) {
        // Explicit UI/task requests retain their intent even if the model copies
        // the architecture-change example from the system prompt.
        if (['DESIGN_CHANGE', 'TASK_UPDATE', 'ARCHITECTURE_CHANGE', 'TARGET_CHANGE'].includes(classification)) decision.classification = classification;
        responseTurn.text = stripDecisionBlock(responseTurn.text);
        const chatEvents = applyDecisionToGraph(runId, decision, text);
        responseTurn.events = chatEvents;
        if (chatEvents.length) responseTurn.text = 'Updated the requirements in this run and queued implementation and verification. Unaffected work is preserved. ' + decision.summary;
        responseTurn.relatedGraphVersion = currentGraphVersion(runId);
      }

      saveTurn(responseTurn);
      emit('RUN_CHAT_ASSISTANT', responseTurn.text.slice(0, 200), activeRun(runId)?.scope() ?? { runId }, 'info', {
        turn: responseTurn, conversationId, classification,
      });
      bus.send('run:chat:updated', { conversationId, turn: responseTurn });
    } catch (e) {
      if (!ctrl.signal.aborted) {
        responseTurn.text = errMsg(e);
        responseTurn.status = 'error';
        responseTurn.error = errMsg(e);
        saveTurn(responseTurn);
        bus.send('run:chat:updated', { conversationId, turn: responseTurn });
      }
    } finally {
      if (changeContext) { changeContext.pendingChanges--; changeContext.wakeExecution(); }
      active.delete(`manager:${runId}`);
    }
  })();

  return responseTurn;
}

/** Send a message directly to a specific agent during an active run. */
export async function sendAgentChat(input: AgentChatInput): Promise<RunChatTurn> {
  const { runId, agentRole, text } = input;
  if (!Object.hasOwn(ROLES, agentRole) || !text.trim() || text.length > 8000) throw new Error('Invalid agent message');
  const convKey = `agent:${runId}:${agentRole}`;
  if (active.has(convKey)) throw new Error('A response is already being generated for this agent conversation.');

  const settings = getSettings();
  const conversationId = agentConversationId(runId, agentRole);

  // Persist user turn
  const userTurn: RunChatTurn = {
    id: uid('rct_'), ts: Date.now(), runId, conversationId,
    senderType: 'user', senderId: 'user',
    recipientType: 'agent', recipientId: agentRole,
    text, status: 'complete',
  };
  saveTurn(userTurn);
  emit('RUN_CHAT_AGENT_USER', text, activeRun(runId)?.scope(agentRole) ?? { runId }, 'info', {
    turn: userTurn, conversationId, agentRole,
  });

  // Response turn
  const responseTurn: RunChatTurn = {
    id: uid('rct_'), ts: Date.now(), runId, conversationId,
    senderType: 'agent', senderId: agentRole,
    recipientType: 'agent', recipientId: agentRole,
    text: '', status: 'streaming',
    relatedGraphVersion: currentGraphVersion(runId),
  };
  saveTurn(responseTurn);

  const ctrl = new AbortController();
  active.set(convKey, ctrl);

  void (async () => {
    try {
      const delivery = deliverAgentInstruction(runId, agentRole, text);
      if (delivery) {
        responseTurn.text = delivery.text; responseTurn.status = 'complete';
        responseTurn.relatedTaskId = delivery.taskId ?? null;
        saveTurn(responseTurn);
        emit('RUN_CHAT_AGENT_ASSISTANT', responseTurn.text, { runId, agent: agentRole }, 'info', { turn: responseTurn, conversationId, agentRole });
        bus.send('run:chat:updated', { conversationId, turn: responseTurn });
        return;
      }
      const snap = buildLiveSnapshot(runId);
      const classification = classifyAgentMessage(text);
      userTurn.classification = classification;
      saveTurn(userTurn);

      // Status request — answer from state
      if (classification === 'STATUS_REQUEST') {
        const ctx = activeRun(runId);
        const agentState = ctx?.agents.get(agentRole);
        const agentTasks = (ctx ? [...ctx.tasks.values()] : db().list<import('../../shared/types').Task>('tasks', 'run_id = ?', [runId])).filter(t => t.role === agentRole);
        const currentTask = agentTasks.find(t => t.status === 'running');
        const completedTasks = agentTasks.filter(t => t.status === 'completed');

        let answer = '';
        if (currentTask) {
          answer = `Working on: "${currentTask.title}". `;
        } else if (agentState?.status === 'waiting') {
          answer = 'Waiting for dependencies to complete. ';
        } else if (agentState?.status === 'completed') {
          answer = 'All my tasks are complete. ';
        }
        if (completedTasks.length) {
          answer += `Completed ${completedTasks.length} task${completedTasks.length > 1 ? 's' : ''}: ${completedTasks.map(t => t.title).join(', ')}.`;
        }
        if (!answer) answer = 'No active tasks assigned yet.';

        responseTurn.text = answer;
        responseTurn.status = 'complete';
        saveTurn(responseTurn);
        bus.send('run:chat:updated', { conversationId, turn: responseTurn });
        return;
      }

      // Build conversation history
      const history = loadTurns(conversationId, 10).filter(t => t.id !== userTurn.id && t.id !== responseTurn.id);
      const messages: import('../providers/types').ChatMessage[] = [
        { role: 'system', content: buildAgentSystemPrompt(agentRole, snap) },
        ...history.filter(t => t.status === 'complete').slice(-6).map(t => ({
          role: (t.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: t.text,
        })),
        { role: 'user', content: text },
      ];

      let lastUpdate = 0;
      const r = await complete({
        route: { purpose: ROLES[agentRole].purpose, maxTokens: 600, pinned: settings.ai?.pinnedModel ?? '' },
        messages,
        scope: activeRun(runId)?.scope(agentRole) ?? { runId },
        signal: ctrl.signal,
        stream: true,
        quiet: true,
        onToken: (delta) => {
          responseTurn.text += delta;
          if (Date.now() - lastUpdate > 40) {
            bus.send('run:chat:updated', { conversationId, turn: { ...responseTurn, text: stripEscalateBlock(publicChatText(responseTurn.text)) } });
            lastUpdate = Date.now();
          }
        },
        onReset: () => { responseTurn.text = ''; },
      });

      responseTurn.text = r.text;
      responseTurn.model = r.model.displayName;
      responseTurn.tokens = r.result.promptTokens + r.result.completionTokens;
      responseTurn.status = ctrl.signal.aborted ? 'error' : 'complete';

      // Check for escalation
      const escalate = extractEscalateBlock(responseTurn.text);
      if (escalate) {
        responseTurn.text = stripEscalateBlock(responseTurn.text);
        escalateToManager(runId, agentRole, escalate.instruction, escalate.reason);
        await sendManagerChat({ runId, text: escalate.instruction });
        responseTurn.events = [{
          kind: 'agent_notified',
          label: `Escalated to Manager`,
          agentRoles: ['manager'],
        }];
      }

      saveTurn(responseTurn);
      emit('RUN_CHAT_AGENT_ASSISTANT', responseTurn.text.slice(0, 200), activeRun(runId)?.scope(agentRole) ?? { runId }, 'info', {
        turn: responseTurn, conversationId, agentRole, classification,
      });
      bus.send('run:chat:updated', { conversationId, turn: responseTurn });
    } catch (e) {
      if (!ctrl.signal.aborted) {
        responseTurn.text = errMsg(e);
        responseTurn.status = 'error';
        responseTurn.error = errMsg(e);
        saveTurn(responseTurn);
        bus.send('run:chat:updated', { conversationId, turn: responseTurn });
      }
    } finally {
      active.delete(convKey);
    }
  })();

  return responseTurn;
}

/** Stop a streaming live run chat response. */
export function stopRunChat(conversationId: string): boolean {
  // Try both manager and agent keys
  const managerKey = `manager:${conversationId.split(':')[0]}`;
  if (active.has(managerKey)) { active.get(managerKey)!.abort(); active.delete(managerKey); return true; }
  // Try as a direct conversation ID
  for (const [k, ctrl] of active) {
    if (k.includes(conversationId)) { ctrl.abort(); active.delete(k); return true; }
  }
  return false;
}

/** Get the chat history for a conversation (manager or agent). */
export function getRunChatHistory(conversationId: string, limit = 100): RunChatTurn[] {
  return loadTurns(conversationId, limit);
}

/** Get a compact live run snapshot for the UI. */
export function getRunSnapshot(runId: string): LiveRunSnapshot {
  return buildLiveSnapshot(runId);
}

/** List all graph versions for a run. */
export function getGraphVersions(runId: string): GraphVersion[] {
  return db().list<GraphVersion>('graph_versions', 'run_id = ?', [runId], 'ts ASC');
}

export function stopAllRunChats(runId: string): void {
  for (const [k, ctrl] of active) {
    if (k.includes(runId)) { ctrl.abort(); active.delete(k); }
  }
}
