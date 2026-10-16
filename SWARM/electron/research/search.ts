// Web search adapters. Keyless: DuckDuckGo HTML endpoint (robots.txt permits it)
// and the Wikipedia API. Keyed (optional, free tiers): Brave, Tavily, SearXNG.
import { parse } from 'node-html-parser';
import type { Settings } from '../../shared/settings';
import { getSecret } from '../core/secrets';
import { isProviderEnabled, listModels } from '../providers/registry';
import { robotsAllows } from './robots';

export interface SearchResult { url: string; title: string; snippet: string; engine: string }

const lastHit = new Map<string, number>();
/** Politeness: at most `rps` requests per second per host. */
export async function politeWait(host: string, rps: number, signal?: AbortSignal) {
  const gap = 1000 / rps;
  const now = Date.now();
  const next = Math.max(now, (lastHit.get(host) ?? 0) + gap);
  lastHit.set(host, next);
  if (next > now) await new Promise<void>((r, j) => {
    const t = setTimeout(r, next - now);
    signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('Cancelled')); }, { once: true });
  });
}

async function get(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 12_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
}

function decodeDdgUrl(href: string): string | null {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const real = u.searchParams.get('uddg');
    if (real) return real;
    if (u.hostname.endsWith('duckduckgo.com')) return null;
    return u.toString();
  } catch { return null; }
}

async function duckduckgo(q: string, s: Settings, signal?: AbortSignal): Promise<SearchResult[]> {
  const ua = s.advanced.userAgent;
  const endpoint = 'https://html.duckduckgo.com/html/';
  if (s.research.respectRobots && !(await robotsAllows(endpoint, ua, signal))) throw new Error('DuckDuckGo robots.txt disallows automated access');
  await politeWait('html.duckduckgo.com', Math.min(s.research.requestsPerSecond, 1), signal);
  const res = await get(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(),
  }, signal);
  if (res.status === 202) throw new Error('DuckDuckGo served an anti-bot challenge (202); SWARM does not bypass it');
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  const html = await res.text();
  const root = parse(html);
  const out: SearchResult[] = [];
  for (const r of root.querySelectorAll('.result')) {
    if (r.classList.contains('result--ad')) continue;
    const a = r.querySelector('a.result__a');
    if (!a) continue;
    const url = decodeDdgUrl(a.getAttribute('href') ?? '');
    if (!url || !/^https?:/.test(url)) continue;
    out.push({ url, title: a.text.trim(), snippet: r.querySelector('.result__snippet')?.text.trim() ?? '', engine: 'duckduckgo' });
  }
  if (!out.length && /anomaly|captcha|challenge/i.test(html)) throw new Error('DuckDuckGo requested a challenge; not bypassing it');
  return out;
}

async function wikipedia(q: string, s: Settings, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=6&srsearch=${encodeURIComponent(q)}`;
  await politeWait('en.wikipedia.org', s.research.requestsPerSecond, signal);
  const res = await get(url, { headers: { 'User-Agent': s.advanced.userAgent } }, signal);
  if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
  const json = (await res.json()) as { query?: { search?: { title: string; snippet: string }[] } };
  return (json.query?.search ?? []).map((r) => ({
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    title: r.title,
    snippet: r.snippet.replace(/<[^>]+>/g, ''),
    engine: 'wikipedia',
  }));
}

async function brave(q: string, s: Settings, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = getSecret('brave', s.providers.useEnvKeys)?.value;
  if (!key) throw new Error('Brave Search API key not configured');
  const res = await get(`https://api.search.brave.com/res/v1/web/search?count=10&q=${encodeURIComponent(q)}`, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } }, signal);
  if (!res.ok) throw new Error(`Brave returned ${res.status}`);
  const json = (await res.json()) as { web?: { results?: { url: string; title: string; description?: string }[] } };
  return (json.web?.results ?? []).map((r) => ({ url: r.url, title: r.title, snippet: (r.description ?? '').replace(/<[^>]+>/g, ''), engine: 'brave' }));
}

async function tavily(q: string, s: Settings, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = getSecret('tavily', s.providers.useEnvKeys)?.value;
  if (!key) throw new Error('Tavily API key not configured');
  const res = await get('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ query: q, max_results: 8 }) }, signal);
  if (!res.ok) throw new Error(`Tavily returned ${res.status}`);
  const json = (await res.json()) as { results?: { url: string; title: string; content?: string }[] };
  return (json.results ?? []).map((r) => ({ url: r.url, title: r.title, snippet: r.content ?? '', engine: 'tavily' }));
}

async function searxng(q: string, s: Settings, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!s.research.searxngUrl) throw new Error('SearXNG URL not configured');
  const res = await get(`${s.research.searxngUrl.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': s.advanced.userAgent } }, signal);
  if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
  const json = (await res.json()) as { results?: { url: string; title: string; content?: string }[] };
  return (json.results ?? []).map((r) => ({ url: r.url, title: r.title, snippet: r.content ?? '', engine: 'searxng' }));
}

/** DuckDuckGo Instant Answer API (official, keyless; returns abstracts + related links). */
async function ddgInstant(q: string, s: Settings, signal?: AbortSignal): Promise<SearchResult[]> {
  await politeWait('api.duckduckgo.com', Math.min(s.research.requestsPerSecond, 1), signal);
  const res = await get(`https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': s.advanced.userAgent } }, signal);
  if (!res.ok) throw new Error(`DuckDuckGo Instant Answer returned ${res.status}`);
  const json = (await res.json()) as { AbstractURL?: string; AbstractText?: string; Heading?: string; RelatedTopics?: { FirstURL?: string; Text?: string; Topics?: { FirstURL?: string; Text?: string }[] }[]; Results?: { FirstURL?: string; Text?: string }[] };
  const out: SearchResult[] = [];
  if (json.AbstractURL && json.AbstractText) out.push({ url: json.AbstractURL, title: json.Heading || json.AbstractURL, snippet: json.AbstractText, engine: 'ddg-instant' });
  for (const r of json.Results ?? []) if (r.FirstURL) out.push({ url: r.FirstURL, title: r.Text ?? r.FirstURL, snippet: r.Text ?? '', engine: 'ddg-instant' });
  const topics = (json.RelatedTopics ?? []).flatMap((t) => (t.Topics ? t.Topics : [t]));
  for (const t of topics.slice(0, 6)) if (t.FirstURL && !t.FirstURL.includes('duckduckgo.com/c/')) out.push({ url: t.FirstURL, title: (t.Text ?? '').split(' - ')[0].slice(0, 90), snippet: t.Text ?? '', engine: 'ddg-instant' });
  return out;
}

/**
 * Google Search via Gemini API grounding (uses the user's own Gemini key; free tier includes
 * limited grounded requests). Returns the real web pages Google Search surfaced, with redirects resolved.
 */
async function gemini(q: string, s: Settings, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = getSecret('google', s.providers.useEnvKeys)?.value;
  if (!key || !isProviderEnabled('google')) throw new Error('Gemini API key not configured');
  const candidates = listModels()
    .filter((m) => m.providerId === 'google' && /flash/i.test(m.modelId) && !/image|tts|live|audio/i.test(m.modelId) && m.health !== 'unsupported' && m.health !== 'auth_required' && !(m.health === 'rate_limited' && (m.rateLimitedUntil ?? 0) > Date.now()))
    .sort((a, b) => Number(b.health === 'healthy') - Number(a.health === 'healthy') || Number(/lite/.test(a.modelId)) - Number(/lite/.test(b.modelId)));
  if (!candidates.length) throw new Error('No Gemini Flash model available for grounded search');
  let lastErr = '';
  for (const m of candidates.slice(0, 3)) {
    const res = await get(`https://generativelanguage.googleapis.com/v1beta/models/${m.modelId}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `Search the web for: ${q}\nBriefly summarize what the most relevant current pages say.` }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 800, temperature: 0 } }),
    }, signal, 30_000);
    if (!res.ok) { lastErr = `${m.modelId}: HTTP ${res.status}`; continue; }
    const json = (await res.json()) as { candidates?: { groundingMetadata?: { groundingChunks?: { web?: { uri: string; title?: string } }[]; groundingSupports?: { segment?: { text?: string }; groundingChunkIndices?: number[] }[] } }[] };
    const meta = json.candidates?.[0]?.groundingMetadata;
    const chunks = meta?.groundingChunks ?? [];
    if (!chunks.length) { lastErr = `${m.modelId}: no grounding sources returned`; continue; }
    const snippets = new Map<number, string[]>();
    for (const sup of meta?.groundingSupports ?? []) for (const i of sup.groundingChunkIndices ?? []) snippets.set(i, [...(snippets.get(i) ?? []), sup.segment?.text ?? '']);
    const out: SearchResult[] = [];
    await Promise.all(chunks.map(async (c, i) => {
      if (!c.web?.uri) return;
      let url = c.web.uri;
      // Grounding links are Google redirect URLs; resolve to the real page.
      try {
        const r = await get(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': s.advanced.userAgent } }, signal, 8000);
        const loc = r.headers.get('location');
        if (loc) url = loc;
        await r.body?.cancel().catch(() => undefined);
      } catch { /* keep redirect URL */ }
      out.push({ url, title: c.web.title ?? new URL(url).hostname, snippet: (snippets.get(i) ?? []).join(' ').slice(0, 400), engine: 'google (gemini grounding)' });
    }));
    return out;
  }
  throw new Error(lastErr || 'Grounded search failed');
}

const ENGINES = { duckduckgo, wikipedia, brave, tavily, searxng, ddgInstant, gemini };
export type EngineId = keyof typeof ENGINES;

export function engineOrder(s: Settings): EngineId[] {
  if (s.research.engine !== 'auto') return [s.research.engine as EngineId, 'wikipedia'];
  const order: EngineId[] = [];
  if (getSecret('tavily', s.providers.useEnvKeys)) order.push('tavily');
  if (getSecret('google', s.providers.useEnvKeys) && isProviderEnabled('google')) order.push('gemini');
  if (getSecret('brave', s.providers.useEnvKeys)) order.push('brave');
  if (s.research.searxngUrl) order.push('searxng');
  order.push('duckduckgo', 'ddgInstant', 'wikipedia');
  return order;
}

export function hasFullWebSearch(s: Settings): boolean {
  return !!(getSecret('tavily', s.providers.useEnvKeys) || getSecret('brave', s.providers.useEnvKeys) || s.research.searxngUrl || getSecret('google', s.providers.useEnvKeys));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'current', 'modern', 'best', 'top', 'latest', 'how', 'what', 'are', 'www', 'com', 'guide', 'list', 'about', 'into', 'your', 'using', 'web', 'site', 'website', 'online', 'information', 'publicly', 'available']);
export function terms(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9\u0900-\u097f]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}
/** Fraction of meaningful query terms present in a result's title/snippet/url. */
export function relevance(q: string, r: SearchResult): number {
  const t = terms(q);
  if (!t.length) return 1;
  const hay = `${r.title} ${r.snippet} ${decodeURIComponent(r.url)}`.toLowerCase();
  return t.filter((w) => hay.includes(w) || (w.endsWith('s') && hay.includes(w.slice(0, -1)))).length / t.length;
}

/** Search with engine fallback. Returns results plus which engine actually answered. */
const backoff = new Map<string, number>(); // engine -> retry-after timestamp

export async function webSearch(q: string, s: Settings, signal?: AbortSignal): Promise<{ results: SearchResult[]; engine: string; errors: string[] }> {
  const errors: string[] = [];
  const merged: SearchResult[] = [];
  const engines: string[] = [];
  const seen = new Set<string>();
  for (const id of [...new Set(engineOrder(s))]) {
    if ((backoff.get(id) ?? 0) > Date.now()) { errors.push(`${id}: backing off after a refusal`); continue; }
    try {
      const results = await ENGINES[id](q, s, signal);
      if (!results.length) { errors.push(`${id}: no results`); continue; }
      engines.push(id);
      for (const r of results) {
        const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '');
        if (!seen.has(key)) { seen.add(key); merged.push(r); }
      }
      if (merged.length >= 6) break;
    } catch (e) {
      if (signal?.aborted) throw e;
      const msg = (e as Error).message;
      if (/challenge|429|refused|robots/i.test(msg)) backoff.set(id, Date.now() + 10 * 60_000);
      errors.push(`${id}: ${msg}`);
    }
  }
  return { results: merged, engine: engines.join('+') || 'none', errors };
}
