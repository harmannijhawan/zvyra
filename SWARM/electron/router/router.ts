import {scoreModel} from '../../shared/model-score';
export {scoreModel} from '../../shared/model-score';
// Model router: scores every eligible model for a task, then executes with an
// automatic, dynamically generated fallback chain across models and providers.
import type { AgentRole, Capability, ErrorCategory, ModelInfo, UsageRecord } from '../../shared/types';
import type { Settings } from '../../shared/settings';
import { timeOperation, recordTiming } from '../core/performance';
import { db } from '../core/db';
import { emit, type EventScope } from '../core/bus';
import { getSettings } from '../core/settings';
import { notify } from '../core/notify';
import { CancelledError, errMsg, uid } from '../core/util';
import { adapter, getRegistryRevision, listModels, nextAvailability, providerConfig, recordFailure, recordSuccess, usable } from '../providers/registry';
import { estimatePromptTokens } from '../providers/http';
import { ProviderError, type ChatMessage, type ChatResult, type ProviderErrorKind } from '../providers/types';

export type Purpose = 'plan' | 'research' | 'design' | 'architecture' | 'code' | 'review' | 'vision' | 'classify' | 'summarize' | 'test';

export interface RouteRequest {
  purpose: Purpose;
  role?: AgentRole;
  needs?: Capability[];
  promptTokens: number;
  maxTokens: number;
  pinned?: string | null;
  exclude?: Set<string>;
  complexity?: 'small' | 'normal' | 'complex';
  escalation?: number;
  /** Model affinity: the model that last succeeded for this task. Kept while usable to avoid needless switching. */
  preferred?: string | null;
  /** Minimum context window required (raised after a context overflow). */
  minContext?: number;
}

/** Deterministic affinity bonus: below an explicit pin (5000), above role preference (1000). */
const AFFINITY_BONUS = 3000;

/** Map the setup profile onto scoring weights. Explicit non-auto routing choices still win for recommended/custom. */
export function effectiveRouting(s: Settings): Settings {
  const routing = s.ai.profile === 'best_coding' ? 'quality' : s.ai.profile === 'fast' ? 'fastest' : s.ai.routing;
  return routing === s.ai.routing ? s : { ...s, ai: { ...s.ai, routing } };
}

const routeCache = new Map<string, { expires: number; ranks: { model: ModelInfo; score: number }[] }>();
export function rankModels(req: RouteRequest, s = getSettings()): { model: ModelInfo; score: number }[] {
  const end = timeOperation('route');
  const key = JSON.stringify([getRegistryRevision(), req.purpose, req.role, req.needs, req.promptTokens, req.maxTokens, req.complexity, req.escalation, req.pinned, req.preferred, req.minContext, s.ai.routing, s.ai.profile, s.ai.freeMode, s.routing.fallbacks, s.providers.enabled, s.routing.excluded, s.agents.modelPreference]);
  const cached = routeCache.get(key);
  let ranks = cached && cached.expires > Date.now() ? cached.ranks : null;
  if (!ranks) {
    const scoring = effectiveRouting(s);
    const order = s.ai.profile === 'custom' ? s.routing.fallbacks : [];
    ranks = listModels()
      .filter((m) => usable(m))
      .filter((m) => (req.needs ?? []).every((c) => m.capabilities.includes(c)))
      .filter((m) => m.contextLength >= req.promptTokens + Math.min(req.maxTokens, m.maxOutput ?? req.maxTokens, 1024) + 64)
      .filter((m) => !req.minContext || m.contextLength >= req.minContext)
      .map((model) => {
        // Custom profile: the user's ordered fallbacks outrank automatic scoring (the primary is the pinned model).
        const idx = order.indexOf(model.id);
        const affinity = req.preferred && req.preferred === model.id && req.preferred !== req.pinned ? AFFINITY_BONUS : 0;
        return { model, score: scoreModel(model, req, scoring) + (idx >= 0 ? 2000 - idx * 50 : 0) + affinity };
      })
      .sort((a, b) => b.score - a.score);
  }
  if (!cached || cached.expires <= Date.now()) {
    if (routeCache.size >= 128) routeCache.clear();
    routeCache.set(key, { expires: Date.now() + 1000, ranks });
  }
  // Eligibility is checked again because rate-limit cooldowns expire with time.
  const result = ranks.filter(r => !req.exclude?.has(r.model.id) && usable(r.model))
    // Load balancing only among non-sticky candidates: a task keeps its working model while it is usable.
    .map(r => ({ ...r, score: r.score - (r.model.id === req.pinned || r.model.id === req.preferred ? 0 : (inflight.get(r.model.providerId) ?? 0) * 25) }))
    .sort((a, b) => b.score - a.score);
  end();
  return result;
}

// Per-provider in-flight limits (connection reuse is handled by undici keep-alive).
const inflight = new Map<string, number>();
const waiters = new Map<string, (() => void)[]>();
const LIMITS: Record<string, number> = { ollama: 1, nvidia: 4, openrouter: 3, groq: 4, google: 3, cloudflare: 3, huggingface: 3, cerebras: 3, mistral: 2 };
async function acquire(provider: string, signal: AbortSignal) {
  if (signal.aborted) throw new CancelledError();
  const limit = LIMITS[provider] ?? 3;
  while ((inflight.get(provider) ?? 0) >= limit) {
    await new Promise<void>((resolve, reject) => {
      const list = waiters.get(provider) ?? [];
      const fn = () => { signal.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => { const l = waiters.get(provider) ?? []; waiters.set(provider, l.filter((x) => x !== fn)); reject(new CancelledError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      list.push(fn); waiters.set(provider, list);
    });
  }
  if (signal.aborted) throw new CancelledError();
  inflight.set(provider, (inflight.get(provider) ?? 0) + 1);
}
function release(provider: string) {
  inflight.set(provider, Math.max(0, (inflight.get(provider) ?? 1) - 1));
  const next = waiters.get(provider)?.shift();
  next?.();
}

export interface CompleteOptions<T> {
  /** Per-request experiment only; never written to user settings. */
  routingOverride?: Settings['ai']['routing'];
  isolatedExperiment?: boolean;
  route: Omit<RouteRequest, 'promptTokens' | 'maxTokens'> & { maxTokens?: number };
  messages: ChatMessage[];
  scope: EventScope;
  signal: AbortSignal;
  temperature?: number;
  quiet?: boolean;
  onReset?: () => void;
  stream?: boolean;
  json?: boolean;
  onToken?: (delta: string) => void;
  /** Validate/parse the output. Throwing marks the output malformed and triggers fallback. */
  validate?: (text: string, result: ChatResult) => T;
  cacheKey?: string;
  onRequest?: (model: ModelInfo) => void;
  onAttempt?: (info: { model: ModelInfo; ok: boolean; error?: string; kind?: ProviderErrorKind }) => void;
}

export interface CompleteResult<T> {
  text: string;
  value: T;
  model: ModelInfo;
  result: ChatResult;
  attempts: { modelId: string; ok: boolean; error?: string }[];
  recovered: boolean;
}

/**
 * No configured model could complete the request. `category` names the underlying reason so callers can
 * recover intelligently (wait for `retryAt`, shrink context, or stop) instead of repeating the same request.
 */
export class NoModelError extends Error {
  constructor(msg: string, public category: ErrorCategory = 'no_provider', public retryAt: number | null = null) { super(msg); this.name = 'NoModelError'; }
}

export function categoryOf(kind: ProviderErrorKind): ErrorCategory {
  switch (kind) {
    case 'quota': return 'quota';
    case 'rate_limit': return 'rate_limit';
    case 'context': return 'context';
    case 'auth': return 'auth';
    case 'bad_request': case 'unsupported': case 'not_found': return 'invalid_request';
    case 'invalid': return 'malformed_output';
    case 'timeout': return 'timeout';
    case 'server': return 'server';
    default: return 'network';
  }
}

/** Dominant failure category across attempts (cooldown kinds win: they tell the caller to wait). */
function dominantCategory(kinds: ProviderErrorKind[]): ErrorCategory {
  if (!kinds.length) return 'no_provider';
  const counts = new Map<ErrorCategory, number>();
  for (const k of kinds) counts.set(categoryOf(k), (counts.get(categoryOf(k)) ?? 0) + 1);
  if (kinds.every(k => k === 'quota' || k === 'rate_limit')) return kinds.includes('rate_limit') ? 'rate_limit' : 'quota';
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Explain why nothing is routable, in terms the user can act on. */
export function noModelReason(req: Pick<RouteRequest, 'purpose' | 'needs'>, s = getSettings()): string {
  const all = listModels();
  const configured = all.filter((m) => m.providerId !== 'managed' && m.health !== 'auth_required');
  if (!all.some((m) => usable(m)) && !configured.length) return 'No AI provider is connected. Open Settings › Providers to connect one (or sign in to a SWARM account).';
  const free = s.ai.freeMode || s.ai.profile === 'free_first';
  if (free && configured.some((m) => m.enabled && !['free', 'free_tier', 'local'].includes(m.freeStatus))) {
    const anyFree = configured.some((m) => ['free', 'free_tier', 'local'].includes(m.freeStatus) && usable(m));
    if (!anyFree) return 'No model with a verified free tier is available right now. Paid models are hidden by Free-tier First. Change the profile in Settings › Models to allow paid models.';
  }
  const needs = (req.needs ?? []).join(', ');
  return `No available model supports this request${needs ? ` (needs ${needs})` : ''}. Models may be rate limited or cooling down; retry shortly or connect another provider.`;
}

const TRANSIENT: ProviderErrorKind[] = ['timeout', 'server', 'network', 'rate_limit'];
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new CancelledError()); };
  signal.addEventListener('abort', onAbort, { once: true });
});

/**
 * Execute a model request with a bounded fallback chain:
 * - transient failures get one retry on the same model (≤2 s jittered backoff), then the next model;
 * - auth/quota/network failures skip the provider for the rest of the request;
 * - a rejected request (bad_request/context) is never replayed on the same model, and stops after two rejections;
 * - every switch is reported (event + notification) and the result names the model that actually answered.
 */
export async function complete<T = string>(opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
  const currentSettings = getSettings();
  const s = opts.routingOverride ? { ...currentSettings, ai: { ...currentSettings.ai, routing: opts.routingOverride } } : currentSettings;
  const maxTokens = opts.route.maxTokens ?? s.ai.maxOutputTokens;
  const promptTokens = estimatePromptTokens(opts.messages);
  const exclude = new Set(opts.route.exclude ?? []);
  const skipProviders = new Set<string>();
  const attempts: CompleteResult<T>['attempts'] = [];
  const maxAttempts = s.routing.maxFallbacks + 1;
  const pinned = opts.isolatedExperiment ? null : opts.route.pinned || s.ai.pinnedModel;
  let previous: ModelInfo | null = null;
  let lastReason = '';
  let failedAt = 0;
  let rejected = 0;
  let contextFailures = 0;
  let malformed = 0;
  let minContext = opts.route.minContext ?? 0;
  const kinds: ProviderErrorKind[] = [];
  const fail = (message: string, category: ErrorCategory) => {
    const waitable = category === 'quota' || category === 'rate_limit';
    return new NoModelError(message, category, waitable ? retryAtFor(opts.route) : null);
  };
  for (let i = 0; i < maxAttempts; i++) {
    if (opts.signal.aborted) throw new CancelledError();
    const endRoute = timeOperation('route', opts.scope.runId ?? undefined);
    const ranked = rankModels({ ...opts.route, escalation: i, promptTokens, maxTokens, pinned, exclude, minContext }, s).filter((r) => !skipProviders.has(r.model.providerId));
    endRoute();
    const pick = ranked[0]?.model;
    if (!pick) {
      if (attempts.length) throw fail(`All eligible models failed (${attempts.length} attempts). Last error: ${lastReason}`, contextFailures ? 'context' : dominantCategory(kinds));
      // Nothing routable before any attempt: distinguish "everything is cooling down" from "nothing is configured".
      const retryAt = retryAtFor(opts.route);
      if (retryAt) throw new NoModelError(`Every eligible model is cooling down after rate-limit or quota errors. The earliest is available again at ${new Date(retryAt).toLocaleTimeString()}.`, 'rate_limit', retryAt);
      throw new NoModelError(noModelReason(opts.route, s), opts.route.minContext ? 'context' : 'no_provider');
    }
    exclude.add(pick.id);
    if (previous) {
      recordTiming('fallback', Date.now() - failedAt, opts.scope.runId ?? undefined);
      const why = describeKind(lastReason.split(':')[0] as ProviderErrorKind) ?? 'failed';
      emit('MODEL_FALLBACK', `Switched from ${previous.displayName} to ${pick.displayName} (${previous.displayName}: ${why})`, opts.scope, 'warning', { from: previous.id, to: pick.id, reason: lastReason });
      if (!opts.quiet) notify('fallback', 'warning', 'Model fallback', `${previous.displayName} → ${pick.displayName}`, opts.scope);
    } else emit('MODEL_SELECTED', `Routed to ${pick.displayName} (${pick.providerId})`, opts.scope, 'info', { modelId: pick.id, purpose: opts.route.purpose, candidates: ranked.length, score: Math.round(ranked[0].score) });

    if (pick.providerId === 'managed') {
      // The SWARM account runs its own server-side routing; it is one step in the local chain.
      try {
        const r = await (await import('../account/managed')).managedComplete({ ...opts, route: { ...opts.route, pinned: pick.id } });
        return { ...r, attempts: [...attempts, ...r.attempts], recovered: r.recovered || attempts.length > 0 };
      } catch (e) {
        if (opts.signal.aborted) throw new CancelledError();
        lastReason = `server: ${errMsg(e)}`.slice(0, 300);
        attempts.push({ modelId: pick.id, ok: false, error: lastReason });
        kinds.push(e instanceof NoModelError && e.category === 'quota' ? 'quota' : 'server');
        skipProviders.add('managed'); previous = pick; failedAt = Date.now(); opts.onReset?.();
        continue;
      }
    }

    const a = adapter(pick.providerId)!;
    const local = a.kind === 'local';
    for (let retry = 0; ; retry++) {
      const started = Date.now();
      const endRequest = timeOperation('model', opts.scope.runId ?? undefined);
      try {
        await acquire(pick.providerId, opts.signal);
        let result: ChatResult;
        try {
          opts.onRequest?.(pick);
          result = await a.chat(providerConfig(pick.providerId), pick.modelId, {
            messages: opts.messages,
            maxTokens: Math.min(maxTokens, pick.maxOutput ?? maxTokens, Math.max(512, pick.contextLength - promptTokens - 64)),
            temperature: opts.temperature ?? s.ai.temperature,
            signal: opts.signal,
            stream: opts.stream ?? s.performance.streaming,
            json: opts.json,
            onToken: opts.onToken,
            firstTokenTimeoutMs: Math.min(s.routing.firstTokenTimeoutSec * 1000 * (local ? 2 : 1), pick.latencyMs === null || pick.successes < 5 ? Infinity : Math.max(15000, pick.latencyMs * 4 + 5000)),
            totalTimeoutMs: s.routing.requestTimeoutSec * 1000,
          });
        } finally { release(pick.providerId); }
        if (!result.text.trim()) throw new ProviderError('invalid', 'Empty response');
        let value: T;
        try { value = opts.validate ? opts.validate(result.text, result) : (result.text as T); }
        catch (ve) { throw new ProviderError('invalid', `Malformed output: ${errMsg(ve)}`); }
        if (!opts.isolatedExperiment) recordSuccess(pick.id, result.latencyMs, result.ttftMs, result.completionTokens);
        recordUsage(opts.scope, pick, result, true, null, local);
        attempts.push({ modelId: pick.id, ok: true });
        opts.onAttempt?.({ model: pick, ok: true });
        emit('MODEL_COMPLETED', `${pick.displayName} responded in ${(result.latencyMs / 1000).toFixed(1)}s`, opts.scope, 'debug', { modelId: pick.id, latencyMs: result.latencyMs, ttftMs: result.ttftMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, finish: result.finishReason });
        return { text: result.text, value, model: pick, result, attempts, recovered: attempts.length > 1 };
      } catch (e) {
        if (e instanceof CancelledError || (e instanceof ProviderError && e.kind === 'cancelled') || opts.signal.aborted) throw new CancelledError();
        const pe = e instanceof ProviderError ? e : new ProviderError('network', errMsg(e));
        lastReason = `${pe.kind}: ${pe.message}`.slice(0, 300);
        recordUsage(opts.scope, pick, null, false, lastReason, local, Date.now() - started);
        attempts.push({ modelId: pick.id, ok: false, error: lastReason });
        opts.onReset?.();
        opts.onAttempt?.({ model: pick, ok: false, error: lastReason, kind: pe.kind });
        emit('MODEL_ERROR', `${pick.displayName}: ${describeKind(pe.kind)}`, opts.scope, 'debug', { modelId: pick.id, kind: pe.kind, error: pe.message.slice(0, 500) });
        const shortWait = pe.kind !== 'rate_limit' || (pe.retryAfterMs ?? Infinity) <= 2000;
        if (retry === 0 && TRANSIENT.includes(pe.kind) && shortWait) {
          await sleep(Math.min(2000, pe.retryAfterMs ?? 400) + Math.floor(Math.random() * 250), opts.signal);
          continue;
        }
        if (!opts.isolatedExperiment || ['rate_limit', 'quota', 'auth'].includes(pe.kind)) recordFailure(pick.id, pe.kind, pe.message, pe.retryAfterMs);
        kinds.push(pe.kind);
        if (pe.kind === 'auth' || pe.kind === 'quota' || pe.kind === 'network') skipProviders.add(pick.providerId);
        if (pe.kind === 'bad_request') rejected++;
        // The same prompt cannot fit any window this size: only larger-context models remain candidates.
        if (pe.kind === 'context') { contextFailures++; minContext = Math.max(minContext, pick.contextLength + 1); }
        if (pe.kind === 'invalid') malformed++;
        previous = pick;
        failedAt = Date.now();
        break;
      } finally { endRequest(); }
    }
    if (rejected >= 2) throw fail(`The request was rejected by ${rejected} models, so it was not retried further. Last error: ${lastReason}`, 'invalid_request');
    if (contextFailures >= 2) throw fail(`The prompt exceeded the context window of ${contextFailures} models; reduce the context before retrying. Last error: ${lastReason}`, 'context');
    if (malformed >= 3) throw fail(`${malformed} models returned unusable output for this request. Last error: ${lastReason}`, 'malformed_output');
  }
  throw fail(`Exhausted ${maxAttempts} model attempts. Last error: ${lastReason}`, dominantCategory(kinds));
}

/** When the only obstacle is a cooldown, the earliest time a capable model is routable again. */
function retryAtFor(route: Pick<RouteRequest, 'needs'>, s = getSettings()): number | null {
  const needs = route.needs ?? [];
  const freeOnly = s.ai.freeMode || s.ai.profile === 'free_first';
  const at = nextAvailability((m) => needs.every((c) => m.capabilities.includes(c)) && (!freeOnly || ['free', 'free_tier', 'local'].includes(m.freeStatus)) && !s.routing.excluded.includes(m.id));
  return at && at > Date.now() ? at : null;
}

function describeKind(k: ProviderErrorKind): string {
  return ({
    rate_limit: 'rate limited', auth: 'authentication failed', not_found: 'model not found', timeout: 'timed out', server: 'provider error',
    bad_request: 'request rejected', context: 'context overflow', network: 'network error', invalid: 'malformed output', cancelled: 'cancelled',
    quota: 'quota exhausted', unsupported: 'unsupported',
  } as Record<ProviderErrorKind, string>)[k];
}

function recordUsage(scope: EventScope, m: ModelInfo, r: ChatResult | null, ok: boolean, error: string | null, local: boolean, latency?: number) {
  const u: UsageRecord = {
    id: uid('us_'), ts: Date.now(), projectId: scope.projectId ?? null, runId: scope.runId ?? null, agent: scope.agent ?? null,
    providerId: m.providerId, modelId: m.modelId, promptTokens: r?.promptTokens ?? 0, completionTokens: r?.completionTokens ?? 0,
    latencyMs: r?.latencyMs ?? latency ?? 0, ok, error, costUsd: 0, local,
  };
  db().put('usage', u.id, u, { project_id: u.projectId, run_id: u.runId, ts: u.ts, provider_id: u.providerId, model_id: u.modelId });
}
