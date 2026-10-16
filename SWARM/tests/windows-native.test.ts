import { expect, it, vi } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false } }));
vi.mock('../electron/tools/approvals', () => ({ requestApproval: vi.fn(async () => true) }));
import { nativeWindowsAction, verifyWindowsExecutable } from '../electron/computer/windows';

it.skipIf(process.platform !== 'win32' || process.env.SWARM_NATIVE_QA !== '1')('operates a real WPF window, types and invokes a button', async () => {
  const script = `Add-Type -AssemblyName PresentationFramework
  $w = New-Object Windows.Window; $w.Title='SWARM isolated native QA'; $w.Width=360; $w.Height=200
  $panel = New-Object Windows.Controls.StackPanel
  $text = New-Object Windows.Controls.TextBox; [Windows.Automation.AutomationProperties]::SetAutomationId($text,'qa-input')
  $button = New-Object Windows.Controls.Button; $button.Content='Verify'; [Windows.Automation.AutomationProperties]::SetAutomationId($button,'qa-button')
  $button.Add_Click({$text.Text='Verified'})
  $panel.Children.Add($text) | Out-Null; $panel.Children.Add($button) | Out-Null; $w.Content=$panel
  $w.ShowDialog() | Out-Null`;
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, stdio: 'ignore' });
  const signal = AbortSignal.timeout(45000);
  try {
    let observation = '';
    for (let i = 0; i < 12; i++) {
      try { observation = await nativeWindowsAction({ action: 'observe', pid: child.pid! }, signal); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    expect(observation).toContain('qa-input');
    const typed = await nativeWindowsAction({ action: 'type', pid: child.pid!, automationId: 'qa-input', text: 'Real input' }, signal);
    expect(JSON.parse(typed).action).toBe('type');
    expect(JSON.parse(typed).controls.find((c: any) => c.id === 'qa-input').value).toBe('Real input');
    const clicked = await nativeWindowsAction({ action: 'click', pid: child.pid!, automationId: 'qa-button' }, signal);
    expect(JSON.parse(clicked).action).toBe('click');
    const after = JSON.parse(await nativeWindowsAction({ action: 'observe', pid: child.pid! }, signal));
    expect(after.controls.find((c: any) => c.id === 'qa-input').value).toBe('Verified');
    await expect(nativeWindowsAction({ action: 'click', pid: child.pid!, automationId: 'missing-control' }, signal)).rejects.toThrow();
  } finally { child.kill(); }
}, 60000);

it.skipIf(process.platform !== 'win32' || process.env.SWARM_NATIVE_QA !== '1')('compiles an EXE and verifies its launched window', async () => {
  const root = path.resolve('.swarm-test', 'native-exe-' + Date.now());
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, 'Fixture.cs');
  fs.writeFileSync(source, 'using System; using System.Windows.Forms; class Fixture { [STAThread] static void Main() { var form = new Form(); form.Text = "SWARM compiled EXE verification"; form.Controls.Add(new Button { Text = "Real executable" }); Application.Run(form); } }');
  const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await promisify(execFile)(compiler, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/out:' + path.join(root, 'Fixture.exe'), source], { windowsHide: true });
  const observation = await verifyWindowsExecutable(root, 'Fixture.exe', { projectId: 'native-qa', runId: 'native-qa', agent: 'tester' }, AbortSignal.timeout(30000));
  expect(JSON.parse(observation).title).toBe('SWARM compiled EXE verification');
  fs.writeFileSync(path.join(root, 'evidence.json'), observation);
}, 45000);
