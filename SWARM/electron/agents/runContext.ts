// In-memory state of an active run, with persistence + event emission on every change.
import type { AgentMessage, AgentRole, AgentState, ErrorCategory, ExecutionMode, ManagerBrief, Project, QualityGate, RecoveryRecord, ResearchFinding, ResearchSource, Run, RunProgress, Task, TaskKind, GateId } from '../../shared/types';
import { canTransition } from './taskState';
import type { ModeDecision } from './strategy';
import type { Settings } from '../../shared/settings';
import { db } from '../core/db';
import { bus, emit, type EventScope } from '../core/bus';
import { readyTasks } from './scheduler';
import { runtimeManager } from '../runtime/manager';
import { listLive } from '../tools/process';
import { listApprovals } from '../tools/approvals';
import { hasActiveOperations, timeOperation } from '../core/performance';
import { uid } from '../core/util';
import { ROLES } from './roles';
import { saveCheckpoint } from '../core/checkpoint';

export interface ArchitectureSpec {
  targetPlatform?: import('../../shared/types').PlatformType;
  buildSystem?: string;
  launchCommand?: string;
  previewStrategy?: string;
  testStrategy?: string;
  packagingStrategy?: string;
  stack: string;
  summary: string;
  runtime: string;
  commands: { install?: string; dev?: string; build?: string; test?: string; typecheck?: string; lint?: string };
  files: { path: string; purpose: string }[];
  api: { method: string; path: string; description: string }[];
  conventions: string[];
}

export function emptyProgress(mode: ExecutionMode, modeReason: string): RunProgress {
  return {
    mode, modeReason, phase: 'planning', currentTask: null, lastSuccess: null, lastVerified: null, blocker: null, lastError: null,
    retries: { used: 0, max: 0 }, model: null,
    usage: { calls: 0, failedCalls: 0, reportedTokens: 0, estimatedTokens: 0, promptTokens: 0, completionTokens: 0 },
    recovery: [], updatedAt: Date.now(),
  };
}

export const GATE_LABELS: Record<GateId, string> = {
  // Universal gates
  deps: 'Dependencies',
  typecheck: 'Typecheck',
  lint: 'Lint',
  build: 'Build',
  unit: 'Unit tests',
  review: 'Final review',
  // Web-specific gates
  server: 'App starts',
  browser: 'Browser test',
  console: 'Console errors',
  responsive: 'Responsive layout',
  visual: 'Visual QA',
  // CLI-specific gates
  cli_args: 'CLI arguments',
  cli_help: 'Help output',
  cli_exit_codes: 'Exit codes',
  // Desktop-specific gates
  desktop_launch: 'Desktop launch',
  desktop_package: 'Package creation',
  // Mobile-specific gates
  mobile_build: 'Mobile build',
  mobile_emulator: 'Emulator test',
  mobile_permissions: 'Permissions',
  // Backend/API-specific gates
  service_start: 'Service starts',
  endpoint_tests: 'Endpoint tests',
  api_contract: 'API contract',
};

export class RunContext {
  readonly ctrl = new AbortController();
  readonly tasks = new Map<string, Task>();
  readonly agents = new Map<AgentRole, AgentState>();
  readonly messages: AgentMessage[] = [];
  readonly suspendedAgents = new Set<AgentRole>();
  readonly taskControllers = new Map<string, AbortController>();
  sources: ResearchSource[] = [];
  findings: ResearchFinding[] = [];
  design = '';
  architecture: ArchitectureSpec | null = null;
  devServer: { commandId: string | null; url: string; port: number; stop: () => void } | null = null;
  notes = new Map<AgentRole, string[]>();
  sourceCounter = 0;
  installLock: Promise<unknown> = Promise.resolve();
  pendingChanges = 0;
  private resumeWaiters: (() => void)[] = [];

  async waitUntilResumed() {
    while (this.run.status === 'paused' && !this.signal.aborted) {
      await new Promise<void>(resolve => {
        const wake = () => { this.signal.removeEventListener('abort', wake); resolve(); };
        this.resumeWaiters.push(wake);
        this.signal.addEventListener('abort', wake, { once: true });
      });
    }
  }

  private executionWaiters = new Set<() => void>();
  executionWake() {
    let wake!: () => void;
    const promise = new Promise<void>(resolve => { wake = resolve; this.executionWaiters.add(wake); this.signal.addEventListener('abort', wake, { once: true }); });
    return { promise, dispose: () => { this.executionWaiters.delete(wake); this.signal.removeEventListener('abort', wake); } };
  }
  wakeExecution() {
    for (const wake of this.resumeWaiters.splice(0)) wake();
    for (const wake of this.executionWaiters) wake();
    this.executionWaiters.clear();
  }
  lastActivityAt = Date.now();
  lastCheckpointAt = 0;
  /** Budgets apply per execution (a resumed run gets a fresh time/token window, not the original one). */
  readonly executionStartedAt = Date.now();
  tokensAtStart = 0;
  heartbeatInterval: NodeJS.Timeout | null = null;
  /** Set when the run must stop promptly (no usable provider, hard budget). No new tasks are dispatched. */
  halt: { message: string; category: ErrorCategory } | null = null;
  strategy: ModeDecision | null = null;
  /** Failure signature → number of repair cycles already spent on it. */
  readonly failureSignatures = new Map<string, number>();
  /** Task ids with an executing worker; prevents duplicate execution of one job. */
  readonly executing = new Set<string>();
  readonly retryTimers = new Map<string, NodeJS.Timeout>();

  constructor(public run: Run, public project: Project, public settings: Settings) {
    this.tokensAtStart = run.stats?.tokens ?? 0;
    // Start heartbeat monitoring
    this.startHeartbeat();
  }

  private startHeartbeat() {
    // Check for stalls every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      this.checkForStall();
    }, 30000);
  }

  private checkForStall() {
    if (this.run.status !== 'running') return;
    
    const now = Date.now();
    const timeSinceActivity = now - this.lastActivityAt;
    const stallThreshold = 5 * 60 * 1000; // 5 minutes
    
    // Check if we have any running tasks
    const runningTasks = [...this.tasks.values()].filter(t => t.status === 'running');
    
    const busy = hasActiveOperations(this.run.id) || this.pendingChanges > 0 ||
      runtimeManager.getActiveRuntimes().some(r => r.runId === this.run.id) ||
      listLive(this.project.id).some(p => p.runId === this.run.id) ||
      listApprovals().some(a => a.runId === this.run.id) || readyTasks(this.tasks, ['test', 'review', 'visual_qa', 'finalize']).length > 0;
    // Report the actual blocker instead of a generic "running" state.
    const approval = listApprovals().find(a => a.runId === this.run.id);
    if (approval) { if (this.progress.blocker?.text !== `Waiting for your approval: ${approval.title}`) this.setBlocker(`Waiting for your approval: ${approval.title}`, 'approval'); }
    else if (this.progress.blocker?.category === 'approval') this.setBlocker(null);
    if (!busy && timeSinceActivity > stallThreshold && [...this.tasks.values()].some(t => t.status === 'waiting' || t.status === 'running')) {
      const blockers = [...this.tasks.values()].filter(t => t.status === 'waiting').map(t => {
        const missing = t.deps.filter(d => !this.tasks.has(d));
        const open = t.deps.map(d => this.tasks.get(d)).filter((d): d is Task => !!d && d.status !== 'completed');
        return `${t.title}: ${missing.length ? `missing dependency ${missing.join(', ')}` : open.length ? `waiting on ${open.map(d => `${d.title} (${d.status})`).join(', ')}` : this.suspendedAgents.has(t.role) ? 'agent stopped by user' : 'ready but not dispatched'}`;
      });
      this.setBlocker(`No progress for ${Math.round(timeSinceActivity / 60000)} min. ${blockers[0] ?? 'No runnable task'}`, 'no_progress');
      emit('RUN_STALLED', `No progress for ${Math.round(timeSinceActivity / 60000)} minutes. Blockers: ${blockers.slice(0, 3).join('; ') || 'none identified'}`, 
        this.scope(), 'warning', {
          timeSinceActivity,
          blockers,
          runningTasks: runningTasks.map(t => ({ id: t.id, title: t.title, role: t.role })),
        });
      
      // Mark stalled tasks
      for (const task of runningTasks) {
        if (now - (task.startedAt ?? now) > stallThreshold) {
          emit('TASK_STALLED', `${ROLES[task.role].name}: ${task.title} — no progress detected`, 
            this.scope(task), 'warning', { task });
        }
      }
    }
  }

  stopHeartbeat() {
    if (this.progressTimer) { clearTimeout(this.progressTimer); this.progressTimer = null; }
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  get signal() { return this.ctrl.signal; }
  get root() { return this.project.path; }

  scope(taskOrAgent?: Task | AgentRole | null): EventScope {
    if (!taskOrAgent) return { projectId: this.project.id, runId: this.run.id };
    if (typeof taskOrAgent === 'string') return { projectId: this.project.id, runId: this.run.id, agent: taskOrAgent };
    return { projectId: this.project.id, runId: this.run.id, taskId: taskOrAgent.id, agent: taskOrAgent.role };
  }

  saveRun() {
    // Enhanced checkpoint with full state persistence
    saveCheckpoint(
      this.run.id,
      this.project.id,
      this.architecture,
      this.design,
      this.notes,
      this.agents,
      this.tasks,
      this.root,
      this.sourceCounter,
    );
    
    this.lastCheckpointAt = Date.now();
    db().put('runs', this.run.id, this.run, { project_id: this.run.projectId, started_at: this.run.startedAt });
    bus.send('run:updated', this.run);
  }

  setBrief(b: ManagerBrief) { this.run.brief = b; this.saveRun(); }

  addTask(t: Omit<Task, 'id' | 'runId' | 'status' | 'attempt' | 'output' | 'error' | 'modelId' | 'startedAt' | 'endedAt' | 'createdAt' | 'filesTouched' | 'tokens'> & { id?: string }): Task {
    const endGraph = timeOperation('graph', this.run.id);
    const task: Task = {
      id: t.id ?? uid('tk_'), runId: this.run.id, key: t.key, title: t.title, description: t.description, role: t.role, kind: t.kind,
      priority: t.priority ?? 0, requiredCapabilities: t.requiredCapabilities ?? [], producedArtifacts: t.producedArtifacts ?? [], consumedArtifacts: t.consumedArtifacts ?? [],
      status: 'waiting', deps: t.deps, attempt: 1, scope: t.scope, output: null, error: null, modelId: null,
      startedAt: null, endedAt: null, createdAt: Date.now(), filesTouched: [], tokens: 0,
    };
    this.tasks.set(task.id, task);
    this.wakeExecution();
    this.persistTask(task);
    this.run.stats.tasks = this.tasks.size;
    this.saveRun();
    emit('TASK_CREATED', `${ROLES[task.role].name}: ${task.title}`, this.scope(task), 'debug', { task });
    this.touchAgent(task.role, { status: this.agents.get(task.role)?.status === 'working' ? 'working' : 'waiting' });
    endGraph();
    return task;
  }

  persistTask(t: Task) { db().put('tasks', t.id, t, { run_id: t.runId, created_at: t.createdAt }); }

  /**
   * Apply a task patch. Status changes go through the lifecycle state machine: an illegal change
   * (e.g. completed → running without an explicit retry) is refused and reported, the rest of the patch applies.
   * Returns false when the status change was refused.
   */
  updateTask(t: Task, patch: Partial<Task>, event?: { type: 'TASK_STARTED' | 'TASK_COMPLETED' | 'TASK_FAILED' | 'TASK_UPDATED'; message: string; level?: 'info' | 'success' | 'warning' | 'error' }, opts: { retry?: boolean } = {}): boolean {
    let accepted = true;
    if (patch.status && patch.status !== t.status && !canTransition(t.status, patch.status, opts)) {
      accepted = false;
      emit('TASK_UPDATED', `Refused illegal task transition ${t.status} → ${patch.status}: ${t.title}`, this.scope(t), 'error', { task: t, from: t.status, to: patch.status });
      const { status: _ignored, ...rest } = patch;
      patch = rest;
      event = undefined;
    }
    const before = t.status;
    Object.assign(t, patch);
    this.wakeExecution();
    this.persistTask(t);
    this.lastActivityAt = Date.now();
    
    if (event) emit(event.type, event.message, this.scope(t), event.level ?? 'info', { task: t });
    else emit('TASK_UPDATED', t.title, this.scope(t), 'debug', { task: t });
    const done = [...this.tasks.values()];
    this.run.stats.completed = done.filter((x) => x.status === 'completed').length;
    this.run.stats.failed = done.filter((x) => x.status === 'failed').length;
    if (before !== t.status) this.trackTaskProgress(t);
    
    // Checkpoint after significant task state changes
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'blocked' || t.status === 'retry_wait') {
      this.saveRun();
    }
    return accepted;
  }

  // ---------------------------------------------------------------- truthful progress
  get progress(): RunProgress {
    if (!this.run.progress) this.run.progress = emptyProgress(this.run.mode ?? 'complex', '');
    return this.run.progress;
  }

  private progressTimer: NodeJS.Timeout | null = null;
  /** Progress changes are frequent; broadcast at most every 250 ms (saveRun broadcasts immediately). */
  private touchProgress() {
    this.progress.updatedAt = Date.now();
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => { this.progressTimer = null; bus.send('run:updated', this.run); }, 250);
    this.progressTimer.unref?.();
  }

  setMode(mode: ExecutionMode, reason: string) {
    this.run.mode = mode;
    this.progress.mode = mode;
    this.progress.modeReason = reason;
    this.touchProgress();
  }

  setPhase(phase: RunProgress['phase']) { if (this.progress.phase !== phase) { this.progress.phase = phase; this.touchProgress(); } }

  private trackTaskProgress(t: Task) {
    const p = this.progress;
    if (t.status === 'running' || t.status === 'verifying') {
      p.currentTask = { id: t.id, title: t.title, role: t.role, status: t.status };
      const phase: RunProgress['phase'] = t.kind === 'plan' || t.kind === 'decompose' ? 'planning' : t.kind === 'repair' ? 'repairing' : t.kind === 'finalize' ? 'finalizing' : ['test', 'visual_qa', 'review'].includes(t.kind) || t.status === 'verifying' ? 'verifying' : 'implementing';
      p.phase = phase;
      // Waits (cooldowns, deadlock notices) end when work resumes; decisions such as "repairs stopped" persist.
      if (p.blocker && (p.blocker.text.startsWith('No progress for') || !['approval', 'no_progress', 'budget', 'verification', 'quota', 'auth', 'no_provider'].includes(p.blocker.category))) p.blocker = null;
    } else if (p.currentTask?.id === t.id) {
      const next = [...this.tasks.values()].find(x => x.status === 'running' || x.status === 'verifying');
      p.currentTask = next ? { id: next.id, title: next.title, role: next.role, status: next.status } : null;
    }
    // A task finishing its handler is not engineering evidence; verification gates are recorded separately.
    if (t.status === 'completed') p.lastSuccess = { text: `${ROLES[t.role].name}: ${t.title}`, ts: Date.now() };
    if (t.status === 'blocked' && t.blocker) p.blocker = { text: t.blocker, category: t.errorCategory ?? 'internal', ts: Date.now() };
    if (t.status === 'retry_wait') { p.phase = 'waiting_retry'; p.blocker = { text: t.blocker ?? 'Waiting for a provider cooldown', category: t.errorCategory ?? 'rate_limit', ts: Date.now() }; }
    if (t.status === 'failed' && t.error) p.lastError = { message: t.error.slice(0, 400), category: t.errorCategory ?? 'internal', ts: Date.now() };
    this.touchProgress();
  }

  setBlocker(text: string | null, category: ErrorCategory = 'internal') {
    this.progress.blocker = text ? { text, category, ts: Date.now() } : null;
    this.touchProgress();
  }

  recordError(message: string, category: ErrorCategory) {
    this.progress.lastError = { message: message.slice(0, 400), category, ts: Date.now() };
    this.touchProgress();
  }

  recordVerified(milestone: string) {
    this.progress.lastVerified = { milestone, ts: Date.now() };
    this.touchProgress();
  }

  /** Every retry/recovery decision is recorded with its reason, attempt budget and strategy. */
  recordRecovery(r: Omit<RecoveryRecord, 'ts'>) {
    const rec = { ...r, ts: Date.now() };
    this.progress.recovery = [...this.progress.recovery, rec].slice(-40);
    this.progress.retries = { used: this.progress.retries.used + 1, max: Math.max(this.progress.retries.max, r.maxAttempts) };
    emit('TASK_UPDATED', `Recovery (${r.category}) attempt ${r.attempt}/${r.maxAttempts}: ${r.strategy} — ${r.reason.slice(0, 200)}`, r.taskId ? { ...this.scope(), taskId: r.taskId } : this.scope(), 'warning', { recovery: rec });
    this.saveRun();
  }

  /** Real usage from provider metadata; estimates are tracked separately and never presented as measured. */
  recordModelUsage(model: { providerId: string; modelId: string; displayName: string }, usage: { promptTokens: number; completionTokens: number; estimated: boolean } | null) {
    const u = this.progress.usage;
    if (!usage) { u.failedCalls++; this.touchProgress(); return; }
    u.calls++;
    u.promptTokens += usage.promptTokens;
    u.completionTokens += usage.completionTokens;
    const total = usage.promptTokens + usage.completionTokens;
    if (usage.estimated) { u.estimatedTokens += total; this.run.stats.tokensEstimated = (this.run.stats.tokensEstimated ?? 0) + total; }
    else u.reportedTokens += total;
    this.progress.model = model;
    this.touchProgress();
  }

  /** Replace dependency edges old -> new for tasks that have not started (graph rewiring for repair loops). */
  rewire(oldId: string, newId: string) {
    for (const t of this.tasks.values()) {
      if (t.status !== 'waiting' || t.id === newId) continue;
      if (t.deps.includes(oldId)) this.updateTask(t, { deps: t.deps.map((d) => (d === oldId ? newId : d)) });
    }
    emit('GRAPH_UPDATED', 'Task graph updated', this.scope('manager'), 'debug', {});
  }

  touchAgent(role: AgentRole, patch: Partial<AgentState>) {
    const prev = this.agents.get(role) ?? {
      role, status: 'idle', taskId: null, taskTitle: null, modelId: null, lastAction: null, tasksDone: 0, errors: 0, tokens: 0, filesTouched: [], updatedAt: Date.now(),
    } as AgentState;
    
    // Determine actual status based on run state and tasks
    let actualStatus = patch.status ?? prev.status;
    
    // If run is active, no agent should be truly "idle"
    if (this.run.status === 'running') {
      const agentTasks = [...this.tasks.values()].filter(t => t.role === role);
      const hasWaitingTasks = agentTasks.some(t => t.status === 'waiting');
      const hasRunningTasks = agentTasks.some(t => t.status === 'running');
      const hasCompletedTasks = agentTasks.some(t => t.status === 'completed');
      const allTasksComplete = hasCompletedTasks && agentTasks.every(t => t.status === 'completed' || t.status === 'skipped' || t.status === 'cancelled');
      
      // Override "idle" with more accurate status during active run
      if (actualStatus === 'idle' && hasWaitingTasks) {
        actualStatus = 'available'; // Has tasks but not currently executing
      } else if (actualStatus === 'idle' && hasRunningTasks) {
        actualStatus = 'working'; // Should be working
      } else if (actualStatus === 'idle' && allTasksComplete) {
        actualStatus = 'completed'; // All work done
      } else if (actualStatus === 'idle' && hasCompletedTasks) {
        actualStatus = 'available'; // Some work done, may have more
      }
    }
    
    const activeTask = [...this.tasks.values()].find(t => t.role === role && t.status === 'running');
    if (activeTask && actualStatus === 'completed') actualStatus = 'working';
    const next = { ...prev, ...patch, ...(activeTask ? { taskId: activeTask.id, taskTitle: activeTask.title } : {}), status: actualStatus, updatedAt: Date.now() };
    this.agents.set(role, next);
    emit('AGENT_STATUS', `${ROLES[role].name}: ${next.status}`, this.scope(role), 'debug', { agent: next });
  }

  message(from: AgentRole, to: AgentRole | 'all', content: string, taskId: string | null = null, type: import('../../shared/types').AgentMessageType = 'STATUS', payload?: Record<string, unknown>) {
    const end = timeOperation('message', this.run.id);
    const m: AgentMessage = { id: uid('msg_'), ts: Date.now(), runId: this.run.id, from, to, content, taskId, type, payload, priority: ['ERROR', 'BLOCKED', 'ESCALATION', 'TEST_FAILURE'].includes(type) ? 'high' : 'normal', relatedTaskIds: taskId ? [taskId] : [], relatedArtifactIds: [] };
    this.messages.push(m);
    db().put('messages', m.id, m, { run_id: m.runId, ts: m.ts });
    emit('AGENT_MESSAGE', content, { ...this.scope(from), taskId }, 'info', { message: m });
    this.lastActivityAt = Date.now();
    this.wakeExecution();
    end();
    return m;
  }

  inbox(role: AgentRole, limit = 6): AgentMessage[] {
    return this.messages.filter((m) => m.to === role || m.to === 'all').slice(-limit);
  }

  note(role: AgentRole, text: string) {
    const list = this.notes.get(role) ?? [];
    list.push(text); this.notes.set(role, list.slice(-8));
  }

  setGate(id: GateId, status: QualityGate['status'], detail: string | null = null) {
    let g = this.run.gates.find((x) => x.id === id);
    if (!g) { g = { id, label: GATE_LABELS[id], status, detail, ts: Date.now(), attempt: 1 }; this.run.gates.push(g); }
    else { if (status === 'running' && g.status !== 'pending' && g.status !== 'running') g.attempt++; g.status = status; g.detail = detail; g.ts = Date.now(); }
    const type = status === 'running' ? 'TEST_STARTED' : status === 'passed' ? 'TEST_PASSED' : status === 'failed' ? 'TEST_FAILED' : status === 'skipped' ? 'TEST_SKIPPED' : 'TEST_STARTED';
    if (status !== 'pending') emit(type, `${GATE_LABELS[id]}: ${status === 'running' ? 'running' : status}${detail && status !== 'running' ? ` — ${detail.split('\n')[0].slice(0, 160)}` : ''}`, this.scope('tester'), status === 'passed' ? 'success' : status === 'failed' ? 'error' : 'info', { gate: id, status });
    if (status === 'passed') this.progress.lastVerified = { milestone: `${GATE_LABELS[id]} passed${detail ? `: ${detail.split('\n')[0].slice(0, 120)}` : ''}`, ts: Date.now() };
    if (status === 'failed') this.progress.lastError = { message: `${GATE_LABELS[id]} failed${detail ? `: ${detail.split('\n')[0].slice(0, 200)}` : ''}`, category: 'verification', ts: Date.now() };
    this.saveRun();
  }

  newTaskKey(kind: TaskKind) { return `${kind}-${[...this.tasks.values()].filter((t) => t.kind === kind).length + 1}`; }
}
