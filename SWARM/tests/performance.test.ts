import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { initDb } from '../electron/core/db';
import { saveCheckpoint } from '../electron/core/checkpoint';
import { timeOperation, hasActiveOperations, performanceSnapshot } from '../electron/core/performance';
import type { Task } from '../shared/types';

it('measures checkpoint cost for repeated gate/state saves with 30 completed tasks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-perf-'));
  initDb(path.join(root, 'test.db'));
  const tasks = new Map<string, Task>();
  for (let i = 0; i < 30; i++) {
    const file = `file-${i}.ts`;
    fs.writeFileSync(path.join(root, file), 'export const value = 42;\n'.repeat(1000));
    tasks.set(String(i), { id: String(i), runId: 'perf', key: String(i), title: 'Code', description: 'Implement', role: 'coder', kind: 'code', status: 'completed', deps: [], attempt: 1, scope: [file], filesTouched: [file], output: 'Done', error: null, modelId: null, startedAt: 0, endedAt: i + 1, createdAt: 0, tokens: 0 });
  }
  const started = performance.now();
  for (let i = 0; i < 100; i++) saveCheckpoint('perf', 'p', null, '', new Map(), new Map(), tasks, root, 0);
  console.log(JSON.stringify({ checkpoint100Ms: performance.now() - started }));
  expect(tasks.size).toBe(30);
});

it('tracks active work independently of streaming or log events', () => {
  const end = timeOperation('model', 'tracked');
  expect(hasActiveOperations('tracked')).toBe(true);
  end(); end();
  expect(hasActiveOperations('tracked')).toBe(false);
  expect(performanceSnapshot('tracked').model.count).toBe(1);
});
