import { finishManagedOperation } from '../account/managed';
// Orchestrator: UNDERSTAND → PLAN → DECOMPOSE → ROUTE → EXECUTE → OBSERVE → VERIFY → RECOVER → COMPLETE.
// Runs a dynamic task DAG with real concurrency and a bounded self-repair loop.
import fs from 'node:fs';
import { readyTasks, validateGraph, scopesOverlap } from './scheduler';
import { timeOperation, recordTiming } from '../core/performance';
import path from 'node:path';
import { z } from 'zod';
import type { AgentRole, AgentState, ManagerBrief, Run, RunOptions, Task, TaskKind, Project } from '../../shared/types';
import { AGENT_ROLES } from '../../shared/types';
import { db } from '../core/db';
import { emit } from '../core/bus';
import { getSettings } from '../core/settings';
import { notify } from '../core/notify';
import { CancelledError, errMsg, truncate, uid } from '../core/util';
import { NoModelError } from '../router/router';
import { isSmallChange, missingEvidence } from '../core/factory';
import { discoverArtifacts } from '../core/artifacts';
import { resolveTarget, projectTypeFor, projectTarget } from '../core/target';
import { getAvailableToolchains, getCachedToolchains, peekToolchains } from '../core/toolchain';
import { stopAll } from '../tools/process';
import { denyAllForRun } from '../tools/approvals';
import { listForPrompt, writeFile } from '../tools/fs';
import { getProject, saveProject } from '../projects/projects';
import { ROLES, ACTION_PROTOCOL } from './roles';
import { RunContext, type ArchitectureSpec } from './runContext';
import { callJson, callText, fsCtx, runAgentLoop } from './runtime';
import { findingsForPrompt, runResearch } from './research';
import { readScopeFiles, runReview, runTestGates, runVisualQA, stopDevServer, type GateFailure } from './verify';
import { loadCheckpoint } from '../core/checkpoint';
import { analyzeTaskInvalidation, applyInvalidation, isRunResumable } from '../core/invalidation';
import { createHash } from 'node:crypto';
import type { ErrorCategory } from '../../shared/types';
import { defaultSettings } from '../../shared/settings';
import { instructionOf, MODE_LIMITS, selectExecutionMode } from './strategy';
import { BudgetExceededError, errorCategory, isPermanent } from './errors';
import { staticCheck } from './staticChecks';
import { isTerminal } from './taskState';
import { computeReadiness, readinessHeadline, readinessMarkdown } from '../core/readiness';
import { listApprovals } from '../tools/approvals';

const active = new Map<string, RunContext>();
export const activeRun = (runId: string) => active.get(runId) ?? null;
export const activeRunForProject = (projectId: string) => [...active.values()].find((c) => c.project.id === projectId) ?? null;
export const listActiveRuns = () => [...active.values()].map((c) => c.run);

// ------------------------------------------------------------------ schemas
const BriefSchema = z.object({
  title: z.string().min(2).max(80),
  projectType: z.enum(['web_app', 'desktop_app', 'mobile_app', 'cli_tool', 'backend_service', 'api_service', 'library', 'research', 'fix', 'analysis', 'design', 'automation', 'script']),
  platform: z.enum(['web', 'windows', 'macos', 'linux', 'android', 'ios', 'cli', 'backend', 'api', 'library', 'desktop', 'mobile']).nullable().default(null),
  summary: z.string().min(10),
  requirements: z.array(z.string()).min(1).max(20),
  agents: z.array(z.string()).default([]),
  researchQueries: z.array(z.string()).default([]),
  stackHint: z.string().default(''),
});

const PlanSchema = z.object({
  tasks: z.array(z.object({
    key: z.string().min(1),
    title: z.string().min(2),
    role: z.string(),
    description: z.string().default(''),
    deps: z.array(z.string()).default([]),
    scope: z.array(z.string()).default([]),
    queries: z.array(z.string()).default([]),
    priority: z.number().int().optional(),
    requiredCapabilities: z.array(z.enum(['chat', 'coding', 'reasoning', 'vision', 'tools', 'long_context', 'fast'])).optional(),
    producedArtifacts: z.array(z.string()).optional(),
    consumedArtifacts: z.array(z.string()).optional(),
  })).min(1),
});

const ArchSchema = z.object({
  targetPlatform: z.string().optional(),
  buildSystem: z.string().default(''),
  launchCommand: z.string().default(''),
  previewStrategy: z.string().default(''),
  testStrategy: z.string().default(''),
  packagingStrategy: z.string().default(''),
  stack: z.string(),
  summary: z.string().default(''),
  runtime: z.string().min(1),
  commands: z.object({ install: z.string().optional(), dev: z.string().optional(), build: z.string().optional(), test: z.string().optional(), typecheck: z.string().optional(), lint: z.string().optional() }).partial().default({}),
  files: z.array(z.object({ path: z.string(), purpose: z.string().default('') })).default([]),
  api: z.array(z.object({ method: z.string().default('GET'), path: z.string(), description: z.string().default('') })).default([]),
  conventions: z.array(z.string()).default([]),
  packageJson: z.record(z.string(), z.unknown()).nullable().optional(),
});

const PLANNABLE: AgentRole[] = ['researcher', 'designer', 'architect', 'coder', 'optimizer'];
const KIND_OF: Partial<Record<AgentRole, TaskKind>> = { researcher: 'research', designer: 'design', architect: 'architecture', coder: 'code', optimizer: 'optimize' };
const SOFT_DEPS: TaskKind[] = ['test', 'visual_qa', 'review', 'finalize'];

// ------------------------------------------------------------------ public API
export function startRun(projectId: string, objective: string, options: Partial<RunOptions> = {}): Run {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  if (activeRunForProject(projectId)) throw new Error('A run is already active for this project');
  const previous = project.lastRunId ? db().get<Run>('runs', project.lastRunId)?.brief?.platform : null;
  const target = resolveTarget(objective, previous ?? projectTarget(project.path));
  const settings = getSettings();
  const run: Run = {
    target,
    id: uid('run_'), projectId, objective: objective.trim(), status: 'running', startedAt: Date.now(), endedAt: null, summary: null, brief: null,
    gates: [], previewUrl: null, repairCycles: 0,
    options: {
      webResearch: options.webResearch ?? project.settings.webResearch ?? settings.research.defaultOn,
      autonomy: options.autonomy ?? project.settings.autonomy ?? settings.behavior.autonomy,
      attachments: options.attachments ?? [], pinnedModel: options.pinnedModel ?? null,
    },
    stats: { tasks: 0, completed: 0, failed: 0, modelCalls: 0, fallbacks: 0, tokens: 0, files: 0, commands: 0, sources: 0 },
  };
  const ctx = new RunContext(run, project, settings);
  active.set(run.id, ctx);
  ctx.saveRun();
  project.status = 'running'; project.lastRunId = run.id; project.objective = project.objective || run.objective;
  if (!project.memory.objective) project.memory.objective = run.objective;
  saveProject(project);
  emit('RUN_STARTED', `Run started: ${truncate(run.objective, 140)}`, ctx.scope(), 'info', { run });
  void execute(ctx).finally(()=>finishManagedOperation(ctx.run.id,ctx.run.status==='completed'));
  return run;
}

export function cancelRun(runId: string): boolean {
  const ctx = active.get(runId);
  if (!ctx) return false;
  if (process.env.SWARM_DEBUG_CANCEL) console.log('[cancelRun]', new Error().stack);
  emit('RUN_CANCELLED', 'Stopping: cancelling agents, model requests, processes and browser sessions', ctx.scope(), 'warning');
  ctx.ctrl.abort();
  denyAllForRun(runId);
  stopAll((e) => e.runId === runId);
  void import('../runtime/manager').then(m => m.runtimeManager.disposeRun(runId));
  // Stop any active live run chat streams for this run
  import('../chat/liveRunChat').then(({ stopAllRunChats }) => stopAllRunChats(runId)).catch(() => undefined);
  return true;
}

export function pauseRun(runId: string): boolean {
  const ctx = activeRun(runId);
  if (!ctx || ctx.run.status !== 'running') return false;
  ctx.run.status = 'paused';
  ctx.saveRun();
  emit('RUN_PAUSED', 'Paused: in-flight operations may finish; no new tasks will start', ctx.scope(), 'info', { run: ctx.run });
  return true;
}

export function controlAgent(runId: string, role: AgentRole, operation: 'stop' | 'resume'): boolean {
  const ctx = activeRun(runId);
  if (!ctx) return false;
  if (operation === 'stop') {
    ctx.suspendedAgents.add(role);
    for (const task of ctx.tasks.values()) if (task.role === role) ctx.taskControllers.get(task.id)?.abort();
    stopAll(e => e.runId === runId && e.agent === role);
    ctx.touchAgent(role, { status: 'waiting', lastAction: 'Stopped by user; waiting to continue' });
  } else {
    ctx.suspendedAgents.delete(role);
    ctx.touchAgent(role, { status: 'waiting', lastAction: 'Resuming assigned tasks' });
  }
  ctx.wakeExecution(); ctx.saveRun();
  return true;
}

export function resumeRun(runId: string): Run {
  const live = activeRun(runId);
  if (live && live.run.status === 'paused') {
    live.run.status = 'running';
    live.saveRun();
    live.wakeExecution();
    emit('RUN_RESUMED', 'Execution resumed from the current checkpoint', live.scope(), 'info', { run: live.run });
    return live.run;
  }
  const snapshot = runSnapshot(runId);
  if (!snapshot) throw new Error('Run not found');
  
  // Check if run is resumable
  const resumeCheck = isRunResumable(runId, snapshot.run.status);
  if (!resumeCheck.resumable) {
    throw new Error(`Cannot resume: ${resumeCheck.reason}`);
  }
  
  const project = getProject(snapshot.run.projectId);
  if (!project) throw new Error('Project not found');
  if (activeRunForProject(project.id)) throw new Error('This project already has an active run');
  
  // Explicit resume: the repair budget and time/token budgets apply to this execution, not the interrupted one.
  const ctx = new RunContext({ ...snapshot.run, status: 'running', endedAt: null, summary: null, repairBase: snapshot.run.repairCycles }, project, getSettings());
  
  // Load checkpoint with enhanced state
  const checkpoint = loadCheckpoint(runId);
  if (checkpoint) {
    ctx.architecture = checkpoint.architecture;
    ctx.design = checkpoint.design;
    ctx.notes = new Map(checkpoint.notes);
    ctx.sourceCounter = checkpoint.sourceCounter;
    
    // Restore agent states
    for (const [role, agentState] of Object.entries(checkpoint.agents)) {
      ctx.agents.set(role as AgentRole, agentState);
    }
    
    emit('CHECKPOINT_LOADED', `Restored checkpoint with ${Object.keys(checkpoint.taskFingerprints).length} task fingerprints`, 
      ctx.scope(), 'info', { 
        taskCount: Object.keys(checkpoint.taskFingerprints).length,
        checkpointAge: Date.now() - checkpoint.checkpointedAt,
      });
  } else if (snapshot.tasks.some(t => t.kind === 'architecture' && t.status === 'completed')) {
    throw new Error('This older run has no checkpoint. Start a new run.');
  }
  
  // Load tasks into context
  for (const task of snapshot.tasks) {
    ctx.tasks.set(task.id, task);
  }
  
  // Analyze task invalidation
  const invalidation = analyzeTaskInvalidation(
    runId,
    ctx.tasks,
    ctx.root,
    ctx.architecture,
    ctx.design,
  );
  
  // Apply invalidation results
  const { skipped, rerun } = applyInvalidation(ctx.tasks, invalidation, project.id, runId);
  
  // Persist updated task states
  for (const task of ctx.tasks.values()) {
    ctx.persistTask(task);
  }
  for (const role of new Set([...ctx.tasks.values()].map(t => t.role))) {
    const mine = [...ctx.tasks.values()].filter(t => t.role === role && !['skipped', 'cancelled'].includes(t.status));
    ctx.touchAgent(role, { status: mine.some(t => t.status === 'waiting') ? 'waiting' : mine.length > 0 && mine.every(t => t.status === 'completed') ? 'completed' : 'idle', taskId: null, taskTitle: null });
  }
  
  // Load research data
  ctx.messages.push(...snapshot.messages as import('../../shared/types').AgentMessage[]);
  ctx.sources = db().list('sources', 'run_id = ?', [runId], 'ts ASC');
  ctx.findings = db().list('findings', 'run_id = ?', [runId], 'ts ASC');
  
  active.set(runId, ctx);
  ctx.saveRun();
  project.status = 'running';
  saveProject(project);
  
  emit('RUN_RESUMED', `Resuming: ${skipped} tasks skipped, ${rerun} tasks queued for re-execution`, 
    ctx.scope(), 'info', { 
      skipped, 
      rerun,
      totalTasks: ctx.tasks.size,
    });
  
  void execute(ctx, true);
  return ctx.run;
}

export function runSnapshot(runId: string) {
  const ctx = active.get(runId);
  if (ctx) return { run: ctx.run, tasks: [...ctx.tasks.values()], agents: [...ctx.agents.values()], messages: ctx.messages.slice(-200), live: true };
  const run = db().get<Run>('runs', runId);
  if (!run) return null;
  const tasks = db().list<Task>('tasks', 'run_id = ?', [runId], 'created_at ASC');
  const messages = db().list('messages', 'run_id = ?', [runId], 'ts ASC', 500);
  // Reconstruct final agent states from tasks.
  const agents: AgentState[] = AGENT_ROLES.filter((r) => tasks.some((t) => t.role === r)).map((role): AgentState => {
    const ts = tasks.filter((t) => t.role === role);
    const last = ts[ts.length - 1];
    return {
      role, status: ts.some(t => t.status === 'running') ? (run.status === 'running' ? 'working' : 'waiting') : ts.some(t => t.status === 'waiting' || t.status === 'ready') ? 'waiting' : ts.some(t => t.status === 'blocked') ? 'blocked' : ts.some((t) => t.status === 'failed') && !ts.some((t) => t.status === 'completed' && t.createdAt > (ts.find((x) => x.status === 'failed')?.createdAt ?? 0)) ? 'failed' : ts.some(t => t.status === 'completed') ? 'completed' : 'idle',
      taskId: last.id, taskTitle: last.title, modelId: last.modelId, lastAction: last.output?.slice(0, 120) ?? null,
      tasksDone: ts.filter((t) => t.status === 'completed').length, errors: ts.filter((t) => t.status === 'failed').length,
      tokens: ts.reduce((n, t) => n + t.tokens, 0), filesTouched: [...new Set(ts.flatMap((t) => t.filesTouched))], updatedAt: last.endedAt ?? last.createdAt,
    };
  });
  return { run, tasks, agents, messages, live: false };
}

export function cancelAll() { for (const id of active.keys()) cancelRun(id); }

// ------------------------------------------------------------------ execution
async function execute(ctx: RunContext, resumed = false) {
  try {
    if (!resumed) {
      const existingFiles = fs.readdirSync(ctx.root).some(f => !f.startsWith('.'));
      // Deterministic policy: no model call is spent on deciding how much orchestration to use.
      const decision = selectExecutionMode(ctx.run.objective, { existingFiles, attachments: ctx.run.options.attachments.length, webResearch: ctx.run.options.webResearch });
      ctx.setMode(decision.mode, decision.reason);
      ctx.strategy = decision;
      emit('GRAPH_UPDATED', `Execution mode: ${decision.mode} — ${decision.reason}`, ctx.scope('manager'), 'info', { mode: decision.mode, reason: decision.reason });
      if (decision.mode === 'simple') buildSimpleGraph(ctx, existingFiles);
      else {
        const manager = ctx.addTask({ key: 'understand', title: 'Understand objective', description: ctx.run.objective, role: 'manager', kind: 'plan', deps: [], scope: [] });
        ctx.addTask({ key: 'decompose', title: 'Build task graph', description: decision.mode === 'standard' ? 'Create the standard task graph from the brief (no planner model call)' : 'Decompose into an executable, parallel task graph', role: 'planner', kind: 'decompose', deps: [manager.id], scope: [] });
      }
    }
    await executeGraph(ctx);
    if (ctx.signal.aborted) throw new CancelledError();
    const missing = missingEvidence(ctx.run.target!, ctx.run.gates);
    const failedGates = ctx.run.gates.filter(g => g.status === 'failed');
    const fatal = [...ctx.tasks.values()].find((t) => (t.kind === 'plan' || t.kind === 'decompose') && t.status === 'failed');
    if (ctx.halt) {
      // Stopped promptly because no provider can do the work (or a hard budget was hit): say exactly why.
      ctx.run.status = 'failed';
      ctx.run.summary = ctx.halt.message;
    } else if (fatal) {
      ctx.run.status = 'failed';
      ctx.run.summary = ctx.run.summary ?? `Could not plan the run: ${fatal.error}`;
    } else ctx.run.status = missing.length || failedGates.length || [...ctx.tasks.values()].some(t => (t.status === 'failed' && !['test', 'visual_qa', 'review'].includes(t.kind)) || (['waiting', 'ready', 'running', 'verifying', 'retry_wait', 'blocked'].includes(t.status)) || (t.status === 'skipped' && !t.error?.startsWith('Superseded by'))) || !ctx.run.gates.some(g => g.status === 'passed') ? 'attention' : 'completed';
    if (missing.length && !ctx.halt) ctx.run.summary = `${ctx.run.summary ?? ''}\nNot verified: ${missing.join(', ')}.`.trim();
    ctx.run.readiness = computeReadiness({ target: ctx.run.target, objective: ctx.run.objective, gates: ctx.run.gates, tasks: [...ctx.tasks.values()] });
    ctx.setPhase(ctx.run.status === 'completed' ? 'done' : ctx.halt || ctx.run.status === 'attention' ? 'blocked' : 'done');
    ctx.run.endedAt = Date.now();
    ctx.saveRun();
    const secs = Math.round((ctx.run.endedAt - ctx.run.startedAt) / 1000);
    const evidence = readinessHeadline(ctx.run.readiness);
    if (ctx.run.status === 'completed') {
      // "Completed" means every executed gate passed and the target's required runtime evidence exists — not production-ready.
      emit('RUN_COMPLETED', `Run finished in ${fmtDuration(secs)}: ${evidence}`, ctx.scope(), 'success', { run: ctx.run });
      notify('complete', 'success', 'Run finished', `${ctx.project.name}: ${evidence}${ctx.run.previewUrl ? ` Preview: ${ctx.run.previewUrl}` : ''}`, ctx.scope());
    } else if (ctx.run.status === 'attention') {
      const why = failedGates.length ? `${failedGates.length} unresolved gate(s): ${failedGates.map((g) => g.label).join(', ')}` : ctx.progress.blocker?.text ?? 'required verification is incomplete';
      emit('RUN_COMPLETED', `Run finished in ${fmtDuration(secs)} with ${why}. ${evidence}`, ctx.scope(), 'warning', { run: ctx.run });
      notify('attention', 'warning', 'Needs attention', `${ctx.project.name}: ${why}`, ctx.scope());
    } else {
      emit('RUN_FAILED', `Run failed: ${ctx.run.summary}`, ctx.scope(), 'error', { run: ctx.run });
      notify('fail', 'error', 'Run failed', ctx.run.summary ?? 'See logs', ctx.scope());
    }
  } catch (e) {
    ctx.run.endedAt = Date.now();
    if (e instanceof CancelledError || ctx.signal.aborted) {
      ctx.run.status = 'cancelled';
      ctx.run.summary = 'Cancelled by user';
      for (const t of ctx.tasks.values()) if (!isTerminal(t.status)) ctx.updateTask(t, { status: 'cancelled', endedAt: Date.now() });
      for (const g of ctx.run.gates) if (g.status === 'running' || g.status === 'pending') { g.status = 'skipped'; g.detail = 'Cancelled'; }
      stopDevServer(ctx);
      emit('RUN_CANCELLED', 'Run cancelled. All agents, processes and browser sessions stopped.', ctx.scope(), 'warning', { run: ctx.run });
    } else {
      ctx.run.status = 'failed';
      ctx.run.summary = errMsg(e);
      emit('RUN_FAILED', `Run failed: ${errMsg(e)}`, ctx.scope(), 'error', { run: ctx.run });
      notify('fail', 'error', 'Run failed', errMsg(e).slice(0, 200), ctx.scope());
    }
    ctx.saveRun();
  } finally {
    for (const [role, a] of ctx.agents) if (a.status === 'working' || a.status === 'planning' || a.status === 'waiting' || a.status === 'blocked') ctx.touchAgent(role, { status: ctx.run.status === 'cancelled' ? 'idle' : a.status === 'waiting' ? 'idle' : 'completed' });
    const p = getProject(ctx.project.id);
    if (p) {
      p.status = ctx.run.status === 'completed' ? 'completed' : ctx.run.status === 'cancelled' ? 'idle' : ctx.run.status === 'attention' ? 'attention' : 'failed';
      p.lastRunId = ctx.run.id;
      if (ctx.run.brief && (p.name === 'Untitled project' || p.name.length > 50)) p.name = ctx.run.brief.title;
      saveProject(p);
    }
    ctx.stopHeartbeat();
    active.delete(ctx.run.id);
  }
}

async function executeGraph(ctx: RunContext) {
  const running = new Map<string, Promise<void>>();
  const terminal = (s: Task['status']) => s === 'completed' || s === 'failed' || s === 'skipped' || s === 'cancelled';
  
  // Emit status for skipped tasks at start
  for (const t of ctx.tasks.values()) {
    if (t.status === 'skipped' && t.error?.startsWith('Skipped:')) {
      emit('TASK_SKIPPED', `${ROLES[t.role].name}: ${t.title} — ${t.error}`, 
        ctx.scope(t), 'info', { task: t });
    }
  }
  
  for (;;) {
    if (ctx.signal.aborted) break;
    await ctx.waitUntilResumed();
    if (ctx.signal.aborted) break;
    const endSchedule = timeOperation('schedule', ctx.run.id);
    // Concurrency is bounded by settings and by mode: a simple run never fans out.
    const limit = !ctx.settings.behavior.parallel || ctx.run.mode === 'simple' ? 1 : ctx.settings.agents.maxConcurrent;
    // Propagate hard-dependency failures.
    for (const t of ctx.tasks.values()) {
      if (t.status !== 'waiting' || SOFT_DEPS.includes(t.kind)) continue;
      const bad = t.deps.map((d) => ctx.tasks.get(d)).find((d) => d && (d.status === 'failed' || d.status === 'cancelled' || d.status === 'skipped'));
      if (bad) ctx.updateTask(t, { status: 'skipped', error: `Dependency failed: ${bad.title}`, endedAt: Date.now() }, { type: 'TASK_UPDATED', message: `Skipped ${t.title}: dependency "${bad.title}" failed`, level: 'warning' });
    }
    // A halted run dispatches nothing new; queued work is reported as blocked by the actual cause.
    if (ctx.halt) {
      for (const t of ctx.tasks.values()) if (t.status === 'waiting' || t.status === 'ready' || t.status === 'retry_wait') ctx.updateTask(t, { status: 'blocked', blocker: ctx.halt.message, errorCategory: ctx.halt.category }, { type: 'TASK_UPDATED', message: `Blocked ${t.title}: ${ctx.halt.message.slice(0, 160)}`, level: 'warning' });
    }
    const ready = ctx.halt ? [] : readyTasks(ctx.tasks, SOFT_DEPS);
    for (const t of ready) {
      if (running.size >= limit) break;
      if (ctx.suspendedAgents.has(t.role)) continue;
      if (running.has(t.id) || ctx.executing.has(t.id)) continue; // duplicate-execution guard
      const executing = [...running.keys()].map(id => ctx.tasks.get(id)!).filter(Boolean);
      const writer = (task: Task) => ['code', 'optimize', 'repair', 'agent_request'].includes(task.kind);
      if (executing.some(other => writer(t) && writer(other) && scopesOverlap(t.scope, other.scope))) continue;
      if (executing.some(other => other.role === t.role) && !(writer(t) && t.scope.length)) continue;
      const p = runTask(ctx, t).finally(() => running.delete(t.id));
      running.set(t.id, p);
    }
    endSchedule();
    if (!running.size) {
      if (ctx.pendingChanges > 0) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      const waitingOn = [...ctx.tasks.values()].some(t => (ctx.suspendedAgents.has(t.role) && !terminal(t.status)) || t.status === 'retry_wait');
      if (waitingOn && !ctx.halt) {
        const suspended = ctx.executionWake();
        try { await suspended.promise; } finally { suspended.dispose(); }
        continue;
      }
      markDeadlocked(ctx);
      break;
    }
    const wake = ctx.executionWake();
    try { await Promise.race([...running.values(), wake.promise]); } finally { wake.dispose(); }
  }
  await Promise.allSettled(running.values());
}

/** Nothing is running and nothing can start: name the real blocker of every queued task instead of silently stopping. */
function markDeadlocked(ctx: RunContext) {
  const stuck = [...ctx.tasks.values()].filter(t => t.status === 'waiting' || t.status === 'ready');
  if (!stuck.length) return;
  let cycle: string | null = null;
  try { validateGraph(stuck.map(t => ({ key: t.id, deps: t.deps.filter(d => stuck.some(s => s.id === d)) }))); }
  catch (e) { cycle = errMsg(e); }
  for (const t of stuck) {
    const missing = t.deps.filter(d => !ctx.tasks.has(d));
    const open = t.deps.map(d => ctx.tasks.get(d)).filter((d): d is Task => !!d && d.status !== 'completed' && !(SOFT_DEPS.includes(t.kind) && isTerminal(d.status)));
    const reason = cycle && open.some(d => stuck.includes(d)) ? `Dependency cycle: ${cycle}`
      : missing.length ? `Missing dependency ${missing.join(', ')}`
        : open.length ? `Waiting on ${open.map(d => `"${d.title}" (${d.status}${d.blocker ? `: ${d.blocker}` : ''})`).join(', ')}`
          : 'Ready but could not be dispatched';
    ctx.updateTask(t, { status: 'blocked', blocker: reason, errorCategory: 'no_progress' }, { type: 'TASK_UPDATED', message: `Blocked ${t.title}: ${reason.slice(0, 200)}`, level: 'warning' });
  }
  emit('RUN_STALLED', `Execution cannot continue: ${stuck.length} queued task(s) are blocked. ${stuck[0].blocker ?? ''}`, ctx.scope(), 'warning', { blockers: stuck.map(t => ({ id: t.id, title: t.title, blocker: t.blocker })) });
}

const limits = (ctx: RunContext) => ctx.settings.limits ?? defaultSettings().limits;
/** A run-wide stop: further tasks would fail for the same reason, so stop now and explain. */
const HALTING: ErrorCategory[] = ['no_provider', 'auth', 'quota', 'budget'];

async function runTask(ctx: RunContext, t: Task) {
  // Duplicate-execution guard: one worker per task, and only from a dispatchable state.
  if (ctx.executing.has(t.id) || !(t.status === 'waiting' || t.status === 'ready')) return;
  ctx.executing.add(t.id);
  try { await runTaskOnce(ctx, t); }
  catch (e) {
    if (e instanceof CancelledError || ctx.signal.aborted) throw e;
    // An engine error must never leave a task "running" with no worker: record it as an internal failure.
    if (!isTerminal(t.status)) ctx.updateTask(t, { status: 'failed', error: `Internal engine error: ${errMsg(e)}`, errorCategory: 'internal', endedAt: Date.now() }, { type: 'TASK_FAILED', message: `${ROLES[t.role].name} failed: ${t.title} — internal error: ${errMsg(e).slice(0, 200)}`, level: 'error' });
  } finally { ctx.executing.delete(t.id); }
}

async function runTaskOnce(ctx: RunContext, t: Task) {
  const controller = new AbortController();
  ctx.taskControllers.set(t.id, controller);
  const taskSignal = AbortSignal.any([ctx.signal, controller.signal]);
  const scoped = new Proxy(ctx, { get(target, key, receiver) { return key === 'signal' ? taskSignal : Reflect.get(target, key, receiver); } });
  const def = ROLES[t.role];
  const firstActivation = !ctx.agents.get(t.role) || ctx.agents.get(t.role)!.status === 'waiting' && ctx.agents.get(t.role)!.tasksDone === 0;
  if (!ctx.updateTask(t, { status: 'running', startedAt: Date.now(), blocker: null, retryAt: null }, { type: 'TASK_STARTED', message: `${def.name} started: ${t.title}` })) { ctx.taskControllers.delete(t.id); return; }
  if (firstActivation) emit('AGENT_STARTED', `${def.name} activated`, ctx.scope(t), 'debug', { role: t.role });
  ctx.touchAgent(t.role, { status: t.role === 'manager' || t.role === 'planner' ? 'planning' : 'working', taskId: t.id, taskTitle: t.title, lastAction: t.title });
  // Task wall-clock timeout. Time spent waiting for the user's approval does not count as a stall.
  const timeoutMs = limits(ctx).taskMinutes * 60_000;
  let timer: NodeJS.Timeout | null = null;
  const arm = (ms: number) => {
    timer = setTimeout(() => {
      if (listApprovals().some(a => a.runId === ctx.run.id)) { arm(30_000); return; }
      controller.abort(new BudgetExceededError(`"${t.title}" exceeded its ${limits(ctx).taskMinutes}-minute time limit (Settings › Limits).`));
    }, ms);
    timer.unref?.();
  };
  arm(timeoutMs);
  try {
    const output = await HANDLERS[t.kind](scoped, t);
    if (ctx.signal.aborted) throw new CancelledError();
    if (controller.signal.reason instanceof BudgetExceededError) throw controller.signal.reason;
    if (t.status !== 'running') { if (!t.output) ctx.updateTask(t, { output: output.slice(0, 4000) }); return; }
    ctx.updateTask(t, { status: 'completed', output: output.slice(0, 4000), endedAt: Date.now() }, { type: 'TASK_COMPLETED', message: `${def.name} completed: ${t.title}`, level: 'success' });
    const a = ctx.agents.get(t.role);
    const stillBusy = [...ctx.tasks.values()].some((x) => x.role === t.role && x.status === 'running' && x.id !== t.id);
    ctx.touchAgent(t.role, { status: stillBusy ? 'working' : 'completed', tasksDone: (a?.tasksDone ?? 0) + 1, lastAction: output.split('\n')[0].slice(0, 140) });
    if (ctx.settings.memory.agent) ctx.note(t.role, `${t.title}: ${output.split('\n')[0].slice(0, 200)}`);
  } catch (raw) {
    const e = controller.signal.reason instanceof BudgetExceededError ? controller.signal.reason : raw;
    if (controller.signal.aborted && !ctx.signal.aborted && !(e instanceof BudgetExceededError)) {
      ctx.updateTask(t, { status: 'waiting', error: 'Stopped by user; waiting to continue', endedAt: null });
      ctx.touchAgent(t.role, { status: 'waiting', lastAction: 'Stopped by user; waiting to continue' });
      return;
    }
    if (e instanceof CancelledError || ctx.signal.aborted) throw new CancelledError();
    const category = errorCategory(e);
    // Cooldown-only failure: wait for the provider's own retry time instead of cycling through failing models.
    if (e instanceof NoModelError && e.retryAt && (category === 'rate_limit' || category === 'quota') && waitForRetry(ctx, t, e, category)) return;
    if (t.kind === 'decompose' && !(e instanceof NoModelError) && !isPermanent(category)) {
      // Planner output unusable after model fallbacks: use the standard pipeline template (clearly logged).
      emit('GRAPH_UPDATED', 'Planner output could not be validated; using SWARM\'s standard pipeline template', ctx.scope(t), 'warning');
      const hasGraph = [...ctx.tasks.values()].some(x => x.kind === 'code' || x.kind === 'finalize');
      if (!hasGraph) {
        ctx.recordRecovery({ taskId: t.id, attempt: 1, maxAttempts: 1, category, reason: errMsg(e), strategy: 'Use the deterministic standard task graph instead of re-asking the planner' });
        templatePlan(ctx, t);
        ctx.updateTask(t, { status: 'completed', output: 'Standard pipeline template applied', endedAt: Date.now() }, { type: 'TASK_COMPLETED', message: 'Planner: standard task graph created', level: 'success' });
        ctx.touchAgent(t.role, { status: 'completed' });
        return;
      }
    }
    // Completed work is preserved: files already written stay on disk and in filesTouched.
    ctx.updateTask(t, { status: 'failed', error: errMsg(e), errorCategory: category, endedAt: Date.now() }, { type: 'TASK_FAILED', message: `${def.name} failed: ${t.title} — [${category}] ${errMsg(e).slice(0, 200)}`, level: 'error' });
    const a = ctx.agents.get(t.role);
    ctx.touchAgent(t.role, { status: 'failed', errors: (a?.errors ?? 0) + 1, lastAction: errMsg(e).slice(0, 140) });
    if ((e instanceof NoModelError && HALTING.includes(category)) || (e instanceof BudgetExceededError && e.scope === 'run')) {
      const why = e instanceof NoModelError
        ? category === 'quota' ? `Stopped: every eligible model's quota is exhausted${e.retryAt ? ` until about ${new Date(e.retryAt).toLocaleTimeString()}` : ''}. ${errMsg(e)}`
          : category === 'auth' ? `Stopped: the provider rejected the API key. Update it in Settings › Providers. ${errMsg(e)}`
            : `Stopped: no configured model can do this work. ${errMsg(e)}`
        : `Stopped: ${errMsg(e)}`;
      ctx.halt = { message: why, category };
      ctx.setBlocker(why, category);
      notify('blocked', 'error', 'SWARM stopped', why.slice(0, 200), ctx.scope());
    }
    if (t.kind === 'plan' || t.kind === 'decompose') {
      ctx.run.summary = e instanceof NoModelError ? `No free model could be reached. ${errMsg(e)}` : errMsg(e);
      notify('blocked', 'error', 'SWARM is blocked', ctx.run.summary.slice(0, 200), ctx.scope());
    }
  } finally { if (timer) clearTimeout(timer); ctx.taskControllers.delete(t.id); }
}

/** Put a task into RETRY_WAIT until the provider cooldown ends. Bounded by Settings › Limits › retry waits. */
function waitForRetry(ctx: RunContext, t: Task, e: NoModelError, category: ErrorCategory): boolean {
  const max = limits(ctx).retryWaits;
  const used = t.retryWaits ?? 0;
  const delay = Math.max(1000, (e.retryAt ?? Date.now()) - Date.now() + 500);
  if (used >= max || delay > 10 * 60_000) return false;
  const until = Date.now() + delay;
  const blocker = `Waiting for provider cooldown until ${new Date(until).toLocaleTimeString()} (${category.replace('_', ' ')})`;
  ctx.updateTask(t, { status: 'retry_wait', retryAt: until, retryWaits: used + 1, blocker, errorCategory: category, error: errMsg(e) }, { type: 'TASK_UPDATED', message: `${ROLES[t.role].name}: ${blocker}`, level: 'warning' });
  ctx.touchAgent(t.role, { status: 'waiting', lastAction: blocker });
  ctx.recordRecovery({ taskId: t.id, attempt: used + 1, maxAttempts: max, category, reason: errMsg(e), strategy: `Wait ${Math.round(delay / 1000)} s for the provider's retry window, then resume with the same context` });
  const timer = setTimeout(() => {
    ctx.retryTimers.delete(t.id);
    if (t.status === 'retry_wait' && !ctx.signal.aborted) ctx.updateTask(t, { status: 'waiting', blocker: null }, { type: 'TASK_UPDATED', message: `${ROLES[t.role].name}: cooldown over, retrying ${t.title}` });
    ctx.wakeExecution();
  }, delay);
  timer.unref?.();
  ctx.retryTimers.set(t.id, timer);
  return true;
}

// ------------------------------------------------------------------ context building (scoped memory)
function briefBlock(ctx: RunContext): string {
  const b = ctx.run.brief;
  if (!b) return `Objective: ${ctx.run.objective}`;
  return `Objective: ${ctx.run.objective}\nProject: ${b.title} (${b.projectType})\nSummary: ${b.summary}\nRequirements:\n${b.requirements.map((r) => `- ${r}`).join('\n')}`;
}

function depOutputs(ctx: RunContext, t: Task, max = 2500): string {
  const out = t.deps.map((d) => ctx.tasks.get(d)).filter((d) => d?.output).map((d) => `[${ROLES[d!.role].name}: ${d!.title}] ${d!.output!.slice(0, 700)}`).join('\n');
  return out.slice(0, max);
}

function inboxBlock(ctx: RunContext, role: AgentRole): string {
  const msgs = ctx.inbox(role);
  return msgs.length ? msgs.map((m) => `- from ${ROLES[m.from].name}: ${m.content.slice(0, 300)}`).join('\n') : '';
}

function archBlock(ctx: RunContext): string {
  const a = ctx.architecture;
  if (!a) return '';
  return `Stack: ${a.stack}\n${a.summary}\nCommands: ${JSON.stringify(a.commands)}\nFiles:\n${a.files.map((f) => `- ${f.path}: ${f.purpose}`).join('\n')}\nAPI:\n${a.api.map((x) => `- ${x.method} ${x.path}: ${x.description}`).join('\n') || '- (none)'}\nConventions:\n${a.conventions.map((c) => `- ${c}`).join('\n')}`;
}

function sections(parts: [string, string][]): string {
  return parts.filter(([, v]) => v && v.trim()).map(([k, v]) => `## ${k}\n${v.trim()}`).join('\n\n');
}

/** Agent step ceiling: the lower of the user's setting and the execution mode's limit. */
function modeSteps(ctx: RunContext) {
  return Math.min(ctx.settings.agents.maxSteps, MODE_LIMITS[ctx.run.mode ?? 'complex'].maxSteps);
}

function contextBudget(ctx: RunContext) {
  return ({ minimal: { design: 1200, findings: 8 }, balanced: { design: 3500, findings: 18 }, rich: { design: 7000, findings: 30 } } as const)[ctx.settings.behavior.context];
}

// ------------------------------------------------------------------ handlers
type Handler = (ctx: RunContext, t: Task) => Promise<string>;

const HANDLERS: Record<TaskKind, Handler> = {
  async agent_request(ctx, t) {
    const role = ROLES[t.role];
    const result = await runAgentLoop(ctx, t,
      `You are the SWARM ${role.name}. ${role.description} Carry out the user's direct instruction using real tools. Inspect existing files before editing. Report only verified results.\n${ACTION_PROTOCOL}`,
      sections([['User instruction', t.description], ['Project', ctx.run.objective], ['Architecture', archBlock(ctx)], ['Live inbox', inboxBlock(ctx, t.role)], ['Files', await listForPrompt(ctx.root, 150)]]));
    if (!result.completed) throw new Error('The direct agent request reached its step limit and remains incomplete.');
    ctx.message(t.role, 'manager', `Direct request completed: ${result.summary.slice(0, 400)}`, t.id, 'COMPLETION');
    return result.summary;
  },
  // MANAGER — understand objective, decide agents.
  async plan(ctx, t) {
    const s = ctx.settings;
    ctx.touchAgent('manager', { status: 'working', lastAction: `Resolving ${ctx.run.target} toolchain` });
    const cached = peekToolchains();
    const tools = cached ? getAvailableToolchains(cached) : [];
    void getCachedToolchains().then(registry => {
      if (!ctx.signal.aborted && ctx.run.status === 'running') ctx.message('manager', 'all', 'Toolchain discovery: ' + getAvailableToolchains(registry).join(', '));
    }).catch(() => undefined);
    if (ctx.signal.aborted) throw new CancelledError();
    ctx.message('manager', 'all', `Target: ${ctx.run.target}. Available toolchains: ${tools.join(', ') || 'none detected'}.`);
    const enabled = AGENT_ROLES.filter((r) => s.agents.enabled[r] !== false);
    const tree = await listForPrompt(ctx.root, 120);
    const mem = ctx.project.memory;
    const memory = s.memory.project && mem.summary ? `Previous work on this project:\n${mem.summary}\nLast outcome: ${mem.lastRunOutcome}\nUnresolved: ${mem.unresolved.join('; ') || 'none'}\nArchitecture: ${mem.architecture.slice(0, 600)}` : '';
    // Attachments: copied into the project (.swarm/attachments) so agents can <read> them; text content goes to the Manager.
    let attached = '';
    for (const file of ctx.run.options.attachments.slice(0, 8)) {
      try {
        const st = fs.statSync(file);
        const dest = path.join(ctx.root, '.swarm', 'attachments', path.basename(file));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (st.size <= 20 * 1024 * 1024) fs.copyFileSync(file, dest);
        const isText = /\.(txt|md|json|csv|js|ts|tsx|jsx|html|css|py|yml|yaml|xml|sql|env\.example)$/i.test(file) && st.size <= 100_000;
        attached += `\n- .swarm/attachments/${path.basename(file)} (${st.size} bytes)${isText ? `\n${truncate(fs.readFileSync(file, 'utf8'), 6000)}` : ''}`;
      } catch (e) { attached += `\n- ${path.basename(file)}: could not read (${errMsg(e)})`; }
    }
    const brief = await callJson(ctx, t,
      'You are the SWARM Manager, the lead of a team of AI agents that build real software on the user\'s machine. Understand the objective, determine the TARGET PLATFORM, and produce a concise brief. Choose the platform that the user explicitly requested or that naturally fits the objective. Do NOT default to web unless explicitly requested or clearly appropriate.',
      sections([
        ['Objective', ctx.run.objective],
        ['Resolved target and toolchains', `${ctx.run.target}; available tools: ${getAvailableToolchains(await getCachedToolchains()).join(', ')}. Target is fixed; report missing toolchains honestly.`],
        ['Existing project files', tree],
        ['Project memory', memory],
        ['Attached files', attached],
        ['Platform Detection Rules', [
          'WEB: websites, web apps, browser-based applications, responsive sites, React/Vue/Angular apps',
          'WINDOWS: Windows desktop applications, .exe files, WinUI, WPF, native Windows apps',
          'MACOS: macOS applications, .app bundles, SwiftUI, native Mac apps',
          'LINUX: Linux applications, GTK, Qt, native Linux desktop apps',
          'ANDROID: Android mobile apps, .apk files, Kotlin/Java Android apps',
          'IOS: iOS/iPhone/iPad apps, .ipa files, SwiftUI apps, App Store apps',
          'CLI: command-line tools, terminal applications, shell scripts, CLI utilities',
          'BACKEND: backend services, microservices, server-side applications (not web frontends)',
          'API: REST APIs, GraphQL APIs, HTTP APIs, web services',
          'LIBRARY: reusable libraries, packages, SDKs, npm/pip/nuget packages',
          'If the user says "desktop app" without specifying OS, choose based on their machine (Windows on Windows, macOS on Mac, Linux on Linux).',
          'If the user says "mobile app" without specifying, prefer Android (more open platform).',
          'NEVER convert "Windows app" into "web app". NEVER convert "Android app" into "website".',
        ].join('\n')],
        ['Constraints', `Web research is ${ctx.run.options.webResearch ? 'ENABLED' : 'DISABLED (do not include researcher)'}.\nAvailable agents: ${enabled.join(', ')}.\nResearch queries must be short, specific web-search phrases (3-7 words) about the subject matter, not about implementation.`],
        ['Output', `{"title":"short project name","projectType":"web_app|desktop_app|mobile_app|cli_tool|backend_service|api_service|library|research|fix|analysis|design|automation|script","platform":"web|windows|macos|linux|android|ios|cli|backend|api|library|desktop|mobile|null","summary":"2-3 sentences","requirements":["specific, testable requirement", "..."],"agents":["researcher","designer","architect","coder",...],"researchQueries":["specific web search query", "..."],"stackHint":"short stack suggestion for the detected platform"}\n\nSet "platform" to the detected target platform from the objective. Set to null only for non-build tasks (research, analysis). Give 5-12 requirements and up to ${s.research.maxQueries} research queries (empty if research is not needed).`],
      ]), BriefSchema, { purpose: 'plan', maxTokens: 3000, temperature: 0.2 });
    brief.platform = ctx.run.target!;
    brief.projectType = projectTypeFor(ctx.run.target!);
    let agents = [...new Set(brief.agents.map((a) => a.toLowerCase()).filter((a): a is AgentRole => (AGENT_ROLES as string[]).includes(a)))];
    if (!ctx.run.options.webResearch) { agents = agents.filter((a) => a !== 'researcher'); brief.researchQueries = []; }
    if (brief.researchQueries.length && ctx.run.options.webResearch && !agents.includes('researcher')) agents.push('researcher');
    // Add coder for build-type projects
    const buildTypes = ['web_app', 'desktop_app', 'mobile_app', 'cli_tool', 'backend_service', 'api_service', 'library', 'fix', 'automation', 'script', 'design'];
    if (buildTypes.includes(brief.projectType) && !agents.includes('coder')) agents.push('coder');
    agents = agents.filter((a) => s.agents.enabled[a] !== false && a !== 'manager' && a !== 'planner');
    if (!s.experimental.optimizer) agents = agents.filter((a) => a !== 'optimizer');
    if (ctx.run.mode === 'standard') {
      // Standard mode keeps only agents the objective actually needs; extra agents are not a substitute for good code.
      agents = agents.filter((a) => (a !== 'researcher' || !!ctx.strategy?.research) && (a !== 'designer' || !!ctx.strategy?.design) && a !== 'optimizer');
      if (!agents.includes('researcher')) brief.researchQueries = [];
      brief.researchQueries = brief.researchQueries.slice(0, 2);
    }
    const final: ManagerBrief = { ...brief, agents };
    ctx.setBrief(final);
    const platformInfo = brief.platform ? ` [Target: ${brief.platform}]` : '';
    ctx.message('manager', 'all', `Plan: ${final.summary}${platformInfo} Team: ${agents.map((a) => ROLES[a].name).join(', ')}.`, t.id);
    if (s.memory.project) {
      const p = getProject(ctx.project.id);
      if (p) { p.memory.decisions.push({ ts: Date.now(), text: `Brief: ${final.title} — ${final.projectType}; platform ${brief.platform || 'unknown'}; agents ${agents.join(', ')}` }); p.memory.decisions = p.memory.decisions.slice(-30); saveProject(p); }
    }
    return `${final.title}: ${final.summary}${platformInfo}`;
  },

  // PLANNER — executable task graph with parallel branches.
  async decompose(ctx, t) {
    const b = ctx.run.brief!;
    if (ctx.run.mode === 'standard') {
      // Standard mode: the Manager's brief is enough to build a small graph deterministically (no Planner call).
      templatePlan(ctx, t);
      const n = [...ctx.tasks.values()].length - 2;
      ctx.message('planner', 'manager', `Standard task graph ready: ${n} tasks.`, t.id);
      return `Created ${n} tasks (standard graph, no planner model call)`;
    }
    const roles = b.agents.filter((a) => PLANNABLE.includes(a));
    const plan = await callJson(ctx, t,
      'You are the SWARM Planner. Convert the brief into a small executable task graph (DAG). Maximize parallelism: tasks that do not depend on each other must have no deps between them. Testing, visual QA, review and finalization are added automatically — do NOT include them.',
      sections([
        ['Brief', briefBlock(ctx)],
        ['Research queries suggested', b.researchQueries.join('\n')],
        ['Allowed roles', roles.join(', ')],
        ['Rules', [
          '- Create as many tasks as the objective requires; use one coder for straightforward work. Keys are short kebab-case ids; deps reference keys.',
          '- researcher / designer / architect tasks normally run in PARALLEL first (no deps on each other).',
          '- Only for complex work, split implementation into 2-4 coder tasks with DISJOINT file scopes (e.g. backend/API + data, main pages/markup, styles, client-side scripts). Coder tasks depend on architect (and designer if present) — and on research tasks if content depends on findings.',
          '- Each researcher task lists 1-3 short, specific web-search "queries" about the subject matter (market, places, products, prices, audience) — never about implementation libraries. Use at most 2 researcher tasks.',
          '- "scope" lists the files a coder task owns (relative paths).',
        ].join('\n')],
        ['Output', '{"tasks":[{"key":"research-market","title":"...","role":"researcher","description":"...","deps":[],"scope":[],"queries":["..."]}, ...]}'],
      ]), PlanSchema, { purpose: 'plan', maxTokens: 4000, temperature: 0.2 });
    applyPlan(ctx, t, plan.tasks.filter((x) => roles.includes(x.role as AgentRole) || x.role === 'coder'));
    const n = [...ctx.tasks.values()].length - 2;
    ctx.message('planner', 'manager', `Task graph ready: ${n} tasks, ${countParallelRoots(ctx)} can start in parallel.`, t.id);
    return `Created ${n} tasks`;
  },

  // RESEARCHER
  async research(ctx, t) {
    const queries = (t.scope.length ? t.scope : ctx.run.brief?.researchQueries ?? []).slice(0, ctx.settings.research.maxQueries);
    const r = await runResearch(ctx, t, queries.length ? queries : [ctx.run.objective.slice(0, 120)]);
    if (r.findings.length) {
      ctx.message('manager', 'all', `Using ${r.findings.length} research findings as project requirements context.`, t.id);
      writeResearchDoc(ctx, t).catch(() => undefined);
    }
    ctx.message('researcher', 'manager', r.summary.slice(0, 2000), t.id, 'FINDING');
    return `${r.sources.length} sources, ${r.findings.length} findings. ${r.summary}`;
  },

  // DESIGNER
  async design(ctx, t) {
    const text = await callText(ctx, t,
      'You are the SWARM Designer, a senior product designer. Produce a precise, implementable design specification in Markdown. Be concrete: exact hex colors, font stacks, spacing scale, component anatomy, page sections in order, responsive rules (mobile/tablet/desktop), interaction states. Keep it under 900 words. No code.',
      sections([['Brief', briefBlock(ctx)], ['Research findings (cite nothing, just use facts)', findingsForPrompt(ctx, 10)], ['Task', t.description]]),
      { purpose: 'design', maxTokens: 2200, temperature: 0.4 });
    ctx.design = text;
    await writeFile(fsCtx(ctx, t), '.swarm/design.md', text);
    ctx.message('designer', 'coder', `Design system ready (.swarm/design.md): ${text.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 160) ?? 'see spec'}`, t.id);
    return text.slice(0, 1500);
  },

  // ARCHITECT
  async architecture(ctx, t) {
    const s = ctx.settings;
    const platform = ctx.run.brief?.platform ?? ctx.run.target;
    if (!platform) throw new Error('Build target has not been resolved');
    const { systemPrompt, stackGuidance, outputFormat, requiresPackageJson } = await import('./architectures').then((m) => m.getArchitectureGuidance(platform));
    const tree = await listForPrompt(ctx.root, 120);
    
    const spec = await callJson(ctx, t,
      systemPrompt,
      sections([
        ['Brief', briefBlock(ctx)],
        ['Target Platform', platform.toUpperCase()],
        ['Existing files', tree],
        ['Stack guidance', stackGuidance],
        ['Output', outputFormat + '\nAlso include targetPlatform, buildSystem, launchCommand, previewStrategy, testStrategy, packagingStrategy. Preserve the requested target.'],
      ]), ArchSchema, { purpose: 'architecture', maxTokens: 5000, temperature: 0.2 });
    
    if (spec.targetPlatform && spec.targetPlatform.toLowerCase().replace(/_desktop$/, '').replace(/^mac$/, 'macos') !== platform) throw new Error('Architect changed the requested target platform');
    const arch: ArchitectureSpec = { targetPlatform: platform, buildSystem: spec.buildSystem || spec.commands.build || 'No build command specified', launchCommand: spec.launchCommand || spec.commands.dev || '', previewStrategy: spec.previewStrategy || platform + ' controlled runtime', testStrategy: spec.testStrategy || spec.commands.test || 'Platform quality gates', packagingStrategy: spec.packagingStrategy || 'No packaging strategy specified', stack: spec.stack, summary: spec.summary, runtime: spec.runtime, commands: spec.commands, files: spec.files, api: spec.api, conventions: spec.conventions };
    ctx.architecture = arch;
    const fctx = fsCtx(ctx, t);
    
    // Only create package.json for platforms that need it (web, cli, backend, library)
    if (requiresPackageJson && spec.packageJson && typeof spec.packageJson === 'object' && !fs.existsSync(path.join(ctx.root, 'package.json'))) {
      const pkg = spec.packageJson as Record<string, unknown>;
      pkg.scripts = { ...(pkg.scripts as object ?? {}) };
      if (!(pkg.scripts as Record<string, string>).start && fs.existsSync(path.join(ctx.root, 'server.js')) === false && arch.files.some((f) => f.path === 'server.js')) (pkg.scripts as Record<string, string>).start = 'node server.js';
      await writeFile(fctx, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
    }
    
    await writeFile(fctx, '.swarm/architecture.json', JSON.stringify(arch, null, 2));
    await writeFile(fctx, '.swarm/architecture.md', `# Architecture\n\n**Platform:** ${platform}\n**Stack:** ${arch.stack}\n\n${arch.summary}\n\n## Files\n${arch.files.map((f) => `- \`${f.path}\` — ${f.purpose}`).join('\n')}\n\n${arch.api.length ? `## API\n${arch.api.map((a) => `- \`${a.method} ${a.path}\` — ${a.description}`).join('\n')}\n\n` : ''}## Conventions\n${arch.conventions.map((c) => `- ${c}`).join('\n')}\n\n## Commands\n\`\`\`json\n${JSON.stringify(arch.commands, null, 2)}\n\`\`\`\n`);
    
    // Distribute file ownership to coder tasks that have no explicit scope.
    assignScopes(ctx, arch);
    ctx.message('architect', 'coder', `Architecture ready [${platform}]: ${arch.stack}. ${arch.files.length} files planned${arch.api.length ? `, ${arch.api.length} API endpoints` : ''}.`, t.id);
    if (ctx.settings.memory.project) {
      const p = getProject(ctx.project.id);
      if (p) { p.memory.architecture = `[${platform}] ${arch.stack}. ${arch.summary}`.slice(0, 1200); p.memory.commands = arch.commands; saveProject(p); }
    }
    return `${platform}: ${arch.stack} — ${arch.files.length} files${arch.api.length ? `, ${arch.api.length} endpoints` : ''}`;
  },

  // CODER
  async code(ctx, t) {
    const budget = contextBudget(ctx);
    const existingScope = t.scope.filter((f) => fs.existsSync(path.join(ctx.root, f)));
    const scopeFiles = await readScopeFiles(ctx, t, existingScope, 10_000);
    const simple = ctx.run.mode === 'simple';
    const system = `You are the SWARM Coder implementing a real ${ctx.run.target} project. Preserve the target and existing toolchain. Inspect relevant files before editing; reproduce fixes with a failing test where possible. Implement the stated requirements with platform-appropriate accessibility, error handling and functional tests. Never substitute a web app for a native target.${simple ? ' This is a small, self-contained task: use the minimum set of files, no build tooling or dependencies unless the target requires them, and real working logic — never placeholders, mock data or decorative-only UI.' : ''}\n\n${ACTION_PROTOCOL}`;
    const user = sections([
      ['Your task', `${t.title}\n${t.description}`],
      ['Files you own (scope)', t.scope.join('\n') || '(decide sensible files; avoid files owned by other tasks listed in the architecture)'],
      ['Brief', briefBlock(ctx)],
      ['Architecture', archBlock(ctx)],
      ['Design spec', ctx.design.slice(0, budget.design)],
      ['Research findings (use these real facts in content; mention sources where natural)', findingsForPrompt(ctx, budget.findings)],
      ['Outputs from prerequisite tasks', depOutputs(ctx, t)],
      ['Messages for you', inboxBlock(ctx, 'coder')],
      ['Your notes from earlier tasks', ctx.settings.memory.agent ? (ctx.notes.get('coder') ?? []).join('\n') : ''],
      ['Current project files', await listForPrompt(ctx.root, 150)],
      ['Current content of your files', scopeFiles],
    ]);
    const r = await runAgentLoop(ctx, t, system, user, { maxSteps: modeSteps(ctx), preloaded: existingScope, verify: (files) => staticCheck(ctx.root, files) });
    ctx.run.stats.files = new Set([...ctx.tasks.values()].flatMap((x) => x.filesTouched)).size;
    if (!r.filesTouched.length) throw new Error('No files were written');
    if (!r.completed) throw new Error(`Implementation stopped at the step limit after writing ${r.filesTouched.length} files; work is incomplete`);
    if (r.verification?.problems.length) throw new Error(`Targeted checks still fail after the agent's fixes: ${r.verification.problems.slice(0, 4).join('; ')}`);
    if (r.verification?.checked.length) ctx.recordVerified(`Syntax/reference checks passed for ${r.verification.checked.length} file(s)`);
    ctx.message('coder', 'tester', `${t.title} done: ${r.summary.slice(0, 200)}`, t.id);
    return `${r.summary}\nFiles: ${r.filesTouched.join(', ')}`;
  },

  async install() { return 'Handled by the Tester dependency gate'; },

  // OPTIMIZER
  async optimize(ctx, t) {
    const system = `You are the SWARM Optimizer. Improve performance and code quality WITHOUT changing behavior: remove dead code, avoid blocking work, add caching headers/lazy-loading where appropriate, fix obvious inefficiencies. Small, safe edits only.\n\n${ACTION_PROTOCOL}`;
    const r = await runAgentLoop(ctx, t, system, sections([['Brief', briefBlock(ctx)], ['Architecture', archBlock(ctx)], ['Project files', await listForPrompt(ctx.root, 150)], ['Task', t.description]]), { maxSteps: 6, allowRun: false });
    return r.summary;
  },

  // TESTER
  async test(ctx, t) {
    const r = await runTestGates(ctx, t);
    if (r.failures.length) {
      handleFailures(ctx, t, r.failures);
      return `${r.failures.length} gate(s) failed: ${r.failures.map((f) => f.gate).join(', ')}`;
    }
    const passed = ctx.run.gates.filter((g) => g.status === 'passed').map((g) => g.label);
    ctx.message('tester', 'manager', `All executed checks passed (${passed.join(', ')})${r.url ? `. App running at ${r.url}` : ''}.`, t.id);
    return `Passed: ${passed.join(', ')}${r.warnings.length ? `\nNotes:\n${r.warnings.slice(0, 8).join('\n')}` : ''}`;
  },

  // VISION QA
  async visual_qa(ctx, t) {
    if (!ctx.devServer) { ctx.setGate('visual', 'skipped', 'App is not running (earlier gate failed)'); ctx.updateTask(t, { status: 'skipped', endedAt: Date.now() }); return 'Skipped: app not running'; }
    const r = await runVisualQA(ctx, t, ctx.devServer.url);
    if (r.failures.length) { handleFailures(ctx, t, r.failures); return r.failures[0].summary; }
    return r.summary || 'No visible defects';
  },

  // REVIEWER
  async review(ctx, t) {
    const r = await runReview(ctx, t);
    if (r.failures.length) { handleFailures(ctx, t, r.failures); return r.failures[0].summary; }
    return r.summary || 'Review passed';
  },

  // REPAIR (Coder)
  async repair(ctx, t) {
    ctx.touchAgent('coder', { status: 'working', lastAction: 'Analyzing failure' });
    const mentioned = [...new Set([...(t.description.matchAll(/([\w./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|html|css))\b/g))].map((m) => m[1].replace(/^\.\//, '')))]
      .filter((f) => !f.includes('node_modules') && fs.existsSync(path.join(ctx.root, f))).slice(0, 6);
    const files = await readScopeFiles(ctx, t, mentioned.length ? mentioned : ['package.json'], 16_000);
    const system = `You are the SWARM Coder fixing verified failures in a real project. Diagnose the root cause from the evidence, then apply minimal, correct fixes. Do not rewrite unrelated files.\n\n${ACTION_PROTOCOL}`;
    const user = sections([
      ['Failures detected by SWARM verification', t.description],
      ['Brief', briefBlock(ctx)],
      ['Architecture', archBlock(ctx)],
      ['Relevant files', files],
      ['Project files', await listForPrompt(ctx.root, 150)],
    ]);
    const r = await runAgentLoop(ctx, t, system, user, { maxSteps: Math.min(8, modeSteps(ctx)), preloaded: mentioned.length ? mentioned : ['package.json'], verify: (changed) => staticCheck(ctx.root, changed) });
    if (!r.filesTouched.length) throw new Error('Repair produced no file changes');
    emit('PATCH_APPLIED', `Patch applied to ${r.filesTouched.length} file(s): ${r.filesTouched.slice(0, 4).join(', ')}`, ctx.scope(t), 'success', { files: r.filesTouched });
    ctx.message('coder', 'tester', `Patched ${r.filesTouched.join(', ')}. Re-running verification.`, t.id);
    return r.summary;
  },

  // FINALIZER
  async finalize(ctx, t) {
    ctx.touchAgent('finalizer', { status: 'working', lastAction: 'Verifying completion' });
    const gates = ctx.run.gates;
    const failed = gates.filter((g) => g.status === 'failed');
    const files = [...new Set([...ctx.tasks.values()].flatMap((x) => x.filesTouched))].sort();
    ctx.run.stats.files = files.length;
    const isResearch = ctx.run.brief?.projectType === 'research' || ctx.run.brief?.projectType === 'analysis';
    const fctx = fsCtx(ctx, t);
    let summary = '';
    try {
      // Simple and standard runs get a deterministic summary built only from evidence (no model call, no unverifiable claims).
      if (isSmallChange(ctx.run.objective) || ctx.run.mode === 'simple' || ctx.run.mode === 'standard') summary = evidenceSummary(ctx, files);
      else summary = await callText(ctx, t,
        'You are the SWARM Finalizer. Write a factual 3-5 sentence summary of what was delivered, based ONLY on the evidence given. Do not claim anything that the evidence does not show. Mention unresolved problems honestly.',
        sections([
          ['Brief', briefBlock(ctx)],
          ['Quality gates (actual results)', gates.map((g) => `${g.label}: ${g.status}${g.detail ? ` — ${g.detail}` : ''}`).join('\n') || 'none run'],
          ['Files', files.join(', ').slice(0, 2000)],
          ['Task outcomes', [...ctx.tasks.values()].map((x) => `${ROLES[x.role].name} — ${x.title}: ${x.status}`).join('\n')],
          ['Research', `${ctx.sources.length} sources, ${ctx.findings.length} findings`],
        ]), { purpose: 'summarize', maxTokens: 1500, temperature: 0.2 });
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      summary = `Delivered ${files.length} files. ${gates.filter((g) => g.status === 'passed').length} quality gates passed, ${failed.length} failed.`;
    }
    if (isResearch && ctx.findings.length) {
      const report = await callText(ctx, t,
        'You are the SWARM Finalizer writing a research report in Markdown. Use ONLY the findings provided and keep their [n] citation numbers inline. Structure: title, executive summary, sections by theme, key takeaways. Do not add facts that are not in the findings.',
        sections([['Objective', ctx.run.objective], ['Findings', findingsForPrompt(ctx, 40)]]), { purpose: 'research', maxTokens: 3000 });
      await writeFile(fctx, 'REPORT.md', `${report}\n\n## Sources\n${ctx.sources.map((s) => `[${s.ref}] ${s.title} — ${s.url}${s.status !== 'fetched' ? ' (search snippet)' : ''}`).join('\n')}\n`);
    }
    ctx.run.readiness = computeReadiness({ target: ctx.run.target, objective: ctx.run.objective, gates, tasks: [...ctx.tasks.values()] });
    await writeFile(fctx, 'SWARM_REPORT.md', buildReport(ctx, summary, files));
    for (const artifact of discoverArtifacts(ctx.root, ctx.run.startedAt)) {
      db().put('artifacts', uid('ar_'), { ...artifact, projectId: ctx.project.id, runId: ctx.run.id, ts: Date.now() }, { project_id: ctx.project.id, run_id: ctx.run.id, ts: Date.now() });
    }
    ctx.run.summary = summary;
    ctx.saveRun();
    // Project memory update.
    if (ctx.settings.memory.project) {
      const p = getProject(ctx.project.id);
      if (p) {
        p.memory.summary = summary.slice(0, 1500);
        p.memory.completedTasks = [...new Set([...p.memory.completedTasks, ...[...ctx.tasks.values()].filter((x) => x.status === 'completed').map((x) => x.title)])].slice(-60);
        p.memory.unresolved = failed.map((g) => `${g.label}: ${g.detail ?? 'failed'}`);
        p.memory.lastRunOutcome = failed.length ? `Finished with ${failed.length} unresolved gate(s)` : 'All executed quality gates passed';
        if (ctx.run.previewUrl) p.memory.previewUrl = ctx.run.previewUrl;
        saveProject(p);
      }
    }
    db().put('artifacts', uid('ar_'), { projectId: ctx.project.id, runId: ctx.run.id, kind: 'report', path: 'SWARM_REPORT.md', ts: Date.now() }, { project_id: ctx.project.id, run_id: ctx.run.id, ts: Date.now() });
    ctx.message('finalizer', 'manager', failed.length ? `Delivered with ${failed.length} unresolved gate(s): ${failed.map((g) => g.label).join(', ')}. ${readinessHeadline(ctx.run.readiness)}` : `${readinessHeadline(ctx.run.readiness)} Report written to SWARM_REPORT.md.`, t.id);
    return summary;
  },
};

// ------------------------------------------------------------------ graph construction
function applyPlan(ctx: RunContext, planner: Task, tasks: z.infer<typeof PlanSchema>['tasks']) {
  const b = ctx.run.brief!;
  validateGraph(tasks);
  const keyToId = new Map<string, string>();
  const created: Task[] = [];
  const allowed = new Set(b.agents);
  const included = tasks.filter(x => allowed.has((PLANNABLE.includes(x.role as AgentRole) ? x.role : 'coder') as AgentRole));
  const keys = new Set(included.map(x => x.key));
  validateGraph(included.map(x => ({ key: x.key, deps: [...x.deps.filter(k => keys.has(k)), ...(x.consumedArtifacts ?? []).map(artifact => {
    const producers = included.filter(other => other.key !== x.key && other.producedArtifacts?.includes(artifact));
    if (producers.length !== 1) throw new Error('Required artifact must have one producer: ' + artifact);
    return producers[0].key;
  })] })));
  for (const x of tasks) {
    const role = (PLANNABLE.includes(x.role as AgentRole) ? x.role : 'coder') as AgentRole;
    if (!allowed.has(role)) continue;
    if (keyToId.has(x.key)) continue;
    const kind = KIND_OF[role]!;
    const task = ctx.addTask({
      key: x.key, title: x.title, description: x.description || x.title, role, kind, deps: [planner.id], priority: x.priority, requiredCapabilities: x.requiredCapabilities, producedArtifacts: x.producedArtifacts, consumedArtifacts: x.consumedArtifacts,
      scope: role === 'researcher' ? (x.queries.length ? x.queries : b.researchQueries.slice(0, 2)) : x.scope.map((f) => f.replace(/\\/g, '/').replace(/^\.?\//, '')),
    });
    keyToId.set(x.key, task.id);
    created.push(task);
  }
  // Preserve validated forward dependencies. Disabled optional agents may be omitted.
  created.forEach((task) => {
    const src = tasks.find((x) => x.key === task.key)!;
    const deps = src.deps.map((k) => keyToId.get(k)).filter((id): id is string => !!id);
    for (const artifact of task.consumedArtifacts ?? []) {
      const producer = created.find(other => other.id !== task.id && other.producedArtifacts?.includes(artifact));
      if (!producer) throw new Error('No task produces required artifact: ' + artifact);
      deps.push(producer.id);
    }
    task.deps = [planner.id, ...new Set(deps)];
    ctx.persistTask(task);
  });
  // The planner's declared edges determine what each implementation actually needs.
  const arch = created.filter(x => x.kind === 'architecture').map(x => x.id);
  const design = created.filter(x => x.kind === 'design').map(x => x.id);
  const research = created.filter(x => x.kind === 'research').map(x => x.id);
  if (!created.some((x) => x.kind === 'code') && ['web_app', 'desktop_app', 'mobile_app', 'cli_tool', 'backend_service', 'api_service', 'library', 'fix', 'automation', 'script', 'design'].includes(b.projectType)) {
    const c = ctx.addTask({ key: 'implement', title: 'Implement the project', description: 'Implement all requirements', role: 'coder', kind: 'code', deps: [planner.id, ...arch, ...design, ...research], scope: [] });
    created.push(c);
  }
  // Writer conflicts are enforced at dispatch, without inventing dependency edges.
  validateGraph(created.map(t => ({ key: t.id, deps: t.deps.filter(d => d !== planner.id) })));
  appendVerification(ctx, created);
}

function appendVerification(ctx: RunContext, created: Task[]) {
  const s = ctx.settings;
  const b = ctx.run.brief!;
  const platform = b.platform ?? ctx.run.target;
  const work = created.filter((x) => ['code', 'optimize'].includes(x.kind)).map((x) => x.id);
  const all = created.map((x) => x.id);
  let tail: string[] = all.length ? all : [];
  if (work.length && s.agents.enabled.tester !== false) {
    const test = ctx.addTask({ key: 'test', title: 'Build, test & verify', description: `Run ${platform} quality gates`, role: 'tester', kind: 'test', deps: work, scope: [] });
    tail = [test.id];
    // Only add Visual QA for web projects
    // Simple runs rely on real build/browser/layout gates; model-based visual QA and review are reserved for larger work.
    const simple = ctx.run.mode === 'simple';
    if (platform === 'web' && s.agents.enabled.vision !== false && s.experimental.visionQA && !simple) {
      const v = ctx.addTask({ key: 'visual-qa', title: 'Visual QA', description: 'Screenshot + inspect UI', role: 'vision', kind: 'visual_qa', deps: tail, scope: [] });
      tail = [v.id];
    }
    if (s.agents.enabled.reviewer !== false && !isSmallChange(ctx.run.objective) && !simple) {
      const r = ctx.addTask({ key: 'review', title: 'Code & requirements review', description: 'Review implementation', role: 'reviewer', kind: 'review', deps: tail, scope: [] });
      tail = [r.id];
    }
  }
  ctx.addTask({ key: 'finalize', title: 'Verify & deliver', description: 'Final verification and report', role: 'finalizer', kind: 'finalize', deps: tail.length ? tail : all, scope: [] });
  emit('GRAPH_UPDATED', `Task graph: ${ctx.tasks.size} tasks`, ctx.scope('planner'), 'info', {});
}

/** Simple mode: deterministic brief, one implementation task, then real verification. Zero planning model calls. */
function buildSimpleGraph(ctx: RunContext, existingFiles: boolean) {
  const instruction = instructionOf(ctx.run.objective);
  const context = ctx.run.objective.slice(instruction.length).trim();
  const fix = isSmallChange(instruction) && existingFiles;
  const lines = instruction.split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  const target = ctx.run.target!;
  ctx.setBrief({
    title: (lines[0] ?? instruction).replace(/^(please\s+)?(build|create|make|write|develop)\s+(me\s+)?(an?\s+)?/i, '').slice(0, 60).replace(/^\w/, c => c.toUpperCase()) || 'Project',
    projectType: fix ? 'fix' : projectTypeFor(target), platform: target, summary: instruction.slice(0, 600),
    requirements: (lines.length > 1 ? lines : [instruction]).slice(0, 12), agents: ['coder'], researchQueries: [],
    stackHint: fix ? 'Preserve the existing project toolchain' : 'Smallest stack that satisfies the target',
  });
  const description = fix
    ? `Inspect the existing project, reproduce the reported issue, make the smallest repair, and verify the affected behavior. ${ctx.run.objective}`
    : `Implement the complete, working ${target} project described below in as few files as practical. Inspect existing files first and keep what works. Every requirement must work for real (handle invalid input and edge cases); no placeholders or mock data.\n\n${instruction}${context ? `\n\n${context}` : ''}`;
  const coder = ctx.addTask({ key: fix ? 'fix' : 'implement', title: fix ? 'Inspect, reproduce and fix' : `Implement ${ctx.run.brief!.title}`, description, role: 'coder', kind: 'code', deps: [], scope: [] });
  appendVerification(ctx, [coder]);
}

/** Deterministic, evidence-only summary (no model call). */
function evidenceSummary(ctx: RunContext, files: string[]): string {
  const gates = ctx.run.gates;
  const passed = gates.filter(g => g.status === 'passed').map(g => g.label);
  const failed = gates.filter(g => g.status === 'failed').map(g => g.label);
  const readiness = computeReadiness({ target: ctx.run.target, objective: ctx.run.objective, gates, tasks: [...ctx.tasks.values()] });
  return [
    `${files.length} file(s) changed${files.length ? `: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}` : ''}.`,
    passed.length ? `Passed: ${passed.join(', ')}.` : 'No verification gate passed.',
    failed.length ? `Still failing: ${failed.join(', ')}.` : '',
    readinessHeadline(readiness),
  ].filter(Boolean).join(' ');
}

function templatePlan(ctx: RunContext, planner: Task) {
  const b = ctx.run.brief!;
  const tasks: z.infer<typeof PlanSchema>['tasks'] = [];
  if (b.agents.includes('researcher') && b.researchQueries.length) tasks.push({ key: 'research', title: 'Research the topic', role: 'researcher', description: 'Gather current, cited information', deps: [], scope: [], queries: b.researchQueries });
  if (b.agents.includes('designer')) tasks.push({ key: 'design', title: 'Design system & layouts', role: 'designer', description: 'Design the UI', deps: [], scope: [], queries: [] });
  if (b.agents.includes('architect')) tasks.push({ key: 'architecture', title: 'Architecture & file plan', role: 'architect', description: 'Define stack and files', deps: [], scope: [], queries: [] });
  if (b.projectType !== 'research' && b.projectType !== 'analysis') {
    // Depend only on prerequisite tasks that exist (validateGraph rejects missing edges).
    const deps = ['architecture', 'design', 'research'].filter(k => tasks.some(x => x.key === k));
    tasks.push({ key: 'implement', title: `Implement ${b.platform} project`, role: 'coder', description: `${b.summary}\n\nRequirements:\n${b.requirements.map(r => `- ${r}`).join('\n')}`, deps, scope: [], queries: [] });
  }
  applyPlan(ctx, planner, tasks);
}

function assignScopes(ctx: RunContext, arch: ArchitectureSpec) {
  const coders = [...ctx.tasks.values()].filter((t) => t.kind === 'code' && t.status === 'waiting');
  if (!coders.length || !arch.files.length) return;
  const isBackend = (f: string) => /server|api|routes?|data|db|models?|\.json$|backend|lib\//i.test(f) && !/^public\//.test(f);
  const backendish = (c: Task) => /back|api|server|data/i.test(c.title + c.description) || c.scope.some(isBackend);
  const owned = new Set(coders.flatMap((c) => c.scope));
  const free = arch.files.map((f) => f.path.replace(/\\/g, '/').replace(/^\.?\//, '')).filter((f) => !owned.has(f) && f !== 'package.json');
  if (!free.length) return;
  // Every planned file gets an owner: unscoped coders first, otherwise the best-matching scoped coder.
  const unscoped = coders.filter((c) => !c.scope.length);
  const pool = unscoped.length ? unscoped : coders;
  const back = pool.filter(backendish);
  const front = pool.filter((c) => !back.includes(c));
  const assign = (list: Task[], files: string[]) => { list.forEach((c, i) => { c.scope = [...c.scope, ...files.filter((_, j) => j % list.length === i)]; }); };
  if (back.length && front.length) { assign(back, free.filter(isBackend)); assign(front, free.filter((f) => !isBackend(f))); }
  else assign(pool, free);
  for (const c of coders) ctx.updateTask(c, { scope: [...new Set(c.scope)] });
}

function handleFailures(ctx: RunContext, failedTask: Task, failures: GateFailure[]) {
  const s = ctx.settings;
  const cycle = ctx.run.repairCycles;
  ctx.updateTask(failedTask, { status: 'failed', error: failures.map((f) => f.summary).join('; '), endedAt: Date.now() }, { type: 'TASK_FAILED', message: `${ROLES[failedTask.role].name}: ${failures.map((f) => f.summary).join('; ')}`, level: 'error' });
  const a = ctx.agents.get(failedTask.role);
  ctx.touchAgent(failedTask.role, { status: 'failed', errors: (a?.errors ?? 0) + 1 });
  if (failedTask.kind === 'test' && failures.some((f) => f.gate === 'browser' || f.gate === 'console')) notify('browser_fail', 'warning', 'Browser test failed', failures[0].summary, ctx.scope());
  if (failures.some(f => /denied|unavailable|missing.*sdk|not installed|no.*device/i.test(f.details))) { ctx.message('manager', 'all', 'Execution is blocked by permissions or environment availability. Resolve the reported prerequisite before retrying.', failedTask.id); return; }
  if (ctx.halt || [...ctx.tasks.values()].some(t => t.status === 'failed' && /No eligible free model|All eligible models failed|Exhausted.*model attempts/.test(t.error ?? ''))) return;
  if (s.agents.enabled.coder === false) {
    ctx.message('manager', 'all', 'Repairs are blocked because the coding agent is disabled in Settings.', failedTask.id);
    return;
  }
  // Bounded, evidence-driven recovery. A repair must improve the chance of success; repeating it is not recovery.
  const cap = Math.min(s.behavior.maxRepairCycles, MODE_LIMITS[ctx.run.mode ?? 'complex'].repairCycles);
  const used = ctx.run.repairCycles - (ctx.run.repairBase ?? 0);
  const signature = failureSignature(failures);
  const seenBefore = ctx.failureSignatures.get(signature) ?? 0;
  const repairs = [...ctx.tasks.values()].filter(x => x.kind === 'repair');
  const lastRepair = repairs.at(-1);
  const lastRepairUseless = !!lastRepair && lastRepair.status === 'failed' && ['no_progress', 'budget'].includes(lastRepair.errorCategory ?? errorCategory(new Error(lastRepair.error ?? '')));
  // Model review notes are advisory after the first pass: they must not drive repair loops on their own.
  const reviewOnly = failures.every(f => f.gate === 'review' || f.gate === 'visual') && repairs.length > 0;
  const stop = used >= cap ? `repair budget used (${used}/${cap} cycles)`
    : seenBefore >= 2 ? `the same failure persisted after ${seenBefore} repair attempts`
      : seenBefore >= 1 && lastRepairUseless ? 'the previous repair made no usable change for this exact failure'
        : reviewOnly ? 'remaining issues are advisory review/visual notes after a repair already ran'
          : null;
  if (stop) {
    const message = `Stopped self-repair: ${stop}. Unresolved: ${failures.map(f => f.summary).join('; ').slice(0, 300)}`;
    ctx.recordRecovery({ taskId: failedTask.id, attempt: used, maxAttempts: cap, category: 'no_progress', reason: failures.map(f => f.summary).join('; '), strategy: `No further repair: ${stop}` });
    ctx.setBlocker(message, used >= cap ? 'budget' : 'no_progress');
    ctx.message('manager', 'all', message, failedTask.id, 'ESCALATION');
    emit('REPAIR_STARTED', message, ctx.scope('manager'), 'warning', { stopped: true, signature });
    return;
  }
  ctx.failureSignatures.set(signature, seenBefore + 1);
  ctx.run.repairCycles++;
  ctx.recordRecovery({ taskId: failedTask.id, attempt: used + 1, maxAttempts: cap, category: 'verification', reason: failures.map(f => `${f.gate}: ${f.summary}`).join('; '), strategy: seenBefore ? 'Repair again with the previous attempt\'s evidence, then re-verify' : 'Coder repair from the failing gate output, then re-verify' });
  ctx.saveRun();
  emit('REPAIR_STARTED', `Self-repair cycle ${ctx.run.repairCycles}: SWARM is analyzing ${failures.map((f) => f.gate).join(', ')} failure(s)`, ctx.scope('manager'), 'warning', { failures: failures.map((f) => f.gate) });
  ctx.message(failedTask.role, 'coder', `${failures[0].summary}. ${failures[0].details.split('\n')[0].slice(0, 200)}`, failedTask.id, failedTask.role === 'tester' ? 'TEST_FAILURE' : 'ERROR');
  ctx.message(failedTask.role, 'manager', failures.map(f => f.summary).join('; '), failedTask.id, 'ESCALATION');
  const repair = ctx.addTask({
    key: ctx.newTaskKey('repair'), title: `Fix: ${failures.map((f) => f.summary).join('; ').slice(0, 80)}`, role: 'coder', kind: 'repair',
    description: failures.map((f) => `### ${f.gate}: ${f.summary}\n${f.details.slice(0, 5000)}`).join('\n\n'), deps: [], scope: [],
  });
  // Rebuild the verification tail after the repair and supersede stale verification tasks.
  const stale = [...ctx.tasks.values()].filter((x) => x.status === 'waiting' && ['test', 'visual_qa', 'review'].includes(x.kind));
  for (const x of stale) ctx.updateTask(x, { status: 'skipped', error: 'Superseded by repair cycle', endedAt: Date.now() });
  const test = ctx.addTask({ key: ctx.newTaskKey('test'), title: `Re-verify (cycle ${ctx.run.repairCycles})`, description: 'Re-run quality gates after repair', role: 'tester', kind: 'test', deps: [repair.id], scope: [] });
  let tailId = test.id;
  const hadVisual = [...ctx.tasks.values()].some((x) => x.kind === 'visual_qa');
  const hadReview = [...ctx.tasks.values()].some((x) => x.kind === 'review');
  if (hadVisual && failedTask.kind !== 'review') tailId = ctx.addTask({ key: ctx.newTaskKey('visual_qa'), title: `Visual QA (cycle ${ctx.run.repairCycles})`, description: 'Re-inspect UI', role: 'vision', kind: 'visual_qa', deps: [tailId], scope: [] }).id;
  if (hadReview) tailId = ctx.addTask({ key: ctx.newTaskKey('review'), title: `Review (cycle ${ctx.run.repairCycles})`, description: 'Re-review', role: 'reviewer', kind: 'review', deps: [tailId], scope: [] }).id;
  for (const x of ctx.tasks.values()) {
    if (x.kind === 'finalize' && x.status === 'waiting') ctx.updateTask(x, { deps: [tailId] });
  }
  emit('GRAPH_UPDATED', `Repair cycle ${ctx.run.repairCycles} added to the task graph`, ctx.scope('manager'), 'info', {});
}

/** Stable identity of a failure: gate + the first lines of evidence with volatile values (numbers, paths, ports) removed. */
export function failureSignature(failures: GateFailure[]): string {
  const norm = (s: string) => s.split('\n').filter(l => l.trim() && !/^…\[\d+ earlier/.test(l)).slice(0, 6).join('\n')
    .replace(/[a-z]:\\[^\s:]+|\/[\w./-]+/gi, '<path>').replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, '<n>').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha1').update(failures.map(f => `${f.gate}|${norm(f.summary)}|${norm(f.details)}`).sort().join('\n')).digest('hex').slice(0, 16);
}

function countParallelRoots(ctx: RunContext) {
  const planner = [...ctx.tasks.values()].find((t) => t.kind === 'decompose');
  return [...ctx.tasks.values()].filter((t) => t.deps.length === 1 && t.deps[0] === planner?.id).length;
}

async function writeResearchDoc(ctx: RunContext, t: Task) {
  const refOf = new Map(ctx.sources.map((s) => [s.id, s.ref]));
  const body = `# Research\n\nObjective: ${ctx.run.objective}\n\n## Findings\n${ctx.findings.map((f) => `- **${f.category}** — ${f.claim} ${f.sourceIds.map((id) => `[${refOf.get(id)}]`).join('')}`).join('\n')}\n\n## Sources\n${ctx.sources.map((s) => `[${s.ref}] ${s.title} — ${s.url}${s.status !== 'fetched' ? ' (search snippet)' : ''}`).join('\n')}\n`;
  await writeFile(fsCtx(ctx, t), '.swarm/research.md', body);
}

function buildReport(ctx: RunContext, summary: string, files: string[]): string {
  const icon = (s: string) => ({ passed: '✅ passed', failed: '❌ failed', skipped: '⏭️ skipped', running: '… running', pending: '… pending' } as Record<string, string>)[s] ?? s;
  const arch = ctx.architecture;
  const pkgPath = path.join(ctx.root, 'package.json');
  const start = fs.existsSync(pkgPath) ? (() => { try { const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); return p.scripts?.dev ? 'npm run dev' : p.scripts?.start ? 'npm start' : null; } catch { return null; } })() : null;
  return `# SWARM Report — ${ctx.run.brief?.title ?? ctx.project.name}

> ${ctx.run.objective}

## Summary
${summary}

## Quality gates
| Gate | Result | Detail |
|---|---|---|
${ctx.run.gates.map((g) => `| ${g.label} | ${icon(g.status)} | ${(g.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)} |`).join('\n') || '| — | not applicable | |'}

Self-repair cycles: ${ctx.run.repairCycles}

## Verification evidence
${ctx.run.readiness ? readinessMarkdown(ctx.run.readiness) : 'Not computed.'}

## How to run
${start ? `\`\`\`\nnpm install\n${start}\n\`\`\`` : fs.existsSync(path.join(ctx.root, 'index.html')) ? 'Open `index.html` or serve the folder with any static server.' : 'See architecture notes.'}
${arch ? `\n## Architecture\n**${arch.stack}** — ${arch.summary}\n` : ''}
## Files (${files.length})
${files.map((f) => `- \`${f}\``).join('\n')}
${ctx.sources.length ? `\n## Research sources\n${ctx.sources.map((s) => `[${s.ref}] [${s.title}](${s.url})${s.status !== 'fetched' ? ' — search snippet' : ''}`).join('\n')}\n` : ''}
## Run
- Execution mode: ${ctx.run.mode ?? 'complex'}${ctx.progress.modeReason ? ` (${ctx.progress.modeReason})` : ''}
- Tasks: ${ctx.tasks.size} · Model calls: ${ctx.run.stats.modelCalls} · Automatic fallbacks: ${ctx.run.stats.fallbacks}
- Tokens: ${ctx.progress.usage.reportedTokens.toLocaleString()} reported by providers${ctx.progress.usage.estimatedTokens ? ` + ${ctx.progress.usage.estimatedTokens.toLocaleString()} estimated (provider did not report usage)` : ''}
- Cost: not metered by SWARM (free-tier / local routing is enforced; provider billing is not read)
- Generated by SWARM on ${new Date().toISOString()}
`;
}

const fmtDuration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

export function projectForRun(runId: string): Project | null { return active.get(runId)?.project ?? null; }

/** Internal engine entry points, exported for deterministic regression tests only. */
export const __engine = { executeGraph, handleFailures, markDeadlocked, runTask };
