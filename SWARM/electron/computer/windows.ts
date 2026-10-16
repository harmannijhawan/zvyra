import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { requestApproval } from '../tools/approvals';
import { CancelledError, redact } from '../core/util';
import type { AgentRole } from '../../shared/types';
import { killTree } from '../tools/process';

export const ComputerAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('observe'), pid: z.number().int().positive() }),
  z.object({ action: z.literal('click'), pid: z.number().int().positive(), automationId: z.string().min(1).max(200) }),
  z.object({ action: z.literal('type'), pid: z.number().int().positive(), automationId: z.string().min(1).max(200), text: z.string().max(4000) }),
  z.object({ action: z.literal('scroll'), pid: z.number().int().positive(), automationId: z.string().min(1).max(200), direction: z.enum(['up', 'down']) }),
]);
export type ComputerAction = z.infer<typeof ComputerAction>;

// Fixed script, with JSON on stdin. Model text is never evaluated as PowerShell.
export const WINDOWS_UI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$a = [Console]::In.ReadToEnd() | ConvertFrom-Json
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$a.pid)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if ($null -eq $window) { throw 'No accessible window for this process' }
if ($a.action -ne 'observe') {
  $selector = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$a.automationId)
  $matches = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $selector)
  if ($matches.Count -ne 1) { throw 'Control must resolve uniquely; observe again' }
  $el = $matches.Item(0)
  if ($el.Current.IsPassword -or ($el.Current.Name + $el.Current.AutomationId) -match '(?i)password|secret|token|credential|api.?key') { throw 'Sensitive controls are not accessible to SWARM' }
  if (-not $el.Current.IsEnabled -or $el.Current.IsOffscreen) { throw 'Control is disabled or offscreen' }
  switch ($a.action) {
    'click' { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    'type' { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$a.text) }
    'scroll' {
      $amount = if ($a.direction -eq 'up') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
      $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $amount)
    }
  }
}
$nodes = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$controls = @()
for ($i=0; $i -lt [Math]::Min($nodes.Count, 120); $i++) {
  $c = $nodes.Item($i).Current
  if (-not $c.IsPassword -and ($c.Name + $c.AutomationId) -notmatch '(?i)password|secret|token|credential|api.?key') {
    $value = $null; $pattern = $null
    if ($nodes.Item($i).TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $value = $pattern.Current.Value }
    $controls += @{ id=$c.AutomationId; name=$c.Name; value=$value; type=$c.ControlType.ProgrammaticName; enabled=$c.IsEnabled; offscreen=$c.IsOffscreen }
  }
}
@{ pid=$a.pid; title=$window.Current.Name; action=$a.action; controls=$controls; observedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 5 -Compress
`;

export function nativeWindowsAction(action: ComputerAction, signal: AbortSignal): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Native UI Automation requires Windows'));
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_UI_SCRIPT],
      { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, signal },
      (error, stdout) => {
        if (signal.aborted) reject(new CancelledError());
        else if (error) reject(new Error('Windows interaction failed: ' + redact(error.message).slice(0, 500)));
        else { try { JSON.parse(stdout); resolve(redact(stdout)); } catch { reject(new Error('Windows returned invalid observation')); } }
      });
    child.stdin?.end(JSON.stringify(action));
  });
}

export async function computerAction(raw: unknown, scope: { projectId: string; runId: string; agent: AgentRole }, signal: AbortSignal) {
  const action = ComputerAction.parse(raw);
  if (process.platform !== 'win32') throw new Error('Native computer interaction is currently supported on Windows only');
  // Never persist typed content, even in the approval/event log. Every action is approved separately.
  const detail = `${action.action} in process ${action.pid}${'automationId' in action ? `, control ${action.automationId}` : ''}${action.action === 'type' ? ` (${action.text.length} characters; content withheld)` : ''}. This may read visible application content or modify application state. Approve only the intended application and operation.`;
  const allowed = await requestApproval({ ...scope, kind: 'computer', title: `Computer access: ${action.action}`, detail, risk: 'high' }, signal);
  if (!allowed) throw new Error('Computer action denied by user');
  return nativeWindowsAction(action, signal);
}

/** Launch a specific built executable, observe its real window, then close this QA process. */
export async function verifyWindowsExecutable(root: string, file: string, scope: { projectId: string; runId: string; agent: AgentRole }, signal: AbortSignal): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Windows launch verification requires Windows');
  const realRoot = fs.realpathSync(root), executable = fs.realpathSync(path.resolve(root, file));
  const rel = path.relative(realRoot, executable);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !executable.toLowerCase().endsWith('.exe')) throw new Error('Executable must be inside the project');
  if (!await requestApproval({ ...scope, kind: 'computer', title: 'Launch Windows executable for QA', detail: `Launch ${executable}, read its accessible window controls, then close the QA process. Launching this program executes project code.`, risk: 'high' }, signal)) throw new Error('Executable launch denied');
  if (signal.aborted) throw new CancelledError();
  const child = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: false, stdio: 'ignore' });
  let failure: Error | null = null;
  child.on('error', error => { failure = error; });
  const stop = () => killTree(child.pid);
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (let i = 0; i < 15; i++) {
      if (signal.aborted) throw new CancelledError();
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`Executable exited before a window was verified (${child.exitCode})`);
      if (child.pid) {
        try { return await nativeWindowsAction({ action: 'observe', pid: child.pid }, signal); }
        catch (e) { if (signal.aborted) throw new CancelledError(); if (i === 14) throw e; }
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('No application window observed');
  } finally { signal.removeEventListener('abort', stop); stop(); }
}
