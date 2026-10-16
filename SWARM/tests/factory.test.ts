import { describe, expect, it, vi } from 'vitest';
import { isSmallChange, missingEvidence } from '../electron/core/factory';
import { parseActions } from '../electron/agents/protocol';
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false } }));
vi.mock('../electron/core/notify', () => ({ notify: vi.fn() }));
import { ComputerAction } from '../electron/computer/windows';
import { requestApproval, listApprovals, resolveApproval, denyAllForRun } from '../electron/tools/approvals';

describe('factory admission and evidence', () => {
  it('keeps simple fixes small and complex work planned', () => {
    expect(isSmallChange('Fix this CLI project')).toBe(true);
    expect(isSmallChange('Change the heading color')).toBe(true);
    for (const objective of ['Build a Windows finance tracker', 'Fix the authentication architecture', 'Migrate the entire database']) expect(isSmallChange(objective)).toBe(false);
  });
  it('requires actual platform evidence, including absent gates', () => {
    expect(missingEvidence('windows', [])).toEqual(['desktop_launch']);
    expect(missingEvidence('android', [{ id: 'mobile_build', status: 'passed' }])).toEqual(['mobile_emulator']);
    expect(missingEvidence('api', [{ id: 'build', status: 'passed' }])).toEqual(['service_start', 'endpoint_tests']);
    expect(missingEvidence('cli', [{ id: 'cli_help', status: 'passed' }])).toEqual([]);
  });
  it('parses computer actions but does not execute tags inside file content', () => {
    expect(parseActions('<computer>{"action":"observe","pid":10}</computer>').actions).toEqual([{ type: 'computer', json: '{"action":"observe","pid":10}' }]);
    expect(parseActions('<write path="test.txt"><computer>{}</computer></write>').actions).toHaveLength(1);
    expect(ComputerAction.safeParse({ action: 'shell', command: 'anything' }).success).toBe(false);
    expect(ComputerAction.safeParse({ action: 'click', pid: -1, automationId: '' }).success).toBe(false);
  });
});

describe('task-scoped approval', () => {
  const req = { projectId: 'p', runId: 'r1', agent: 'coder' as const, kind: 'command' as const, title: 'Install', detail: 'npm install', risk: 'high' as const };
  it('does not inherit another run permission', async () => {
    const first = requestApproval(req); resolveApproval(listApprovals()[0].id, true, true); expect(await first).toBe(true);
    expect(await requestApproval(req)).toBe(true);
    const second = requestApproval({ ...req, runId: 'r2' }); expect(listApprovals()).toHaveLength(1);
    denyAllForRun('r2'); expect(await second).toBe(false); denyAllForRun('r1');
  });
  it('cancels pre-aborted requests without leaving a dialog', async () => {
    const ctrl = new AbortController(); ctrl.abort();
    await expect(requestApproval(req, ctrl.signal)).rejects.toThrow(); expect(listApprovals()).toHaveLength(0);
  });
  it('never grants repeated native interactions implicitly', async () => {
    const first = requestApproval({ ...req, kind: 'computer' }); resolveApproval(listApprovals()[0].id, true, true); await first;
    const second = requestApproval({ ...req, kind: 'computer' }); expect(listApprovals()).toHaveLength(1); denyAllForRun('r1'); expect(await second).toBe(false);
  });
});
