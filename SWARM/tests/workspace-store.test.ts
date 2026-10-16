import { beforeEach, describe, expect, it, vi } from 'vitest';
import { belongsToWork, mergeWorkEvents, useWork, workActivity, type WorkEvent, type WorkSnapshot } from '../src/lib/workspace';

const event = (id: string, sequence: number, extra: Partial<WorkEvent> = {}): WorkEvent => ({ id, sequence, ts: sequence, type: 'file_modified', message: id, ...extra });
const snapshot = (events: WorkEvent[] = []): WorkSnapshot => ({ events, cursor: events.at(-1)?.sequence ?? 0, hasMore: false, agents: [], files: [], approvals: [] });
beforeEach(() => { useWork.setState({ scope: {}, events: [], agents: [], files: [], approvals: [], error: '', loading: false }); });

describe('authoritative workspace client', () => {
  it('keeps operations isolated but accepts direct conversation computer tools', () => {
    expect(belongsToWork(event('pc', 1, { runId: 'chat-a' }), { conversationId: 'chat-a' })).toBe(true);
    expect(belongsToWork(event('other', 2, { conversationId: 'chat-b', runId: 'run-b' }), { conversationId: 'chat-a', runId: 'run-a' })).toBe(false);
    expect(belongsToWork(event('agent', 3, { runId: 'run-a' }), { conversationId: 'chat-a', runId: 'run-a' })).toBe(true);
  });
  it('deduplicates replay and cannot replace a newer event with stale history', () => {
    expect(mergeWorkEvents([event('same', 5)], [event('same', 2), event('new', 7)]).map(value => value.sequence)).toEqual([5, 7]);
  });
  it('folds real command completion without leaving an old running card', () => {
    const cards = workActivity([
      event('start-a', 1, { type: 'command_started', status: 'running', data: { commandId: 'a' } }),
      event('start-b', 2, { type: 'command_started', status: 'running', data: { commandId: 'b' } }),
      event('done-a', 3, { type: 'command_finished', status: 'complete', data: { commandId: 'a', exitCode: 0 } }),
    ]);
    expect(cards.map(value => value.id)).toEqual(['done-a', 'start-b']);
  });
  it('retains live events received while the initial replay is loading', async () => {
    let finish!: (result: WorkSnapshot) => void;
    const invoke = vi.fn(() => new Promise<WorkSnapshot>(resolve => { finish = resolve; }));
    vi.stubGlobal('window', { swarm: { invoke } });
    const request = useWork.getState().open({ conversationId: 'chat' });
    useWork.getState().ingest(event('live', 2, { conversationId: 'chat' }));
    finish(snapshot([event('history', 1, { conversationId: 'chat' })]));
    await request;
    expect(useWork.getState().events.map(value => value.id)).toEqual(['history', 'live']);
  });
  it('cannot leak an old conversation snapshot into a newly opened one', async () => {
    const pending: Array<(result: WorkSnapshot) => void> = [];
    vi.stubGlobal('window', { swarm: { invoke: vi.fn(() => new Promise<WorkSnapshot>(resolve => pending.push(resolve))) } });
    const first = useWork.getState().open({ conversationId: 'first' });
    const second = useWork.getState().open({ conversationId: 'second' });
    pending[1](snapshot([event('second', 2)])); await second;
    pending[0](snapshot([event('first', 1)])); await first;
    expect(useWork.getState().scope.conversationId).toBe('second');
    expect(useWork.getState().events.map(value => value.id)).toEqual(['second']);
  });
});
