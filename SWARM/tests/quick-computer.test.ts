import { describe, expect, it } from 'vitest';
import { quickComputerRequest, quickComputerInspection } from '../electron/chat/quickComputer';
import { ToolRetryGuard } from '../electron/chat/toolRetryGuard';
describe('Unambiguous computer requests', () => {
  it.each(['Check my PC and tell me what is open', 'Look at the screen and read the verification code. Do not click or type.'])('observes %s before a single vision interpretation', text => expect(quickComputerInspection(text)?.kind).toBe('inspect'));
  it.each(['Look at my screen and fix the error', 'Open Chrome and look at my PC', 'Read my code file'])('keeps %s in agentic planning', text => expect(quickComputerInspection(text)).toBeNull());
  it.each(['Open Chrome', 'could you open Google Chrome please?', 'Hey SWARM, launch Chrome.'])('directly routes %s', text => expect(quickComputerRequest(text)?.actions[0]).toMatchObject({ action: 'open_application', application: 'chrome' }));
  it.each(['Open Chrome and check why my website fails', 'open cmd', 'open https://user:password@example.com', 'fix the browser', 'open Chrome; remove files'])('keeps %s in conversational planning', text => expect(quickComputerRequest(text)).toBeNull());
  it('uses observed PC operations for explicit web navigation', () => expect(quickComputerRequest('go to https://example.com/login')?.actions.map(a => a.action)).toEqual(['open_application', 'hotkey', 'type', 'key']));
});
describe('Failed tool retries', () => {
  it('blocks different project command attempts without a project until context changes', () => {
    const guard = new ToolRetryGuard(); guard.failed({ type: 'run', command: 'start chrome' }, undefined, 'Select a project first');
    expect(guard.blocked({ type: 'run', command: 'powershell start-process chrome' })).toContain('Select a project first');
    expect(guard.blocked({ type: 'run', command: 'npm test' }, 'actual-project')).toBeUndefined();
    guard.changed(); expect(guard.blocked({ type: 'run', command: 'start chrome' })).toBeUndefined();
  });
  it('ignores cosmetic intent changes in repeated computer failures', () => {
    const guard = new ToolRetryGuard(); guard.failed({ type: 'computer', json: '{"action":"click","x":10,"y":20,"intent":"first"}' }, undefined, 'Stale observation');
    expect(guard.blocked({ type: 'computer', json: '{"action":"click","x":10,"y":20,"intent":"again"}' })).toContain('Stale observation');
    expect(guard.blocked({ type: 'computer', json: '{"action":"screenshot"}' })).toBeUndefined();
  });
});
