import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Gateway } from '../electron/remote/gateway';
import { ROLE_META } from '../src/components/status';

describe('mobile companion application commands', () => {
  const invoke = vi.fn(async () => ({ id: 'created' }));
  const gateway = new Gateway(invoke, { pcName: 'Test', appVersion: '1' });

  it('uses every desktop agent name and description', () => {
    const source = readFileSync('app/src/main/java/com/swarm/ai/ui/companion/CompanionViewModel.kt', 'utf8');
    for (const [role, meta] of Object.entries(ROLE_META)) {
      expect(source).toContain(`AgentIdentity("${role}", "${meta.name}", "${meta.title}")`);
    }
  });
  it('creates projects only in the desktop managed workspace', async () => {
    await gateway.invokeChannel('projects:create', [{ objective: 'Build a timer', path: 'C:/Windows', name: 'injected' }]);
    expect(invoke).toHaveBeenLastCalledWith('projects:create', { objective: 'Build a timer' });
    await expect(gateway.invokeChannel('projects:create', [{ objective: '' }])).rejects.toMatchObject({ status: 400 });
  });
  it('passes bounded text attachments while denying provider overrides', async () => {
    await gateway.invokeChannel('chat:send', [{ id: 'c1', text: 'Hello', model: 'override', attachments: [{ name: 'x', text: 'x' }] }]);
    expect(invoke).toHaveBeenLastCalledWith('chat:send', { id: 'c1', text: 'Hello', attachments: [{ name: 'x', text: 'x' }] });
    await expect(gateway.invokeChannel('chat:send', [{ id: 'c1', text: 'x'.repeat(8001) }])).rejects.toMatchObject({ status: 400 });
    await expect(gateway.invokeChannel('chat:send', [{ id: 'c1', text: 'read', attachments: [{ name: 'file', text: 'x'.repeat(16001) }] }])).rejects.toMatchObject({ status: 400 });
  });
  it('bounds history and continues to deny sensitive channels', async () => {
    await gateway.invokeChannel('run:chat:history', ['r1:coder', 999999]);
    expect(invoke).toHaveBeenLastCalledWith('run:chat:history', 'r1:coder', 100);
    for (const channel of ['settings:update', 'providers:setKey', 'terminal:run', 'projects:writeFile', 'app:openPath']) {
      await expect(gateway.invokeChannel(channel, [])).rejects.toMatchObject({ status: 403 });
    }
  });
});
