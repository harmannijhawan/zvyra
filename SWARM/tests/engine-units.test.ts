// Unit-level regression tests for the task engine, runtime guards, readiness and strategy selection.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project, QualityGate, Run, Task } from '../shared/types';

vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../electron/core/notify', () => ({ notify: vi.fn() }));
const model = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../electron/router/router', async (orig) => ({ ...await orig<typeof import('../electron/router/router')>(), complete: model.complete }));

import { initDb, db } from '../electron/core/db';
import { bus } from '../electron/core/bus';
import { RunContext } from '../electron/agents/runContext';
import { canTransition } from '../electron/agents/taskState';
import { __engine, failureSignature } from '../electron/agents/orchestrator';
import { compactHistory, runAgentLoop } from '../electron/agents/runtime';
import { NoModelError } from '../electron/router/router';
import { estimatePromptTokens } from '../electron/providers/http';
import { staticCheck } from '../electron/agents/staticChecks';
import { computeReadiness } from '../electron/core/readiness';
import { selectExecutionMode } from '../electron/agents/strategy';
import { markInterruptedRuns } from '../electron/core/recovery';
import { defaultSettings } from '../shared/settings';
import type { ChatMessage } from '../electron/providers/types';

let ctx: RunContext;
let root: string;
const ok = (text: string, promptTokens = 100) => ({ text, value: text, model: { id: 'm::a', providerId: 'm', modelId: 'a', displayName: 'A' }, result: { promptTokens, completionTokens: 10, usageEstimated: false } });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-units-'));
  initDb(path.join(root, 'test.db'));
  const run = { id: 'run_units', projectId: 'p', status: 'running', startedAt: Date.now(), objective: 'Build app', options: { autonomy: 'autonomous', attachments: [], pinnedModel: null, webResearch: false }, stats: { tasks: 0, completed: 0, failed: 0, modelCalls: 0, fallbacks: 0, tokens: 0, files: 0, commands: 0, sources: 0 }, gates: [], repairCycles: 0, mode: 'simple' } as unknown as Run;
  ctx = new RunContext(run, { id: 'p', path: root } as Project, defaultSettings());
  model.complete.mockReset();
});
afterEach(() => { ctx.stopHeartbeat(); bus.flush(); });

describe('task lifecycle state machine', () => {
  it('allows the forward path and forbids terminal → running without an explicit retry', () => {
    for (const [a, b] of [['waiting', 'running'], ['running', 'verifying'], ['verifying', 'completed'], ['running', 'retry_wait'], ['retry_wait', 'waiting'], ['running', 'blocked']] as const) expect(canTransition(a, b)).toBe(true);
    for (const s of ['completed', 'failed', 'cancelled', 'skipped'] as const) {
      expect(canTransition(s, 'running')).toBe(false);
      expect(canTransition(s, 'running', { retry: true })).toBe(false);
    }
    expect(canTransition('failed', 'waiting')).toBe(false);
    expect(canTransition('failed', 'waiting', { retry: true })).toBe(true);
  });
  it('RunContext refuses an illegal transition and keeps the terminal state', () => {
    const t = ctx.addTask({ key: 'a', title: 'A', description: '', role: 'coder', kind: 'code', deps: [], scope: [] });
    ctx.updateTask(t, { status: 'running' });
    ctx.updateTask(t, { status: 'completed' });
    expect(ctx.updateTask(t, { status: 'running', output: 'late' })).toBe(false);
    expect(t.status).toBe('completed');
    expect(t.output).toBe('late'); // the rest of the patch still applies
    expect(ctx.updateTask(t, { status: 'waiting' }, undefined, { retry: true })).toBe(true);
  });
});

describe('task engine', () => {
  it('detects a dependency cycle and reports the blocker instead of waiting forever', async () => {
    const a = ctx.addTask({ key: 'a', title: 'Alpha', description: '', role: 'coder', kind: 'code', deps: [], scope: [] });
    const b = ctx.addTask({ key: 'b', title: 'Beta', description: '', role: 'designer', kind: 'design', deps: [a.id], scope: [] });
    a.deps = [b.id];
    const c = ctx.addTask({ key: 'c', title: 'Gamma', description: '', role: 'architect', kind: 'architecture', deps: ['tk_missing'], scope: [] });
    await __engine.executeGraph(ctx);
    expect(a.status).toBe('blocked'); expect(a.blocker).toMatch(/Dependency cycle/);
    expect(b.status).toBe('blocked');
    expect(c.status).toBe('blocked'); expect(c.blocker).toMatch(/Missing dependency tk_missing/);
  });
  it('prevents duplicate execution of one task', async () => {
    const t = ctx.addTask({ key: 'i', title: 'Install', description: '', role: 'tester', kind: 'install', deps: [], scope: [] });
    const started: string[] = [];
    const listener = (e: any) => { if (e.type === 'TASK_STARTED') started.push(e.data.task.id); };
    bus.on('event', listener);
    try { await Promise.all([__engine.runTask(ctx, t), __engine.runTask(ctx, t), __engine.runTask(ctx, t)]); }
    finally { bus.removeListener('event', listener); }
    expect(started).toEqual([t.id]);
    expect(t.status).toBe('completed');
    await __engine.runTask(ctx, t); // terminal: not re-run
    expect(t.status).toBe('completed');
  });
  it('a stuck task times out with a recorded budget reason', async () => {
    ctx.settings = { ...ctx.settings, limits: { ...ctx.settings.limits, taskMinutes: 1 } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      model.complete.mockImplementation((opts: any) => new Promise((_r, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted')))));
      const t = ctx.addTask({ key: 'd', title: 'Design', description: '', role: 'designer', kind: 'design', deps: [], scope: [] });
      const p = __engine.runTask(ctx, t);
      await vi.advanceTimersByTimeAsync(61_000);
      await p;
      expect(t.status).toBe('failed');
      expect(t.errorCategory).toBe('budget');
      expect(t.error).toMatch(/exceeded its 1-minute time limit/);
    } finally { vi.useRealTimers(); }
  });
  it('marks interrupted runs and their active tasks after a crash, keeping completed work', () => {
    const run = { ...ctx.run, id: 'run_crash', status: 'running' } as Run;
    db().put('runs', run.id, run, { project_id: 'p', started_at: run.startedAt });
    const mk = (id: string, status: Task['status']) => db().put('tasks', id, { id, runId: run.id, status, kind: 'code', createdAt: Date.now() } as Task, { run_id: run.id, created_at: Date.now() });
    mk('t1', 'completed'); mk('t2', 'running'); mk('t3', 'verifying'); mk('t4', 'retry_wait');
    expect(markInterruptedRuns()).toBe(1);
    const tasks = Object.fromEntries(db().list<Task>('tasks', 'run_id = ?', [run.id]).map(t => [t.id, t]));
    expect(tasks.t1.status).toBe('completed');
    expect(tasks.t2.status).toBe('cancelled'); expect(tasks.t2.error).toMatch(/Interrupted/);
    expect(tasks.t3.status).toBe('cancelled'); expect(tasks.t4.status).toBe('cancelled');
    expect(db().get<Run>('runs', run.id)!.status).toBe('cancelled');
  });
  it('failure signatures ignore volatile numbers and paths but distinguish different failures', () => {
    const a = failureSignature([{ gate: 'unit', summary: '`npm test` failed (exit 1)', details: 'C:\\tmp\\a\\calc.test.js:12 expected 4 got 5 in 31ms' }]);
    const b = failureSignature([{ gate: 'unit', summary: '`npm test` failed (exit 1)', details: 'C:\\tmp\\b\\calc.test.js:14 expected 4 got 5 in 87ms' }]);
    const c = failureSignature([{ gate: 'build', summary: '`npm run build` failed (exit 2)', details: 'Cannot find module react' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('agent runtime guards', () => {
  const task = () => ctx.addTask({ key: 'c', title: 'Code', description: '', role: 'coder', kind: 'code', deps: [], scope: [] });
  it('recovers from context overflow by shrinking the prompt, not by resending it', async () => {
    const t = task(); ctx.updateTask(t, { status: 'running', startedAt: Date.now() });
    const sizes: number[] = [];
    model.complete.mockImplementation(async (opts: any) => {
      sizes.push(estimatePromptTokens(opts.messages));
      if (sizes.length === 3) throw new NoModelError('The prompt exceeded the context window of 2 models', 'context');
      return ok(sizes.length <= 2 ? `<write path="f${sizes.length}.txt">${'x'.repeat(4000)}</write>` : '<done>ok</done>');
    });
    const r = await runAgentLoop(ctx, t, 'system', `## Your task\nDo it\n\n## Current project files\n${'file.txt\n'.repeat(2000)}`);
    expect(r.completed).toBe(true);
    expect(sizes[3]).toBeLessThan(sizes[2]);
    expect(ctx.progress.recovery.some(x => x.category === 'context')).toBe(true);
  });
  it('does not resend written file bodies or the heavy first message on later steps (measured)', () => {
    const big = 'const x = 1;\n'.repeat(1500);
    const first = `## Your task\nBuild\n\n## Current project files\n${'src/file.ts\n'.repeat(400)}\n\n## Current content of your files\n${big}`;
    const h: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: first }];
    for (let i = 0; i < 6; i++) { h.push({ role: 'assistant', content: `<write path="f${i}.ts">[1500 lines written to disk — <read> the file to see it]</write>` }); h.push({ role: 'user', content: `Results:\n✓ wrote f${i}.ts` }); }
    // Previous behaviour (git HEAD): full first message + last 6 messages with up to 12k chars of file bodies each.
    const legacy: ChatMessage[] = [h[0], { role: 'user', content: first }, ...Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'user' : 'assistant') as 'user' | 'assistant', content: i % 2 ? 'Results: ✓ wrote' : `<write path="f.ts">${big.slice(0, 12_000)}</write>` }))];
    const before = estimatePromptTokens(legacy), after = estimatePromptTokens(compactHistory(h, 0, 7));
    console.log(JSON.stringify({ measurement: 'agent-step prompt tokens', legacy: before, current: after, reduction: `${Math.round((1 - after / before) * 100)}%` }));
    expect(after).toBeLessThan(before / 4);
  });
  it('enforces the run-level token budget before calling the model', async () => {
    ctx.settings = { ...ctx.settings, limits: { ...ctx.settings.limits, runTokens: 50_000 } };
    ctx.run.stats.tokens = 60_000;
    const t = task(); ctx.updateTask(t, { status: 'running', startedAt: Date.now() });
    await expect(runAgentLoop(ctx, t, 's', 'u')).rejects.toThrow(/Run token budget exhausted/);
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('keeps the task on its working model (affinity is requested on every step)', async () => {
    const t = task(); ctx.updateTask(t, { status: 'running', startedAt: Date.now() });
    model.complete.mockImplementationOnce(async (o: any) => { o.onAttempt?.({ model: { id: 'm::a', providerId: 'm', modelId: 'a', displayName: 'A' }, ok: true }); return ok('<write path="a.txt">a</write>'); })
      .mockImplementationOnce(async () => ok('<done>ok</done>'));
    await runAgentLoop(ctx, t, 's', 'u');
    expect(model.complete.mock.calls[0][0].route.preferred).toBeNull();
    expect(model.complete.mock.calls[1][0].route.preferred).toBe('m::a');
  });
});

describe('targeted static checks (real execution)', () => {
  it('flags JS syntax errors, invalid JSON and missing HTML references', async () => {
    fs.writeFileSync(path.join(root, 'ok.js'), 'export const add = (a, b) => a + b;\n');
    fs.writeFileSync(path.join(root, 'bad.js'), 'function x( {\n');
    fs.writeFileSync(path.join(root, 'bad.json'), '{"a": }');
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body><script src="missing.js"></script><script src="ok.js"></script></body></html>');
    const r = await staticCheck(root, ['ok.js', 'bad.js', 'bad.json', 'index.html']);
    expect(r.checked).toHaveLength(4);
    expect(r.problems.some(p => p.startsWith('bad.js: syntax error'))).toBe(true);
    expect(r.problems.some(p => p.startsWith('bad.json: invalid JSON'))).toBe(true);
    expect(r.problems.some(p => p.includes('missing.js'))).toBe(true);
    expect(r.problems.some(p => p.startsWith('ok.js'))).toBe(false);
  });
});

describe('production readiness evidence', () => {
  const g = (id: string, status: QualityGate['status'], detail = ''): QualityGate => ({ id: id as QualityGate['id'], label: id, status, detail, ts: 0, attempt: 1 });
  const code = { kind: 'code', status: 'completed', filesTouched: ['index.html'] } as Task;
  it('is not established when tasks completed but nothing was verified', () => {
    const r = computeReadiness({ target: 'web', objective: 'Build a calculator', gates: [], tasks: [code] });
    expect(r.productionReady).toBe(false);
    expect(r.runtimeVerified.status).toBe('not_run');
    expect(r.testsVerified.status).toBe('not_run');
  });
  it('distinguishes build, tests, runtime, review and deployment', () => {
    const r = computeReadiness({ target: 'web', objective: 'Build a calculator and deploy it to production', tasks: [code], gates: [g('build', 'passed', 'npm run build exited 0'), g('unit', 'failed', 'npm test exited 1'), g('server', 'passed'), g('browser', 'passed')] });
    expect(r.buildVerified.status).toBe('verified');
    expect(r.testsVerified.status).toBe('failed');
    expect(r.runtimeVerified.status).toBe('verified');
    expect(r.securityReviewed.status).toBe('not_run');
    expect(r.deploymentVerified.status).toBe('not_run');
    expect(r.productionReady).toBe(false);
  });
  it('requires the platform\'s required runtime evidence', () => {
    const r = computeReadiness({ target: 'android', objective: 'Build an Android app', tasks: [code], gates: [g('mobile_build', 'passed')] });
    expect(r.runtimeVerified.status).toBe('not_run');
    expect(r.runtimeVerified.evidence).toMatch(/mobile_emulator/);
  });
});

describe('execution strategy selection', () => {
  const opts = { existingFiles: false, attachments: 0, webResearch: true };
  it.each(['Build a website that is a simple calculator', 'Build a website that make a simple calculator with great ui', 'Make a todo list app', 'Create a CLI password generator'])('"%s" is simple', (o) => {
    expect(selectExecutionMode(o, opts).mode).toBe('simple');
  });
  it('uses standard for moderate scope and complex for multi-subsystem platforms', () => {
    expect(selectExecutionMode('Build a recipe website with a REST API backend for saving favourites', opts).mode).toBe('standard');
    expect(selectExecutionMode('Build a SaaS platform with user login, a Postgres database, Stripe payments, an admin dashboard and deployment with Docker', opts).mode).toBe('complex');
    expect(selectExecutionMode('Fix the broken submit button', { ...opts, existingFiles: true }).mode).toBe('simple');
  });
  it('enables research only when the objective asks for researched content', () => {
    expect(selectExecutionMode('Build a website that is a simple calculator', opts).research).toBe(false);
    expect(selectExecutionMode('Build a site comparing current prices of the latest laptops with sources', opts).research).toBe(true);
  });
});
