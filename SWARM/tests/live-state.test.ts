import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDb } from '../electron/core/db';
import { bus, emit, queryEvents } from '../electron/core/bus';
import { compactEvents } from '../electron/core/eventCompaction';
import type { SwarmEvent } from '../shared/types';

afterEach(() => { bus.flush(); bus.attach(() => {}, () => {}); });

describe('live execution state transport', () => {
  it('delivers and persists task and agent state when diagnostic logging is off', () => {
    initDb(path.join(mkdtempSync(path.join(tmpdir(), 'swarm-live-')), 'test.db'));
    bus.debug = false;
    const received: SwarmEvent[] = [];
    bus.attach(batch => received.push(...batch), () => {});
    for (const type of ['TASK_CREATED', 'TASK_UPDATED', 'AGENT_STATUS'] as const) emit(type, type, { runId: 'live' }, 'debug', { state: type });
    emit('MODEL_SELECTED', 'diagnostic only', { runId: 'live' }, 'debug');
    bus.flush();
    expect(received.map(e => e.type)).toEqual(['TASK_CREATED', 'TASK_UPDATED', 'AGENT_STATUS']);
    expect(queryEvents({ runId: 'live' }).map(e => e.type).sort()).toEqual(['AGENT_STATUS', 'TASK_CREATED', 'TASK_UPDATED']);
  });

  it('retains the newest task state when historical events are compacted', () => {
    const events = Array.from({ length: 301 }, (_, i) => ({ id: String(i), ts: i, type: 'TASK_UPDATED', level: 'info', agent: 'coder', taskId: 'task', runId: 'run', projectId: 'project', message: String(i), data: { task: { status: i === 300 ? 'completed' : 'running' } } } as SwarmEvent));
    const result = compactEvents(events, 300);
    expect(result.at(-1)?.data).toEqual({ task: { status: 'completed' } });
  });
});
