import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunChatTurn } from '../shared/types';
const history = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/api', () => ({ api: { runChat: { history } } }));
import { useStore } from '../src/lib/store';

const turn = (id: string, senderType: 'user' | 'manager', text: string): RunChatTurn => ({ id, senderType, text, ts: 100, runId: 'run', conversationId: 'run:manager', senderId: senderType, recipientType: 'manager', recipientId: 'manager', status: 'complete' });
beforeEach(() => { useStore.setState({ runChats: {} }); history.mockReset(); });

describe('live conversation state', () => {
  it('places a batched user message before an immediate response with the same timestamp', () => {
    useStore.getState().ingestRunChatTurn('run:manager', turn('reply', 'manager', 'Updated'));
    useStore.getState().ingestRunChatTurn('run:manager', turn('user', 'user', 'Add settings'));
    expect(useStore.getState().runChats['run:manager'].map(t => t.id)).toEqual(['user', 'reply']);
  });

  it('does not lose a new streaming reply while earlier history is loading', async () => {
    let resolve!: (turns: RunChatTurn[]) => void;
    history.mockImplementation(() => new Promise(r => { resolve = r; }));
    const request = useStore.getState().loadRunChatHistory('run:manager');
    useStore.getState().ingestRunChatTurn('run:manager', { ...turn('reply', 'manager', 'Updating the graph'), status: 'streaming', ts: 200 });
    resolve([turn('user', 'user', 'Add settings')]);
    await request;
    expect(useStore.getState().runChats['run:manager'].map(t => t.id)).toEqual(['user', 'reply']);
    expect(useStore.getState().runChats['run:manager'][1].text).toBe('Updating the graph');
  });
});
