import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project, Run, Task } from '../shared/types';
const fixture = vi.hoisted(() => ({ ctx: null as any, respond: vi.fn(), complete: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), control: vi.fn() }));
vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../electron/core/settings', async () => { const { defaultSettings } = await import('../shared/settings'); return { getSettings: () => defaultSettings() }; });
import { initDb } from '../electron/core/db';
import { bus } from '../electron/core/bus';
import { newChat, sendChat, getChat } from '../electron/chat/service';
import { workspaceSnapshot } from '../electron/workspace/service';
describe('Persisted coordinator workspace', () => {
  it('journals status messages immediately and replays them in the correct conversation', async () => {
    initDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-replay-')), 'db.sqlite'));
    const chat = newChat(); const other = newChat();
    sendChat({ id: chat.id, text: "what's happening?" });
    expect(getChat(chat.id).turns.at(-1)?.status).toBe('complete');
    const snapshot = await workspaceSnapshot({ conversationId: chat.id });
    expect(snapshot.events.some(event => event.type === 'assistant_message')).toBe(true);
    expect((await workspaceSnapshot({ conversationId: other.id })).events.some(event => event.type === 'assistant_message')).toBe(false);
  });
});
