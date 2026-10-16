// Controlled process manager: policy checks, approvals, streaming output,
// timeouts, cancellation and process-tree cleanup.
import { timeOperation } from '../core/performance';
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import type { AgentRole, AutonomyMode, CommandExecution } from '../../shared/types';
import { db } from '../core/db';
import { emit } from '../core/bus';
import { getSettings } from '../core/settings';
import { CancelledError, redact, tail, uid } from '../core/util';
import { assessCommand, needsApproval, scrubbedEnv } from './policy';
import { requestApproval } from './approvals';

export interface RunCommandOptions {
  projectId: string;
  cwd: string;
  command: string;
  runId?: string | null;
  taskId?: string | null;
  agent?: AgentRole | 'user' | null;
  autonomy: AutonomyMode;
  signal?: AbortSignal;
  timeoutMs?: number;
  background?: boolean; // long-running (dev servers): resolves when `readyWhen` matches or on exit
  readyWhen?: (output: string) => boolean;
  readyProbe?: () => Promise<boolean>;
  env?: Record<string, string>;
  userInitiated?: boolean;
}

export interface CommandResult {
  exec: CommandExecution;
  output: string;
  exitCode: number | null;
  ok: boolean;
  denied?: boolean;
}

interface Live { exec: CommandExecution; child: ChildProcess; outputBuf: string[] }
const live = new Map<string, Live>();

function save(exec: CommandExecution) {
  db().put('commands', exec.id, exec, { project_id: exec.projectId, run_id: exec.runId, ts: exec.startedAt });
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}

export function listLive(projectId?: string): CommandExecution[] {
  return [...live.values()].map((l) => l.exec).filter((e) => !projectId || e.projectId === projectId);
}

export function stopCommand(id: string) {
  const l = live.get(id);
  if (!l) return false;
  l.exec.status = 'killed';
  killTree(l.child.pid);
  return true;
}

export function stopAll(filter: (e: CommandExecution) => boolean = () => true) {
  for (const l of live.values()) if (filter(l.exec)) stopCommand(l.exec.id);
}

export function commandHistory(projectId: string, limit = 200): CommandExecution[] {
  return db().list<CommandExecution>('commands', 'project_id = ?', [projectId], 'ts DESC', limit);
}

export async function runCommand(o: RunCommandOptions): Promise<CommandResult> {
  const s = getSettings();
  const scope = { projectId: o.projectId, runId: o.runId ?? null, taskId: o.taskId ?? null, agent: o.agent === 'user' ? null : o.agent ?? null };
  const assessment = assessCommand(o.command, o.cwd, s.execution.blocked, s.security.blockDangerous);
  const exec: CommandExecution = {
    id: uid('cmd_'), projectId: o.projectId, runId: o.runId ?? null, taskId: o.taskId ?? null, agent: o.agent ?? null,
    command: redact(o.command), cwd: o.cwd, status: 'pending_approval', exitCode: null, startedAt: Date.now(), endedAt: null,
    output: '', background: !!o.background, risk: assessment.risk,
  };

  const deny = (why: string): CommandResult => {
    exec.status = 'denied'; exec.endedAt = Date.now(); exec.output = why;
    save(exec);
    emit('COMMAND_DENIED', `Command not run: ${redact(o.command)} — ${why}`, scope, 'warning', { commandId: exec.id, risk: assessment.risk });
    return { exec, output: why, exitCode: null, ok: false, denied: true };
  };

  if (!s.computer.terminal && !o.userInitiated) return deny('Terminal access for agents is disabled in Settings › Computer Use');
  if (assessment.kind === 'install' && !s.computer.packageInstall && !o.userInitiated) return deny('Dependency installs are disabled in Settings › Computer Use');
  if (assessment.risk === 'blocked') return deny(`Blocked by security policy: ${assessment.reason}`);

  const autoApproved = s.execution.autoApprove.some((p) => p && o.command.trim().toLowerCase().startsWith(p.toLowerCase()));
  // Commands typed by the user in the terminal are implicitly approved unless high risk.
  const mustAsk = o.userInitiated ? assessment.risk === 'high' : assessment.kind === 'install' || needsApproval(assessment.risk, o.autonomy, autoApproved);
  if (mustAsk) {
    save(exec);
    const ok = await requestApproval({
      projectId: o.projectId, runId: o.runId ?? null, agent: scope.agent,
      kind: assessment.kind === 'install' ? 'install' : assessment.kind === 'network' ? 'network' : 'command',
      title: `${o.agent && o.agent !== 'user' ? capitalize(o.agent) : 'You'} wants to run: ${redact(o.command).slice(0, 120)}`,
      detail: redact(o.command) + (redact(o.command) !== o.command ? '\nSensitive values withheld; request ' + uid() : ''), risk: assessment.risk,
    }, o.signal);
    if (!ok) return deny('Denied by user');
  }
  if (o.signal?.aborted) throw new CancelledError();

  exec.status = 'running';
  exec.startedAt = Date.now();
  save(exec);
  emit('COMMAND_STARTED', `$ ${redact(o.command)}`, scope, 'info', { commandId: exec.id, cwd: o.cwd, risk: assessment.risk, background: !!o.background });

  const endStartup = timeOperation('process', o.runId ?? undefined);
  const child = spawn(o.command, {
    cwd: o.cwd, shell: true, windowsHide: true,
    env: { ...scrubbedEnv(s.execution.scrubEnv), ...(o.env ?? {}) },
    detached: process.platform !== 'win32',
  });
  child.once('spawn', endStartup);
  child.once('error', endStartup);
  const entry: Live = { exec, child, outputBuf: [] };
  live.set(exec.id, entry);
  const maxBytes = s.execution.maxOutputKb * 1024;
  let output = '';
  let pendingChunk = '';
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = () => {
    flushTimer = null;
    if (!pendingChunk) return;
    emit('COMMAND_OUTPUT', pendingChunk, scope, 'debug', { commandId: exec.id });
    pendingChunk = '';
  };
  const onData = (d: Buffer) => {
    const text = redact(d.toString('utf8'));
    output += text;
    if (output.length > maxBytes) output = tail(output, maxBytes);
    pendingChunk += text;
    if (!flushTimer) flushTimer = setTimeout(flush, 100);
    if (readyResolve && o.readyWhen?.(output)) { const r = readyResolve; readyResolve = null; r(); }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  let readyResolve: (() => void) | null = null;
  const timeoutMs = o.timeoutMs ?? s.execution.timeoutSec * 1000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
  const onAbort = () => { exec.status = 'killed'; killTree(child.pid); };
  o.signal?.addEventListener('abort', onAbort, { once: true });

  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (err) => { output += `\n${err.message}`; resolve(-1); });
    child.on('close', (code) => resolve(code));
  });

  const finalize = (code: number | null) => {
    clearTimeout(timer);
    if (flushTimer) { clearTimeout(flushTimer); flush(); }
    o.signal?.removeEventListener('abort', onAbort);
    live.delete(exec.id);
    exec.exitCode = code;
    exec.endedAt = Date.now();
    exec.output = tail(output, 64 * 1024);
    if (timedOut) exec.status = 'timeout';
    else if (exec.status !== 'killed') exec.status = code === 0 ? 'exited' : 'failed';
    save(exec);
    const secs = ((exec.endedAt - exec.startedAt) / 1000).toFixed(1);
    emit('COMMAND_COMPLETED',
      exec.status === 'timeout' ? `Timed out after ${secs}s: ${redact(o.command)}` : exec.status === 'killed' ? `Stopped: ${redact(o.command)}` : `Exit ${code} in ${secs}s: ${redact(o.command)}`,
      scope, code === 0 ? 'success' : exec.status === 'killed' ? 'info' : 'error',
      { commandId: exec.id, exitCode: code, status: exec.status, durationMs: exec.endedAt - exec.startedAt });
  };

  if (o.background) {
    // Resolve once ready (or once it exits early, which indicates failure).
    const ready = new Promise<'ready'>((resolve) => { readyResolve = () => resolve('ready'); });
    let probing = false;
    const probeTimer = o.readyProbe ? setInterval(async () => {
      if (probing || !readyResolve) return;
      probing = true;
      try { if (await o.readyProbe!() && readyResolve) { const r = readyResolve; readyResolve = null; r(); } } catch { /* not ready */ }
      probing = false;
    }, 700) : null;
    const first = await Promise.race([ready, exited.then((c) => ({ code: c }))]);
    if (probeTimer) clearInterval(probeTimer);
    if (first === 'ready') {
      clearTimeout(timer);
      exited.then((c) => finalize(c));
      return { exec, output, exitCode: null, ok: true };
    }
    finalize(first.code);
    if (o.signal?.aborted) throw new CancelledError();
    return { exec, output, exitCode: first.code, ok: false };
  }

  const code = await exited;
  finalize(code);
  if (o.signal?.aborted) throw new CancelledError();
  return { exec, output, exitCode: code, ok: code === 0 && !timedOut };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
