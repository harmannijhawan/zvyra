// Agent runtime: model calls with streaming + validation, and the tool-using
// action loop (observe → act → verify) used by Coder/Optimizer/Repair tasks.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { timeOperation } from '../core/performance';
import { scopesOverlap } from './scheduler';
import type { z } from 'zod';
import type { AgentRole, Task } from '../../shared/types';
import { defaultSettings } from '../../shared/settings';
import { emit } from '../core/bus';
import { CancelledError, extractJson, stripThink, tail, truncate, uid } from '../core/util';
import { complete, NoModelError, type Purpose } from '../router/router';
import type { ChatMessage } from '../providers/types';
import { editFile, listForPrompt, readFile, writeFile, deleteFile, normalizeRel, resolveInProject, type FsContext } from '../tools/fs';
import { runCommand } from '../tools/process';
import { searchProject } from '../tools/search';
import { parseActions, type Action } from './protocol';
import { ROLES } from './roles';
import type { RunContext } from './runContext';
import { isSmallChange } from '../core/factory';
import { pcControl, COMPUTER_TOOL_PROMPT } from '../computer/service';
import { publicChatText } from '../chat/tools';
import { BudgetExceededError, NoProgressError } from './errors';

interface CallOpts { purpose?: Purpose; needs?: ('vision' | 'coding' | 'reasoning' | 'long_context')[]; maxTokens?: number; temperature?: number; cacheKey?: string; json?: boolean }

function streamer(ctx: RunContext, task: Task) {
  let raw = '', sent = ''; let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    const text = publicChatText(raw);
    if (!text.startsWith(sent)) return;
    const delta = text.slice(sent.length); sent = text;
    if (delta) emit('AGENT_STREAM', delta, ctx.scope(task), 'debug', { taskId: task.id });
  };
  return {
    onToken: (d: string) => { raw += d; if (!timer) timer = setTimeout(flush, ctx.settings.performance.streamThrottleMs); },
    end: () => { if (timer) clearTimeout(timer); flush(); },
  };
}

const limitsOf = (ctx: RunContext) => ctx.settings.limits ?? defaultSettings().limits;

/** Enforce per-task and per-run budgets before spending more tokens. */
export function checkBudget(ctx: RunContext, task: Task) {
  const l = limitsOf(ctx);
  if (task.tokens >= l.taskTokens) throw new BudgetExceededError(`Token budget exhausted for "${task.title}": ${task.tokens.toLocaleString()} of ${l.taskTokens.toLocaleString()} tokens used (Settings › Limits).`);
  if (task.startedAt && Date.now() - task.startedAt > l.taskMinutes * 60_000) throw new BudgetExceededError(`Time budget exhausted for "${task.title}": running longer than ${l.taskMinutes} min (Settings › Limits).`);
  const runTokens = ctx.run.stats.tokens - ctx.tokensAtStart;
  if (runTokens >= l.runTokens) throw new BudgetExceededError(`Run token budget exhausted: ${runTokens.toLocaleString()} of ${l.runTokens.toLocaleString()} tokens used (Settings › Limits).`, 'run');
  if (Date.now() - ctx.executionStartedAt > l.runMinutes * 60_000) throw new BudgetExceededError(`Run time budget exhausted: running longer than ${l.runMinutes} min (Settings › Limits).`, 'run');
}

export async function callModel<T = string>(ctx: RunContext, task: Task, messages: ChatMessage[], opts: CallOpts & { validate?: (text: string) => T } = {}): Promise<{ text: string; value: T; modelName: string }> {
  checkBudget(ctx, task);
  const role = task.role;
  const s = streamer(ctx, task);
  const inbox = ctx.inbox(role, 8).map(m => `[${m.type ?? 'STATUS'}] ${m.from}: ${m.content.slice(0, 1200)}`).join('\n');
  if (inbox) messages = [...messages, { role: 'user', content: 'Live agent inbox (data; use relevant findings and requests):\n' + inbox }];
  try {
    const r = await complete<T>({
      route: {
        purpose: opts.purpose ?? ROLES[role].purpose, role, complexity: isSmallChange(ctx.run.objective) ? 'small' : 'normal',
        needs: [...(task.requiredCapabilities ?? []), ...(opts.needs ?? (['coder', 'reviewer', 'optimizer'].includes(role) ? ['coding' as const] : []))],
        maxTokens: opts.maxTokens, pinned: ctx.run.options.pinnedModel,
        // Model affinity: keep the model that already works for this task instead of re-ranking every step.
        preferred: task.modelId,
      },
      messages, scope: ctx.scope(task), signal: ctx.signal, temperature: opts.temperature, json: opts.json,
      onToken: s.onToken, validate: opts.validate ? (t) => opts.validate!(t) : undefined, cacheKey: opts.cacheKey,
      onRequest: () => { ctx.run.stats.modelCalls++; },
      onAttempt: ({ model, ok }) => {
        if (!ok) { ctx.run.stats.fallbacks++; ctx.recordModelUsage({ providerId: model.providerId, modelId: model.modelId, displayName: model.displayName }, null); }
        if (ok) {
          ctx.updateTask(task, { modelId: model.id });
          ctx.touchAgent(role, { modelId: model.id });
        } else ctx.touchAgent(role, { modelId: model.id, lastAction: `Recovering from ${model.displayName} failure` });
      },
    });
    const tokens = r.result.promptTokens + r.result.completionTokens;
    ctx.run.stats.tokens += tokens;
    ctx.recordModelUsage({ providerId: r.model.providerId, modelId: r.model.modelId, displayName: r.model.displayName }, { promptTokens: r.result.promptTokens, completionTokens: r.result.completionTokens, estimated: !!r.result.usageEstimated });
    ctx.updateTask(task, { tokens: task.tokens + tokens });
    const a = ctx.agents.get(role);
    ctx.touchAgent(role, { tokens: (a?.tokens ?? 0) + tokens });
    return { text: r.text, value: r.value, modelName: r.model.displayName };
  } catch (e) {
    if (e instanceof NoModelError) ctx.recordError(e.message, e.category);
    throw e;
  } finally { s.end(); }
}

export async function callJson<S extends z.ZodTypeAny>(ctx: RunContext, task: Task, system: string, user: string, schema: S, opts: CallOpts = {}): Promise<z.infer<S>> {
  const { value } = await callModel(ctx, task, [
    { role: 'system', content: system + '\n\nRespond with a single JSON object only. No prose, no markdown fences.' },
    { role: 'user', content: user },
  ], {
    ...opts,
    validate: (text) => {
      const parsed = schema.safeParse(extractJson(text));
      if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return parsed.data;
    },
  });
  return value as z.infer<S>;
}

export async function callText(ctx: RunContext, task: Task, system: string, user: string, opts: CallOpts = {}): Promise<string> {
  const { text } = await callModel(ctx, task, [{ role: 'system', content: system }, { role: 'user', content: user }], {
    ...opts, validate: (t) => { const c = stripThink(t); if (c.length < 20) throw new Error('Response too short'); return c; },
  });
  return stripThink(text);
}

export function fsCtx(ctx: RunContext, task: Task): FsContext {
  const scopeRoot = ctx.settings.security.fsScope === 'workspace' && ctx.settings.workspace.root ? ctx.settings.workspace.root : undefined;
  return { projectId: ctx.project.id, root: ctx.root, scopeRoot, runId: ctx.run.id, taskId: task.id, agent: task.role, autonomy: ctx.run.options.autonomy, signal: ctx.signal };
}

const INSTALL_RE = /\b(npm|pnpm|yarn)\s+(i|install|add|ci)\b/i;
const hash = (s: string) => createHash('sha1').update(s).digest('hex');
function diskHash(abs: string): string | null {
  try { return hash(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

export interface LoopResult {
  summary: string; filesTouched: string[]; steps: number; completed: boolean; commandsFailed: number;
  /** Result of the targeted verification hook, when one was supplied. */
  verification?: { checked: string[]; problems: string[] };
}

export interface LoopOptions {
  maxSteps?: number;
  allowRun?: boolean;
  /** Files whose current content was already given to the agent (counts as "read" for overwrite protection). */
  preloaded?: string[];
  /** Targeted verification run when the agent declares <done>; problems are fed back for at most two rounds. */
  verify?: (files: string[]) => Promise<{ checked: string[]; problems: string[] }>;
}

function actionSignature(actions: Action[]): string {
  return hash(JSON.stringify(actions.filter(a => a.type !== 'message').map(a => [a.type, 'path' in a ? a.path : '', a.type === 'write' ? hash(a.content) : a.type === 'edit' ? hash(a.find + '\0' + a.replace) : a.type === 'run' ? a.command : a.type === 'search' ? a.pattern : a.type === 'computer' ? a.json : ''])));
}

/** Tool-using agent loop. */
export async function runAgentLoop(ctx: RunContext, task: Task, system: string, firstUser: string, opts: LoopOptions = {}): Promise<LoopResult> {
  const perms = ctx.settings.agents.permissions[task.role];
  const allowRun = (opts.allowRun ?? true) && (perms?.terminal ?? true) && ctx.settings.computer.terminal;
  const allowFs = (perms?.fs ?? true) && ctx.settings.computer.filesystem;
  const history: ChatMessage[] = [{ role: 'system', content: system + '\n' + COMPUTER_TOOL_PROMPT }, { role: 'user', content: firstUser }];
  const touched = new Set<string>();
  const limits = limitsOf(ctx);
  let nudges = 0;
  let commandsFailed = 0;
  let previousSignature: string | null = null;
  let repeats = 0;
  let verifyRounds = 0;
  let verification: LoopResult['verification'];
  const failedCommands = new Map<string, { outputHash: string; count: number }>();
  const lastRead = new Map<string, { hash: string; step: number }>();
  // Overwrite protection: the content hash this task last saw for each file.
  const seen = new Map<string, string>();
  const fctx = fsCtx(ctx, task);
  const absOf = (p: string) => resolveInProject(ctx.root, p, fctx.scopeRoot);
  const remember = (p: string) => { try { const h = diskHash(absOf(p)); if (h) seen.set(normalizeRel(p), h); } catch { /* outside scope */ } };
  for (const p of opts.preloaded ?? []) remember(p);

  for (let step = 1; ; step++) {
    if (ctx.signal.aborted) throw new CancelledError();
    if (step > (opts.maxSteps ?? ctx.settings.agents.maxSteps)) return { summary: 'The agent reached its configured step limit.', filesTouched: [...touched], steps: step - 1, completed: false, commandsFailed, verification };
    ctx.touchAgent(task.role, { status: 'working', lastAction: step === 1 ? 'Planning changes' : `Step ${step}: continuing` });
    const text = await callWithContextRecovery(ctx, task, history, step);
    const { actions, truncatedWrite } = parseActions(text);
    // Full file bodies are on disk; re-sending them every step was the largest source of prompt tokens.
    history.push({ role: 'assistant', content: truncate(elideWrites(text), 6_000) });
    const obs: string[] = [];
    const images: string[] = [];
    let done: string | null = null;

    if (!actions.length) {
      nudges++;
      if (nudges > 2) throw new NoProgressError('Model did not produce any executable actions after repeated prompts');
      history.push({ role: 'user', content: truncatedWrite
        ? `Your output was cut off while writing ${truncatedWrite}. Rewrite that file completely but more concisely (or split it into smaller files).`
        : 'No action tags were found. Respond using the action tags (<write>, <edit>, <read>, <run>, <done>) exactly as specified.' });
      continue;
    }

    for (const a of actions) {
      if (ctx.signal.aborted) throw new CancelledError();
      const toolId = uid('tool_');
      const toolLabel = `${a.type}${'path' in a ? ` ${a.path}` : ''}`;
      const observationStart = obs.length;
      let toolFailed = false;
      if (a.type !== 'done') emit('TOOL_STARTED', toolLabel, ctx.scope(task), 'info', { tool: a.type, activityId: toolId, ...('path' in a ? { path: a.path } : {}) });
      const endFs = ['read', 'write', 'edit', 'list', 'search'].includes(a.type) ? timeOperation('filesystem', ctx.run.id) : () => {};
      try {
        if (a.type === 'write' || a.type === 'edit') {
          const conflict = [...ctx.tasks.values()].find(other => other.id !== task.id && (other.status === 'running' || other.status === 'verifying') && ['code', 'optimize', 'repair', 'agent_request'].includes(other.kind) && scopesOverlap([a.path], other.scope));
          if (conflict) throw new Error(`File is owned by active task ${conflict.title}; send that agent a message instead of overwriting it.`);
          if (a.type === 'write') guardOverwrite(ctx, task, a.path, absOf(a.path), seen);
          if (task.scope.length && !task.scope.includes(a.path)) ctx.updateTask(task, { scope: [...task.scope, a.path] });
        }
        switch (a.type) {
          case 'computer': {
            if (!ctx.settings.computer.native) throw new Error('Enable Windows computer interaction in Settings first');
            ctx.touchAgent(task.role, { lastAction: `Using PC: ${JSON.parse(a.json).action}` });
            const raw = JSON.parse(a.json);
            const observation = await pcControl.execute(raw, { projectId: ctx.project.id, runId: ctx.run.id, agent: task.role, userIntent: ctx.run.objective }, ctx.signal);
            obs.push(observation.text);
            if (observation.image) images.push(observation.image);
            break;
          }
          case 'write': {
            if (!allowFs) { obs.push(`✗ write ${a.path}: filesystem access is disabled for this agent`); break; }
            ctx.touchAgent(task.role, { lastAction: `Writing ${a.path}` });
            const ch = await writeFile(fctx, a.path, a.content);
            touched.add(ch?.path ?? a.path);
            remember(a.path);
            obs.push(`✓ wrote ${a.path} (${a.content.split('\n').length} lines)${ch ? '' : ' — unchanged'}`);
            break;
          }
          case 'edit': {
            if (!allowFs) { obs.push(`✗ edit ${a.path}: filesystem access is disabled for this agent`); break; }
            ctx.touchAgent(task.role, { lastAction: `Editing ${a.path}` });
            const ch = await editFile(fctx, a.path, a.find, a.replace);
            touched.add(a.path);
            remember(a.path);
            obs.push(`✓ edited ${a.path}${ch ? ` (+${ch.additions} −${ch.deletions})` : ' — no change'}`);
            break;
          }
          case 'read': {
            const content = await readFile(fctx, a.path, 24_000);
            const h = hash(content);
            const prev = lastRead.get(normalizeRel(a.path));
            remember(a.path);
            // An unchanged file read within the last two steps is still in the model's recent context.
            if (prev && prev.hash === h && step - prev.step <= 2) obs.push(`--- ${a.path} unchanged since your read at step ${prev.step}; use that content ---`);
            else obs.push(`--- ${a.path} ---\n${content}\n--- end ${a.path} ---`);
            lastRead.set(normalizeRel(a.path), { hash: h, step });
            break;
          }
          case 'list': obs.push(`Project files:\n${await listForPrompt(ctx.root, 250)}`); break;
          case 'search': {
            ctx.touchAgent(task.role, { lastAction: `Searching for ${a.pattern.slice(0, 40)}` });
            const r = await searchProject(ctx.root, { pattern: a.pattern, glob: a.glob || undefined, path: a.path });
            obs.push(`Search /${a.pattern}/${a.glob ? ` in ${a.glob}` : ''} — ${r.matches} match${r.matches === 1 ? '' : 'es'} in ${r.files} file${r.files === 1 ? '' : 's'}:\n${r.text}`);
            break;
          }
          case 'run': {
            if (!allowRun) { obs.push(`✗ run "${a.command}": terminal access is disabled for this agent`); break; }
            if (/\bnpm\s+(run\s+)?(dev|start)\b|\bnode\s+server|\bnodemon\b|\bvite\b(?!\s+build)|\bnext\s+dev\b/i.test(a.command)) {
              obs.push(`✗ "${a.command}" looks like a long-running server. Do not start servers; the Tester starts and verifies the app.`);
              break;
            }
            const memo = failedCommands.get(a.command);
            if (memo && memo.count >= 2) {
              obs.push(`✗ "${a.command}" was not run again: it already failed ${memo.count} times with identical output. Change the code or the approach before re-running it.`);
              break;
            }
            ctx.touchAgent(task.role, { lastAction: `Running ${a.command.slice(0, 60)}` });
            const exec = async () => runCommand({ projectId: ctx.project.id, cwd: ctx.root, command: a.command, runId: ctx.run.id, taskId: task.id, agent: task.role, autonomy: ctx.run.options.autonomy, signal: ctx.signal, timeoutMs: ctx.settings.execution.timeoutSec * 1000 });
            const r = INSTALL_RE.test(a.command) ? await (ctx.installLock = ctx.installLock.then(exec, exec)) as Awaited<ReturnType<typeof exec>> : await exec();
            ctx.run.stats.commands++;
            if (!r.ok) {
              commandsFailed++;
              const outputHash = hash(tail(r.output, 3500));
              failedCommands.set(a.command, { outputHash, count: memo && memo.outputHash === outputHash ? memo.count + 1 : 1 });
            } else failedCommands.delete(a.command);
            obs.push(r.denied ? `✗ command not run: ${r.output}` : `$ ${a.command}\nexit code: ${r.exitCode}\n${tail(r.output, 3500)}`);
            break;
          }
          case 'message': {
            const to = (Object.keys(ROLES).includes(a.to) || a.to === 'all' ? a.to : 'manager') as AgentRole | 'all';
            const types = ['STATUS', 'FINDING', 'REQUEST', 'HANDOFF', 'BLOCKED', 'ERROR', 'ARTIFACT_READY', 'TEST_FAILURE', 'DESIGN_FEEDBACK', 'ARCHITECTURE_CHANGE', 'REQUIREMENT_CHANGE', 'ESCALATION', 'APPROVAL', 'COMPLETION'];
            if (!types.includes(a.messageType ?? 'STATUS')) throw new Error('Unknown message type');
            ctx.message(task.role, to, a.content, task.id, a.messageType as import('../../shared/types').AgentMessageType);
            obs.push(`✓ message sent to ${to}`);
            break;
          }
          case 'done': done = a.summary; break;
        }
      } catch (e) {
        toolFailed = true;
        if (e instanceof CancelledError) throw e;
        obs.push(`✗ ${a.type} ${'path' in a ? a.path : ''}: ${(e as Error).message}`);
      } finally {
        endFs();
        toolFailed ||= obs.slice(observationStart).some(value => value.startsWith('✗'));
        if (a.type !== 'done') emit('TOOL_FINISHED', toolLabel, ctx.scope(task), toolFailed ? 'error' : 'info', { tool: a.type, activityId: toolId, status: toolFailed ? 'error' : 'complete', ...('path' in a ? { path: a.path } : {}) });
      }
      if (images.length) break; // Observe the returned screenshot before deciding another action.
    }
    if (truncatedWrite) obs.push(`✗ Your output was cut off while writing ${truncatedWrite}; that file was NOT written. Rewrite it completely but more concisely.`);
    ctx.updateTask(task, { filesTouched: [...touched] });
    const failedObs = obs.filter((o) => o.startsWith('✗')).length;

    // No-progress guard: the same action set again (failing, or repeated without effect) is not recovery.
    const signature = actionSignature(actions);
    repeats = signature === previousSignature ? repeats + 1 : 0;
    previousSignature = signature;
    if (repeats >= (failedObs ? limits.repeatedActions : limits.repeatedActions + 1)) {
      throw new NoProgressError(`Stopped "${task.title}": the agent repeated the same ${failedObs ? 'failing ' : ''}actions ${repeats + 1} times without progress${failedObs ? ` (last error: ${obs.find(o => o.startsWith('✗'))?.slice(0, 200)})` : ''}.`);
    }

    if (done !== null && !truncatedWrite && failedObs === 0) {
      if (opts.verify && touched.size) {
        ctx.updateTask(task, { status: 'verifying' });
        ctx.touchAgent(task.role, { lastAction: 'Verifying written files' });
        verification = await opts.verify([...touched]);
        ctx.updateTask(task, { status: 'running' });
        if (verification.problems.length && verifyRounds < 2) {
          verifyRounds++;
          ctx.recordRecovery({ taskId: task.id, attempt: verifyRounds, maxAttempts: 2, category: 'verification', reason: verification.problems.slice(0, 3).join('; '), strategy: 'Return targeted check failures to the same agent (same model, same context)' });
          history.push({ role: 'user', content: `Targeted verification of your files FAILED (checked ${verification.checked.join(', ')}):\n${verification.problems.join('\n')}\n\nFix these problems, then emit <done>.` });
          continue;
        }
      }
      return { summary: done, filesTouched: [...touched], steps: step, completed: true, commandsFailed, verification };
    }
    const resultText = `Results:\n${obs.join('\n')}\n\n${done !== null ? 'Some actions failed — fix them before finishing.' : 'Continue. Emit <done> when the task is fully complete.'}`;
    // Keep only the latest screenshot in model context to avoid accumulating image tokens.
    if (images.length) for (const message of history) if (Array.isArray(message.content)) message.content = message.content.filter(part => part.type === 'text');
    history.push({ role: 'user', content: images.length ? [{ type: 'text', text: resultText }, ...images.map(dataUrl => ({ type: 'image' as const, dataUrl }))] : resultText });
  }
}

/** Refuse a full-file write that would silently clobber content this task has not seen. */
function guardOverwrite(ctx: RunContext, task: Task, rel: string, abs: string, seen: Map<string, string>) {
  if (!fs.existsSync(abs)) return;
  const current = diskHash(abs);
  const mine = seen.get(normalizeRel(rel));
  if (mine && current && mine !== current) throw new Error(`${rel} changed on disk since you last read or wrote it (another agent or the user edited it). <read> it again and merge your change instead of overwriting.`);
  if (!mine) {
    const other = [...ctx.tasks.values()].find(o => o.id !== task.id && o.filesTouched.map(normalizeRel).includes(normalizeRel(rel)));
    if (other) throw new Error(`${rel} was written by "${other.title}" in this run. <read> it first so you do not overwrite that work.`);
  }
}

function elideWrites(text: string): string {
  return text.replace(/<write\b([^>]*)>([\s\S]*?)<\/write>/gi, (_m, attrs: string, body: string) => `<write${attrs}>[${body.split('\n').length} lines written to disk — <read> the file to see it]</write>`);
}

/** Sections that are large and re-readable on demand; after the first step they are replaced by a pointer. */
const HEAVY_SECTION = /^(Current content of your files|Current project files|Project files|Relevant files|Files|Existing project files|Outputs from prerequisite tasks|Research findings.*)$/i;
export function condenseFirst(first: string): string {
  const parts = first.split(/\n\n(?=## )/);
  if (parts.length < 2) return first.length > 6000 ? truncate(first, 6000) : first;
  return parts.map(p => {
    const heading = p.match(/^## (.+)/)?.[1]?.trim();
    return heading && HEAVY_SECTION.test(heading) ? `## ${heading}\n(omitted after the first step to save context — use <read>/<list> for current content)` : p;
  }).join('\n\n');
}

/**
 * Keep prompts small: system + task brief + the most recent exchanges.
 * level 0: last 6 messages; level 1/2 (after a context overflow): fewer messages and truncated observations.
 */
export function compactHistory(h: ChatMessage[], level = 0, step = 2): ChatMessage[] {
  const first = h[1];
  const firstText = typeof first?.content === 'string' ? first.content : '';
  if (h.length <= 2 && level === 0) return step <= 1 ? h : [h[0], { role: 'user', content: condenseFirst(firstText) }];
  const keep = level === 0 ? 6 : level === 1 ? 3 : 2;
  let recent = h.slice(2).slice(-keep);
  if (recent[0]?.role !== 'assistant' && recent.length > 1) recent = recent.slice(1);
  const skipped = h.length - 2 - recent.length;
  const limit = level === 0 ? Infinity : level === 1 ? 4000 : 1500;
  const shrink = (m: ChatMessage): ChatMessage => typeof m.content === 'string' && m.content.length > limit ? { ...m, content: truncate(m.content, limit) } : m;
  const header = condenseFirst(firstText);
  const note = skipped > 0 ? `\n\n(${skipped} earlier messages were omitted to save context. Files you already wrote are on disk — use <read> if you need them.)` : '';
  return [h[0], { role: 'user', content: (level === 2 ? truncate(header, 3000) : header) + note }, ...recent.map(shrink)];
}

/** A context overflow is answered by shrinking the prompt (twice at most), not by re-sending it to other models. */
async function callWithContextRecovery(ctx: RunContext, task: Task, history: ChatMessage[], step: number): Promise<string> {
  const needsVision = history.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
  for (let level = 0; ; level++) {
    try {
      const { text } = await callModel(ctx, task, compactHistory(history, level, step), { purpose: ROLES[task.role].purpose, needs: needsVision ? ['vision'] : undefined });
      return text;
    } catch (e) {
      if (!(e instanceof NoModelError) || e.category !== 'context' || level >= 2) throw e;
      ctx.recordRecovery({ taskId: task.id, attempt: level + 1, maxAttempts: 2, category: 'context', reason: e.message, strategy: level === 0 ? 'Drop older turns and truncate observations' : 'Keep only the task brief and the latest exchange' });
    }
  }
}

export { deleteFile };
