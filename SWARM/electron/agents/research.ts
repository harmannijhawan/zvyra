// Researcher pipeline: real searches → robots-checked page fetches → extraction
// → model-synthesized findings that must cite fetched sources.
import { z } from 'zod';
import type { ResearchFinding, ResearchSource, Task } from '../../shared/types';
import { db } from '../core/db';
import { emit } from '../core/bus';
import { CancelledError, errMsg, limitConcurrency, uid } from '../core/util';
import { webSearch, hasFullWebSearch, relevance, type SearchResult } from '../research/search';
import { fetchPage, relevantExcerpt, RobotsBlockedError } from '../research/extract';
import { callJson } from './runtime';
import type { RunContext } from './runContext';

const FindingsSchema = z.object({
  summary: z.string().default(''),
  findings: z.array(z.object({
    category: z.string().default('general'),
    claim: z.string().min(8),
    sources: z.array(z.union([z.number(), z.string()])).min(1),
  })).default([]),
});

const SeedSchema = z.object({ urls: z.array(z.string()).default([]) });

function saveSource(s: ResearchSource) { db().put('sources', s.id, s, { project_id: s.projectId, run_id: s.runId, ts: s.fetchedAt }); }

export async function runResearch(ctx: RunContext, task: Task, queries: string[]): Promise<{ sources: ResearchSource[]; findings: ResearchFinding[]; summary: string }> {
  const s = ctx.settings;
  const qs = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, s.research.maxQueries);
  const perms = s.agents.permissions.researcher;
  if (!s.computer.web || perms?.web === false || !s.security.allowAgentNetwork) throw new Error('Web access for agents is disabled in Settings');
  ctx.touchAgent('researcher', { status: 'working', lastAction: `Searching ${qs.length} queries` });

  // 1. Concurrent searches (cached per query).
  const hits: (SearchResult & { query: string })[] = [];
  await Promise.all(qs.map(async (q) => {
    emit('SEARCH_STARTED', `Searching "${q}"`, ctx.scope(task), 'info', { query: q });
    const cacheKey = `research:search:${q.toLowerCase()}`;
    const cached = s.performance.cacheResearch && s.research.cacheHours > 0 ? db().cacheGet(cacheKey, s.research.cacheHours * 3600_000) : null;
    let results: SearchResult[]; let engine: string; let errors: string[] = [];
    if (cached) { ({ results, engine } = JSON.parse(cached)); engine += ' (cached)'; }
    else {
      ({ results, engine, errors } = await webSearch(q, s, ctx.signal));
      if (results.length) db().cacheSet(cacheKey, JSON.stringify({ results, engine }));
    }
    emit('WEB_SEARCH', `Searched "${q}" — ${results.length} results via ${engine}`, ctx.scope(task), results.length ? 'info' : 'warning', { query: q, engine, count: results.length, errors });
    for (const r of results) hits.push({ ...r, query: q });
  }));
  if (ctx.signal.aborted) throw new CancelledError();

  // Drop off-topic results (keyless engines often return loosely related pages).
  const before = hits.length;
  const trusted = new Set(['tavily', 'brave', 'google (gemini grounding)', 'searxng']);
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const rel = Math.max(relevance(h.query, h), relevance(ctx.run.objective, h) * 0.8);
    if (rel < (trusted.has(h.engine) ? 0.15 : 0.34)) hits.splice(i, 1);
  }
  if (before !== hits.length) emit('WEB_SEARCH', `Filtered ${before - hits.length} off-topic result(s); ${hits.length} relevant remain`, ctx.scope(task), 'info', {});

  // 2. If search coverage is thin (no keyed engine), ask the model for authoritative seed URLs.
  //    These are only used if SWARM can actually fetch them.
  if (hits.length < 6) {
    try {
      const seeds = await callJson(ctx, task,
        'You suggest authoritative public web pages to research a topic. Only suggest URLs you are confident exist (official sites, Wikipedia, major publications). No search-engine URLs.',
        `Research queries:\n${qs.map((q) => `- ${q}`).join('\n')}\n\nReturn {"urls": [up to 8 URLs]}.`, SeedSchema, { purpose: 'classify', maxTokens: 600 });
      for (const u of seeds.urls.slice(0, 8)) {
        try { const url = new URL(u); if (/^https?:$/.test(url.protocol)) hits.push({ url: url.toString(), title: url.hostname, snippet: '', engine: 'model-suggested', query: qs[0] ?? '' }); } catch { /* invalid URL */ }
      }
      emit('WEB_SEARCH', `Model proposed ${seeds.urls.length} candidate URLs (each will be verified by fetching)`, ctx.scope(task), 'info', { engine: 'model-suggested' });
    } catch (e) { if (e instanceof CancelledError) throw e; }
  }

  // 3. Select diverse sources.
  const byUrl = new Map<string, SearchResult & { query: string }>();
  for (const h of hits) { const k = h.url.replace(/#.*$/, ''); if (!byUrl.has(k)) byUrl.set(k, h); }
  const perDomain = new Map<string, number>();
  const selected: (SearchResult & { query: string })[] = [];
  for (const h of byUrl.values()) {
    let domain = ''; try { domain = new URL(h.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if ((perDomain.get(domain) ?? 0) >= 2) continue;
    perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    selected.push(h);
    if (selected.length >= s.research.maxSources + 4) break;
  }

  // 4. Fetch + extract concurrently.
  const sources: ResearchSource[] = [];
  ctx.touchAgent('researcher', { lastAction: `Reading ${selected.length} pages` });
  await limitConcurrency(selected, 4, async (h) => {
    if (ctx.signal.aborted) return;
    if (sources.filter((x) => x.status === 'fetched' || x.status === 'search_only').length >= s.research.maxSources) return;
    const domain = new URL(h.url).hostname.replace(/^www\./, '');
    const base: ResearchSource = {
      id: uid('src_'), projectId: ctx.project.id, runId: ctx.run.id, query: h.query, url: h.url, title: h.title || domain, domain,
      snippet: h.snippet, excerpt: null, status: 'search_only', error: null, engine: h.engine, fetchedAt: Date.now(), ref: 0,
    };
    if (!s.research.fetchPages) {
      if (!h.snippet) return;
      base.ref = ++ctx.sourceCounter; sources.push(base); saveSource(base);
      emit('SOURCE_FOUND', `[${base.ref}] ${base.title} (snippet only)`, ctx.scope(task), 'info', { source: base });
      return;
    }
    try {
      const page = await fetchPage(h.url, { userAgent: s.advanced.userAgent, respectRobots: s.research.respectRobots, rps: s.research.requestsPerSecond, signal: ctx.signal });
      if (page.text.length < 150 && !page.description) throw new Error('Page had no readable content');
      base.status = 'fetched';
      base.url = page.url;
      base.title = page.title || h.title || domain;
      base.excerpt = relevantExcerpt(`${page.description}\n${page.text}`, `${h.query} ${ctx.run.objective}`, 1800);
      base.ref = ++ctx.sourceCounter;
      sources.push(base); saveSource(base);
      emit('SOURCE_FOUND', `[${base.ref}] ${base.title} — ${domain}`, ctx.scope(task), 'info', { source: base });
    } catch (e) {
      if (ctx.signal.aborted) return;
      if (e instanceof RobotsBlockedError) {
        base.status = 'blocked_robots'; base.error = 'Disallowed by robots.txt';
        saveSource(base);
        emit('SOURCE_BLOCKED', `Skipped ${domain}: robots.txt disallows automated access`, ctx.scope(task), 'debug', { source: base });
      } else if (h.snippet && h.engine !== 'model-suggested') {
        base.error = errMsg(e); base.ref = ++ctx.sourceCounter;
        sources.push(base); saveSource(base);
        emit('SOURCE_FOUND', `[${base.ref}] ${base.title} (snippet only; page fetch failed)`, ctx.scope(task), 'info', { source: base });
      } else {
        base.status = 'failed'; base.error = errMsg(e);
        saveSource(base);
        emit('SOURCE_BLOCKED', `Could not read ${domain}: ${errMsg(e).slice(0, 100)}`, ctx.scope(task), 'debug', { source: base });
      }
    }
  });
  if (ctx.signal.aborted) throw new CancelledError();
  sources.sort((a, b) => a.ref - b.ref);
  ctx.sources.push(...sources);
  ctx.run.stats.sources = ctx.sources.length;

  if (!sources.length) {
    const why = hasFullWebSearch(s) ? 'No sources could be retrieved.' : 'No sources could be retrieved with keyless search. Add a free Tavily/Brave key or a SearXNG URL in Settings › Web Research for full web search.';
    ctx.message('researcher', 'manager', `Research returned no usable sources. ${why}`, task.id);
    return { sources, findings: [], summary: why };
  }

  // 5. Model synthesis — every finding must cite retrieved sources.
  ctx.touchAgent('researcher', { lastAction: `Extracting findings from ${sources.length} sources` });
  const block = sources.map((x) => `[${x.ref}] ${x.title} — ${x.url}\n${x.status === 'fetched' ? x.excerpt : `(search snippet) ${x.snippet}`}`).join('\n\n');
  const out = await callJson(ctx, task,
    'You are the SWARM Researcher. Extract concrete, useful facts from the provided sources ONLY. Every finding must cite the source numbers it came from. Never invent facts, prices or names not present in the sources. Prefer specific facts (names, prices, dates, places, features, trends). IGNORE sources or passages that are not relevant to the objective — it is better to return few findings than off-topic ones. Return an empty findings list if nothing is relevant.',
    `Objective: ${ctx.run.objective}\nResearch focus: ${task.description}\n\nSOURCES:\n${block}\n\nReturn {"summary": "2-3 sentences", "findings": [{"category": "e.g. competitors|pricing|trends|audience|locations|products|facts", "claim": "one specific fact", "sources": [1,2]}]} with 6-15 findings.`,
    FindingsSchema, { purpose: 'research', maxTokens: 4000 });

  const refs = new Map(sources.map((x) => [x.ref, x.id]));
  const findings: ResearchFinding[] = [];
  for (const f of out.findings) {
    const ids = f.sources.map((n) => refs.get(Number(String(n).replace(/\D/g, '')))).filter(Boolean) as string[];
    if (!ids.length) continue; // uncited claims are discarded
    const finding: ResearchFinding = { id: uid('fd_'), projectId: ctx.project.id, runId: ctx.run.id, category: f.category.toLowerCase(), claim: f.claim, sourceIds: [...new Set(ids)], createdAt: Date.now() };
    findings.push(finding);
    db().put('findings', finding.id, finding, { project_id: finding.projectId, run_id: finding.runId, ts: finding.createdAt });
    emit('FINDING_ADDED', finding.claim, ctx.scope(task), 'info', { finding });
  }
  ctx.findings.push(...findings);
  const fetched = sources.filter((x) => x.status === 'fetched').length;
  ctx.message('researcher', 'manager', `Found ${sources.length} sources (${fetched} read in full) and ${findings.length} cited findings. ${out.summary}`.trim(), task.id);
  return { sources, findings, summary: out.summary };
}

/** Compact findings block for downstream agents (scoped context). */
export function findingsForPrompt(ctx: RunContext, limit = 20): string {
  if (!ctx.findings.length) return '';
  const refOf = new Map(ctx.sources.map((s) => [s.id, s.ref]));
  return ctx.findings.slice(0, limit).map((f) => `- (${f.category}) ${f.claim} [${f.sourceIds.map((id) => refOf.get(id)).filter(Boolean).join(',')}]`).join('\n')
    + '\nSources: ' + ctx.sources.slice(0, 20).map((s) => `[${s.ref}] ${s.domain}`).join(', ');
}
