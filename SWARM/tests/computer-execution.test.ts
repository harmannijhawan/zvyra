import { beforeEach, describe, expect, it, vi } from 'vitest';
const pc = vi.hoisted(() => ({ screenshot: vi.fn(), inject: vi.fn(async () => true), emit: vi.fn(), send: vi.fn(), approval: vi.fn(async () => true) }));
vi.mock('electron', () => ({ screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), dipToScreenPoint: (p: unknown) => p }, nativeImage: { createFromBuffer: () => ({ resize: () => ({ toJPEG: () => Buffer.from('preview') }) }) } }));
vi.mock('../electron/remote/desktop', () => ({ getDesktopCapture: () => ({ screenshot: pc.screenshot, mapInput: (e: unknown) => e }), getInputInjector: () => ({ inject: pc.inject, releaseAll: async () => undefined }), getNutJs: vi.fn() }));
vi.mock('../electron/core/settings', () => ({ getSettings: () => ({ computer: { native: true } }) }));
vi.mock('../electron/tools/approvals', () => ({ requestApproval: pc.approval }));
vi.mock('../electron/core/bus', () => ({ emit: pc.emit, bus: { send: pc.send } }));
import { PcControlService } from '../electron/computer/service';
const scope = { runId: 'conversation', agent: 'manager' as const, userIntent: 'Check my PC' };
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.clearAllMocks();
  pc.screenshot.mockResolvedValue({ image: Buffer.from('jpeg'), width: 1280, height: 720, sequence: 0, timestamp: Date.now() });
});
describe('shared PC service observation / action / observation loop', () => {
  it('returns visual evidence after real input and streams safe lifecycle events', async () => {
    const service = new PcControlService();
    await service.execute({ action: 'screenshot' }, scope, signal());
    const result = await service.execute({ action: 'type', text: 'private typed value' }, scope, signal());
    expect(pc.inject).toHaveBeenCalledWith({ type: 'key', text: 'private typed value' });
    expect(pc.screenshot).toHaveBeenCalledTimes(2);
    expect(result.image).toBe('data:image/jpeg;base64,anBlZw==');
    const events = pc.emit.mock.calls;
    expect(events.some(([type]) => type === 'COMPUTER_STARTED')).toBe(true);
    expect(events.some(([type]) => type === 'COMPUTER_OBSERVATION')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private typed value');
    expect(JSON.stringify(events)).not.toContain('base64');
    expect(service.controlling).toBe(false);
  });
  it('rejects stale coordinates when the phone takes over, and accepts move after observing again', async () => {
    const service = new PcControlService();
    await service.execute({ action: 'screenshot' }, scope, signal());
    await service.mobileInput({ type: 'move', x: 10, y: 10 });
    await expect(service.execute({ action: 'move', x: 100, y: 100 }, scope, signal())).rejects.toThrow('Observe again');
    await service.execute({ action: 'screenshot' }, scope, signal());
    await service.execute({ action: 'move', x: 100, y: 100 }, scope, signal());
    expect(pc.inject).toHaveBeenLastCalledWith({ type: 'move', x: 150, y: 150 });
  });
  it('invalidates other agents after acting and reports failed native input', async () => {
    const service = new PcControlService();
    const other = { ...scope, agent: 'coder' as const };
    await service.execute({ action: 'screenshot' }, scope, signal());
    await service.execute({ action: 'screenshot' }, other, signal());
    await service.execute({ action: 'click', x: 20, y: 20 }, scope, signal());
    await expect(service.execute({ action: 'click', x: 20, y: 20 }, other, signal())).rejects.toThrow('Observe again');
    pc.inject.mockResolvedValueOnce(false);
    await expect(service.execute({ action: 'click', x: 20, y: 20 }, scope, signal())).rejects.toThrow('OS input failed');
    expect(pc.emit.mock.calls.some(([type, , , , data]) => type === 'COMPUTER_ACTION' && data.status === 'failed')).toBe(true);
  });
});
