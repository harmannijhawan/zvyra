import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project, Run, Task } from '../shared/types';
vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
const model = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../electron/router/router', () => ({ complete: model.complete }));
import { db, initDb } from '../electron/core/db';
import { bus } from '../electron/core/bus';
import { RunContext } from '../electron/agents/runContext';
import { callModel } from '../electron/agents/runtime';
import { defaultSettings } from '../shared/settings';
import { timeOperation } from '../electron/core/performance';
let ctx: RunContext;
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-messages-'));
  initDb(path.join(root, 'test.db'));
  const run = { id: 'communication', projectId: 'p', status: 'running', startedAt: Date.now(), objective: 'Build app', options: {}, stats: { tasks: 0, completed: 0, failed: 0, modelCalls: 0, fallbacks: 0, tokens: 0 }, gates: [] } as unknown as Run;
  ctx = new RunContext(run, { id: 'p', path: root } as Project, defaultSettings());
  model.complete.mockReset();
});
afterEach(() => { ctx.stopHeartbeat(); bus.flush(); });
it('persists and delivers Coder→Tester, Tester→Coder and Researcher→Manager without model calls', () => {
  const received: string[] = [];
  const listener = (e: any) => { if (e.type === 'AGENT_MESSAGE') received.push(e.data.message.id); };
  bus.on('event', listener);
  try {
    const a = ctx.message('coder', 'tester', 'Ready to verify', null, 'HANDOFF');
    const b = ctx.message('tester', 'coder', '401 from API', null, 'TEST_FAILURE');
    const c = ctx.message('researcher', 'manager', 'Licensed texture found', null, 'FINDING');
    expect(received).toEqual([a.id, b.id, c.id]);
    expect(ctx.inbox('coder')).toEqual([b]);
    expect(ctx.inbox('tester')).toEqual([a]);
    expect(ctx.inbox('manager')).toEqual([c]);
    expect(db().list('messages', 'run_id = ?', [ctx.run.id])).toHaveLength(3);
    expect(model.complete).not.toHaveBeenCalled();
  } finally { bus.removeListener('event', listener); }
});
it('includes messages arriving between agent reasoning steps in the next request', async () => {
  const t = ctx.addTask({ key: 'code', title: 'Implement API', description: 'Implement', role: 'coder', kind: 'code', deps: [], scope: [] });
  model.complete.mockImplementation(async () => ({ text: 'Done', value: 'Done', model: { displayName: 'Test' }, result: { promptTokens: 1, completionTokens: 1 } }));
  await callModel(ctx, t, [{ role: 'user', content: 'Implement API' }]);
  ctx.message('tester', 'coder', 'API endpoint returns 401', null, 'TEST_FAILURE');
  await callModel(ctx, t, [{ role: 'user', content: 'Continue' }]);
  expect(JSON.stringify(model.complete.mock.calls[1][0].messages)).toContain('API endpoint returns 401');
});
it('wakes a scheduler immediately when new graph work is added', async () => {
  const wake = ctx.executionWake();
  ctx.addTask({ key: 'new', title: 'New work', description: 'Do it', role: 'designer', kind: 'design', deps: [], scope: [] });
  await wake.promise;
  wake.dispose();
});
it('does not flag silent model execution as stalled but reports an idle deadlock', () => {
  ctx.tasks.set('blocked', { id: 'blocked', role: 'coder', kind: 'code', status: 'waiting', deps: ['missing'] } as Task);
  ctx.lastActivityAt = Date.now() - 10 * 60_000;
  const events: string[] = [];
  const listener = (e: any) => events.push(e.type);
  bus.on('event', listener);
  const end = timeOperation('model', ctx.run.id);
  try {
    (ctx as any).checkForStall();
    expect(events).not.toContain('RUN_STALLED');
    end();
    (ctx as any).checkForStall();
    expect(events).toContain('RUN_STALLED');
  } finally { end(); bus.removeListener('event', listener); }
});
