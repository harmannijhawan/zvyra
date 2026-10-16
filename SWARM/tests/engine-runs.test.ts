// End-to-end regression tests for the execution engine with a deterministic scripted model.
// Real: orchestrator, task engine, agent loop, filesystem tools, targeted static checks (node --check), readiness.
// Mocked: model provider (scripted), platform gates (browser/npm), project store, toolchain discovery.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GateId, Project, Run, Task } from '../shared/types';

vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => os.tmpdir() } }));

const fx = vi.hoisted(() => ({
  script: null as null | ((req: any, n: number) => Promise<string> | string),
  calls: [] as { role: string; purpose: string; promptTokens: number; completionTokens: number }[],
  gates: null as null | ((ctx: any, task: any, cycle: number) => { failures: { gate: GateId; summary: string; details: string }[] }),
  testCycles: 0,
  projects: new Map<string, any>(),
  forceMode: null as null | 'simple' | 'standard' | 'complex',
  usageEstimated: false,
}));

vi.mock('../electron/router/router', async (orig) => {
  const real = await orig<typeof import('../electron/router/router')>();
  const { estimatePromptTokens } = await import('../electron/providers/http');
  const model = { id: 'scripted::coder-70b', providerId: 'scripted', modelId: 'coder-70b', displayName: 'Scripted Coder 70B' };
  return {
    ...real,
    complete: vi.fn(async (opts: any) => {
      if (opts.signal.aborted) throw new (await import('../electron/core/util')).CancelledError();
      const n = fx.calls.length;
      const promptTokens = estimatePromptTokens(opts.messages);
      opts.onRequest?.(model);
      const text = await fx.script!(opts, n);
      const completionTokens = Math.ceil(text.length / 4);
      fx.calls.push({ role: opts.route.role, purpose: opts.route.purpose, promptTokens, completionTokens });
      const value = opts.validate ? opts.validate(text, {}) : text;
      opts.onAttempt?.({ model, ok: true });
      return { text, value, model, result: { text, promptTokens, completionTokens, finishReason: 'stop', latencyMs: 5, ttftMs: 1, usageEstimated: fx.usageEstimated }, attempts: [{ modelId: model.id, ok: true }], recovered: false };
    }),
  };
});
vi.mock('../electron/agents/verify', async (orig) => {
  const real = await orig<typeof import('../electron/agents/verify')>();
  return {
    ...real,
    // Platform gates are simulated: the browser/npm toolchain is not part of these deterministic tests.
    runTestGates: vi.fn(async (ctx: any, task: any) => {
      fx.testCycles++;
      const r = fx.gates ? fx.gates(ctx, task, fx.testCycles) : { failures: [] };
      if (r.failures.length) for (const f of r.failures) ctx.setGate(f.gate, 'failed', f.summary);
      else {
        ctx.setGate('deps', 'skipped', 'No package.json (static or non-Node project)');
        ctx.setGate('typecheck', 'skipped', 'No TypeScript configuration');
        ctx.setGate('build', 'skipped', 'No build step');
        ctx.setGate('unit', 'skipped', 'No test script');
        ctx.setGate('server', 'passed', 'Serving project root');
        ctx.setGate('browser', 'passed', 'Loaded http://127.0.0.1/ (HTTP 200)');
        ctx.setGate('console', 'passed', 'No console errors');
        ctx.setGate('responsive', 'passed', 'Desktop, tablet and mobile checked');
      }
      return { failures: r.failures, url: null, warnings: [] };
    }),
    runVisualQA: vi.fn(async (ctx: any, task: any) => {
      const { callModel } = await import('../electron/agents/runtime');
      await callModel(ctx, task, [{ role: 'user', content: 'Inspect screenshots' }], { purpose: 'vision' });
      ctx.setGate('visual', 'passed', 'No visible defects');
      return { failures: [], summary: 'ok' };
    }),
    stopDevServer: vi.fn(),
  };
});
vi.mock('../electron/projects/projects', () => ({
  getProject: (id: string) => fx.projects.get(id) ?? null,
  saveProject: (p: any) => { fx.projects.set(p.id, p); return p; },
  listProjects: () => [...fx.projects.values()],
  workspaceRoot: () => os.tmpdir(),
}));
vi.mock('../electron/core/toolchain', () => ({ peekToolchains: () => null, getCachedToolchains: async () => ({}), getAvailableToolchains: () => [] }));
vi.mock('../electron/account/managed', () => ({ finishManagedOperation: vi.fn(), managedComplete: vi.fn() }));
vi.mock('../electron/core/notify', () => ({ notify: vi.fn() }));
vi.mock('../electron/agents/research', () => ({ runResearch: vi.fn(async () => ({ findings: [], sources: [], summary: 'No research' })), findingsForPrompt: () => '' }));
vi.mock('../electron/agents/strategy', async (orig) => {
  const real = await orig<typeof import('../electron/agents/strategy')>();
  return { ...real, selectExecutionMode: (o: string, opts: any) => { const d = real.selectExecutionMode(o, opts); return fx.forceMode ? { ...d, mode: fx.forceMode, reason: `forced ${fx.forceMode} for measurement` } : d; } };
});

import { db, initDb } from '../electron/core/db';
import { bus } from '../electron/core/bus';
import { updateSettings } from '../electron/core/settings';
import { cancelRun, resumeRun, startRun } from '../electron/agents/orchestrator';
import { NoModelError } from '../electron/router/router';
import { markInterruptedRuns } from '../electron/core/recovery';
import { CancelledError } from '../electron/core/util';

const CALC_HTML = '<!doctype html><html><head><title>Calculator</title><link rel="stylesheet" href="styles.css"></head><body><main><output id="display">0</output><div id="keys"></div></main><script src="app.js"></script></body></html>';
const CALC_CSS = 'main{display:grid;gap:8px;max-width:320px;margin:auto}';
const CALC_JS = `const display = document.getElementById('display');
function evaluate(a, op, b) { if (op === '/' && b === 0) return 'Error'; return op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b; }
if (typeof module !== 'undefined') module.exports = { evaluate };`;
const coderWrites = `<write path="index.html">\n${CALC_HTML}\n</write>\n<write path="styles.css">\n${CALC_CSS}\n</write>\n<write path="app.js">\n${CALC_JS}\n</write>\n<done>Implemented the calculator</done>`;

/** Replies by role: JSON for planning roles, actions for the coder. */
function scripted(overrides: Partial<Record<string, (req: any, n: number) => string | Promise<string>>> = {}) {
  return (req: any, n: number) => {
    const role = req.route.role as string;
    if (overrides[role]) return overrides[role]!(req, n);
    switch (role) {
      case 'manager': return JSON.stringify({ title: 'Calculator', projectType: 'web_app', platform: 'web', summary: 'A browser calculator with the four operations.', requirements: ['Add, subtract, multiply and divide', 'Show errors for division by zero'], agents: ['designer', 'architect', 'coder'], researchQueries: [], stackHint: 'Static HTML/CSS/JS' });
      case 'planner': return JSON.stringify({ tasks: [{ key: 'design', title: 'Design calculator UI', role: 'designer', description: 'Design', deps: [], scope: [], queries: [] }, { key: 'arch', title: 'File plan', role: 'architect', description: 'Plan files', deps: [], scope: [], queries: [] }, { key: 'impl', title: 'Implement calculator', role: 'coder', description: 'Implement', deps: ['design', 'arch'], scope: [], queries: [] }] });
      case 'designer': return '# Design\nUse a 4-column grid of buttons with #1f2937 text on #ffffff, 16px Inter, 8px gaps. Large display at top.';
      case 'architect': return JSON.stringify({ stack: 'Static HTML/CSS/JS', summary: 'Three files', runtime: 'browser', commands: {}, files: [{ path: 'index.html', purpose: 'markup' }, { path: 'styles.css', purpose: 'styles' }, { path: 'app.js', purpose: 'logic' }], api: [], conventions: [] });
      case 'reviewer': return JSON.stringify({ verdict: 'pass', summary: 'Calculator logic is correct', issues: [] });
      case 'vision': return '{"verdict":"pass","summary":"fine","issues":[]}';
      case 'finalizer': return 'The calculator was implemented in three files and the browser checks passed.';
      default: return coderWrites;
    }
  };
}

let root: string;
function project(): Project {
  const id = 'p_' + Math.random().toString(36).slice(2, 8);
  const p = { id, name: 'Calc', path: root, objective: '', status: 'idle', favorite: false, archived: false, isDemo: false, external: false, createdAt: Date.now(), updatedAt: Date.now(), lastOpenedAt: Date.now(), lastRunId: null,
    memory: { objective: '', summary: '', completedTasks: [], unresolved: [], decisions: [], architecture: '', lastRunOutcome: '', commands: {} }, settings: { webResearch: false, autonomy: 'autonomous', stack: null } } as Project;
  fx.projects.set(id, p);
  return p;
}
const runOf = (id: string) => db().get<Run>('runs', id)!;
const tasksOf = (id: string) => db().list<Task>('tasks', 'run_id = ?', [id], 'created_at ASC');
async function finished(id: string, timeout = 15000) {
  await vi.waitFor(() => expect(['running', 'paused']).not.toContain(runOf(id).status), { timeout, interval: 20 });
  // execute() persists the final state in `finally`; give it a tick.
  await new Promise(r => setTimeout(r, 30));
  return runOf(id);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-engine-'));
  initDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-engine-db-')), 'test.db'));
  updateSettings({ research: { defaultOn: false }, behavior: { autonomy: 'autonomous' }, notifications: { enabled: false } });
  fx.calls = []; fx.gates = null; fx.testCycles = 0; fx.forceMode = null; fx.usageEstimated = false;
  fx.script = scripted();
});
afterEach(() => { bus.flush?.(); });

describe('execution strategy', () => {
  it('a simple calculator request takes the single-agent path with no planning or model selection calls', async () => {
    const run = startRun(project().id, 'Build a website that is a simple calculator');
    const done = await finished(run.id);
    const tasks = tasksOf(run.id);
    expect(done.mode).toBe('simple');
    expect(tasks.map(t => t.kind)).toEqual(['code', 'test', 'finalize']);
    expect(tasks.some(t => ['plan', 'decompose', 'research', 'design', 'architecture', 'review', 'visual_qa'].includes(t.kind))).toBe(false);
    // Exactly one model call: the coder's single step. No Manager/Planner/selection/summary calls.
    expect(fx.calls.map(c => c.role)).toEqual(['coder']);
    expect(done.stats.modelCalls).toBe(1);
    expect(fs.readFileSync(path.join(root, 'app.js'), 'utf8')).toContain('function evaluate');
    expect(done.status).toBe('completed');
  });

  it('measures the full pipeline against the simple path for the same calculator objective', async () => {
    const objective = 'Build a website that is a simple calculator';
    const simple = await finished(startRun(project().id, objective).id);
    const simpleCalls = [...fx.calls];
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-engine-'));
    fx.calls = []; fx.forceMode = 'complex';
    const complex = await finished(startRun(project().id, objective).id);
    const complexCalls = [...fx.calls];
    const tokens = (c: typeof fx.calls) => c.reduce((n, x) => n + x.promptTokens + x.completionTokens, 0);
    console.log(JSON.stringify({ measurement: 'calculator', simple: { tasks: tasksOf(simple.id).length, modelCalls: simpleCalls.length, tokens: tokens(simpleCalls), roles: simpleCalls.map(c => c.role) }, complex: { tasks: tasksOf(complex.id).length, modelCalls: complexCalls.length, tokens: tokens(complexCalls), roles: complexCalls.map(c => c.role) } }));
    expect(simpleCalls.length).toBeLessThan(complexCalls.length);
    expect(tokens(simpleCalls)).toBeLessThan(tokens(complexCalls));
    expect(tasksOf(simple.id).length).toBeLessThan(tasksOf(complex.id).length);
  });

  it('standard mode makes one Manager call and builds the graph without a Planner call', async () => {
    fx.forceMode = 'standard';
    const run = await finished(startRun(project().id, 'Build a recipe website with a search page and category filters').id);
    expect(run.mode).toBe('standard');
    expect(fx.calls.filter(c => c.role === 'planner')).toHaveLength(0);
    expect(fx.calls.filter(c => c.role === 'manager')).toHaveLength(1);
    expect(tasksOf(run.id).filter(t => t.kind === 'code')).toHaveLength(1);
  });
});

describe('evidence-based completion', () => {
  it('never claims production readiness from completed tasks alone', async () => {
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    expect(run.status).toBe('completed');
    expect(run.readiness!.productionReady).toBe(false);
    expect(run.readiness!.testsVerified.status).toBe('not_run');
    expect(run.readiness!.runtimeVerified.status).toBe('verified');
    expect(run.readiness!.securityReviewed.status).toBe('not_run');
    const report = fs.readFileSync(path.join(root, 'SWARM_REPORT.md'), 'utf8');
    expect(report).toContain('Production readiness:** not yet established');
    expect(report).not.toMatch(/Cost: \$0\.00/);
    bus.flush();
    const events = db().db.prepare("SELECT message FROM events WHERE run_id = ? AND type = 'RUN_COMPLETED'").all(run.id) as { message: string }[];
    expect(events.at(-1)!.message).toContain('Production readiness not yet established');
    expect(events.at(-1)!.message).not.toMatch(/all executed quality gates passed/i);
  });

  it('reports measured and estimated tokens separately', async () => {
    fx.usageEstimated = true;
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    expect(run.progress!.usage.reportedTokens).toBe(0);
    expect(run.progress!.usage.estimatedTokens).toBeGreaterThan(0);
    expect(run.stats.tokensEstimated).toBe(run.progress!.usage.estimatedTokens);
  });
});

describe('bounded recovery', () => {
  it('stops repairing when the same build/test failure repeats, instead of looping', async () => {
    const failure = { gate: 'unit' as GateId, summary: '`npm test` failed (exit 1)', details: 'FAIL calc.test.js\n  expected 4 to be 5' };
    fx.gates = () => ({ failures: [failure] });
    fx.script = scripted({ coder: (req) => /Failures detected/.test(JSON.stringify(req.messages)) ? '<edit path="app.js"><find>return op</find><replace>return op</replace></edit><done>Fixed</done>' : coderWrites });
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    const tasks = tasksOf(run.id);
    const repairs = tasks.filter(t => t.kind === 'repair');
    expect(repairs.length).toBeLessThanOrEqual(2); // simple-mode cap; settings default is 4
    expect(run.status).toBe('attention');
    expect(run.progress!.blocker?.text).toMatch(/Stopped self-repair/);
    expect(run.progress!.recovery.every(r => r.reason && r.strategy && r.maxAttempts >= 0)).toBe(true);
    // Completed implementation is preserved after the failed verification.
    expect(tasks.find(t => t.kind === 'code')!.status).toBe('completed');
    expect(fs.existsSync(path.join(root, 'index.html'))).toBe(true);
    expect(run.readiness!.testsVerified.status).toBe('failed');
  });

  it('honours the configured repair-cycle limit even for complex runs', async () => {
    updateSettings({ behavior: { maxRepairCycles: 1 } });
    let n = 0;
    fx.gates = () => ({ failures: [{ gate: 'build', summary: `build failed variant ${n++}`, details: `error TS${n}: different every time ${n}` }] });
    fx.forceMode = 'complex';
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    expect(run.repairCycles).toBe(1);
  });

  it('a failing build creates a repair task carrying the real failure output', async () => {
    let cycle = 0;
    fx.gates = () => (++cycle === 1 ? { failures: [{ gate: 'build' as GateId, summary: '`npm run build` failed (exit 1)', details: 'app.js:3 SyntaxError: Unexpected token' }] } : { failures: [] });
    // A well-behaved repair agent reads the files it rewrites.
    fx.script = scripted({ coder: (req) => {
      const transcript = JSON.stringify(req.messages);
      if (!/Failures detected/.test(transcript)) return coderWrites;
      return /--- index\.html ---/.test(transcript) ? coderWrites : '<read path="index.html"/><read path="styles.css"/>';
    } });
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    const repair = tasksOf(run.id).find(t => t.kind === 'repair')!;
    expect(repair.description).toContain('SyntaxError: Unexpected token');
    expect(repair.status).toBe('completed');
    expect(run.status).toBe('completed');
  });

  it('refuses a blind overwrite of another task\'s file and stops the repeating agent', async () => {
    let cycle = 0;
    fx.gates = () => (++cycle === 1 ? { failures: [{ gate: 'build' as GateId, summary: 'build failed', details: 'app.js broken' }] } : { failures: [] });
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    const repair = tasksOf(run.id).find(t => t.kind === 'repair')!;
    expect(repair.status).toBe('failed');
    expect(repair.error).toMatch(/written by .* <read> it first/);
    expect(repair.errorCategory).toBe('no_progress');
  });

  it('targeted static checks catch a syntax error and return it to the same agent', async () => {
    let step = 0;
    fx.script = scripted({ coder: () => (++step === 1 ? coderWrites.replace('function evaluate(a, op, b) {', 'function evaluate(a, op, b) {{') : `<write path="app.js">\n${CALC_JS}\n</write><done>Fixed syntax</done>`) });
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    expect(step).toBe(2);
    expect(run.progress!.recovery.some(r => r.category === 'verification')).toBe(true);
    expect(tasksOf(run.id).find(t => t.kind === 'code')!.status).toBe('completed');
  });
});

describe('provider failures at run level', () => {
  it('stops promptly and explains when no provider can do the work', async () => {
    fx.script = () => { throw new NoModelError('No AI provider is connected. Open Settings › Providers to connect one.', 'no_provider'); };
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    expect(run.status).toBe('failed');
    expect(run.summary).toMatch(/no configured model|No AI provider/i);
    const tasks = tasksOf(run.id);
    expect(tasks.find(t => t.kind === 'code')!.errorCategory).toBe('no_provider');
    expect(tasks.filter(t => t.status === 'running')).toHaveLength(0);
  });

  it('waits for a provider cooldown in RETRY_WAIT and then resumes the same task', async () => {
    let first = true;
    const seen: string[] = [];
    fx.script = (req, n) => {
      if (first) { first = false; throw new NoModelError('Every eligible model is cooling down', 'rate_limit', Date.now() + 600); }
      return scripted()(req, n);
    };
    const run = startRun(project().id, 'Build a website that is a simple calculator');
    await vi.waitFor(() => { const t = tasksOf(run.id).find(x => x.kind === 'code'); if (t) seen.push(t.status); expect(seen).toContain('retry_wait'); }, { timeout: 5000, interval: 10 });
    const done = await finished(run.id);
    const code = tasksOf(run.id).find(t => t.kind === 'code')!;
    expect(code.status).toBe('completed');
    expect(code.retryWaits).toBe(1);
    expect(done.progress!.recovery.some(r => r.category === 'rate_limit' && /Wait/.test(r.strategy))).toBe(true);
  });

  it('quota exhaustion with no near retry window halts the run instead of retrying', async () => {
    let calls = 0;
    fx.script = () => { calls++; throw new NoModelError('All eligible models failed: quota exhausted', 'quota', Date.now() + 3 * 60 * 60_000); };
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    expect(calls).toBe(1);
    expect(run.status).toBe('failed');
    expect(run.summary).toMatch(/quota/i);
  });
});

describe('budgets and cancellation', () => {
  it('enforces the per-task token budget', async () => {
    updateSettings({ limits: { taskTokens: 10_000 } });
    // Every step reads a file and never finishes; each prompt is large.
    fx.script = scripted({ coder: (_r, n) => `<read path="notes${n}.txt"/>` + ' '.repeat(50_000) });
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    const code = tasksOf(run.id).find(t => t.kind === 'code')!;
    expect(code.status).toBe('failed');
    expect(code.errorCategory).toBe('budget');
    expect(fx.calls.filter(c => c.role === 'coder').length).toBeLessThanOrEqual(2);
  });

  it('stops an agent that repeats the same failing action', async () => {
    fx.script = scripted({ coder: () => '<run>node missing-script.js</run>' });
    updateSettings({ execution: { autoApprove: ['node '] } });
    const run = await finished(startRun(project().id, 'Build a website that is a simple calculator').id, 30000);
    const code = tasksOf(run.id).find(t => t.kind === 'code')!;
    expect(code.status).toBe('failed');
    expect(code.errorCategory).toBe('no_progress');
    expect(fx.calls.filter(c => c.role === 'coder').length).toBeLessThanOrEqual(3);
  }, 40000);

  it('cancellation stops the in-flight model call and leaves no task running', async () => {
    fx.script = (req) => new Promise((_res, rej) => req.signal.addEventListener('abort', () => rej(new CancelledError())));
    const run = startRun(project().id, 'Build a website that is a simple calculator');
    await vi.waitFor(() => expect(tasksOf(run.id).some(t => t.status === 'running')).toBe(true));
    expect(cancelRun(run.id)).toBe(true);
    const done = await finished(run.id);
    expect(done.status).toBe('cancelled');
    expect(tasksOf(run.id).filter(t => !['completed', 'failed', 'skipped', 'cancelled'].includes(t.status))).toHaveLength(0);
  });
});

describe('crash recovery', () => {
  it('marks interrupted work cancelled and resumes without redoing completed implementation', async () => {
    // Complete implementation, then fail verification once so the run ends needing attention.
    fx.gates = (_c, _t, cycle) => (cycle >= 1 ? { failures: [{ gate: 'browser' as GateId, summary: 'Browser test found problems', details: 'Home page is blank' }] } : { failures: [] });
    updateSettings({ behavior: { maxRepairCycles: 0 } });
    const first = await finished(startRun(project().id, 'Build a website that is a simple calculator').id);
    expect(first.status).toBe('attention');
    const codeCalls = fx.calls.filter(c => c.role === 'coder').length;
    // Simulate a crash during a later verification: the persisted run says running with a running task.
    const stored = runOf(first.id); stored.status = 'running'; db().put('runs', stored.id, stored, { project_id: stored.projectId, started_at: stored.startedAt });
    const test = tasksOf(first.id).find(t => t.kind === 'test')!;
    db().put('tasks', test.id, { ...test, status: 'running' }, { run_id: test.runId, created_at: test.createdAt });
    expect(markInterruptedRuns()).toBe(1);
    expect(runOf(first.id).status).toBe('cancelled');
    expect(tasksOf(first.id).find(t => t.id === test.id)!.status).toBe('cancelled');
    expect(tasksOf(first.id).find(t => t.kind === 'code')!.status).toBe('completed');
    // Resume: verification passes now; the completed coder task is not executed again.
    fx.gates = () => ({ failures: [] });
    resumeRun(first.id);
    const resumed = await finished(first.id);
    expect(fx.calls.filter(c => c.role === 'coder').length).toBe(codeCalls);
    expect(resumed.status).toBe('completed');
  });
});
