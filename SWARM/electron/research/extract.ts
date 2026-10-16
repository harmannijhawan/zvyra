// Page fetching + main-content extraction (respects robots.txt, size and time limits).
import { parse, type HTMLElement } from 'node-html-parser';
import { robotsAllows } from './robots';
import { politeWait } from './search';

export interface FetchedPage { url: string; title: string; text: string; description: string; status: number }

const DROP = 'script,style,noscript,svg,nav,footer,header,aside,form,iframe,template,button,[role=navigation],[aria-hidden=true],.cookie,.cookies,#cookie,.advert,.ads,.ad,.newsletter,.subscribe,.share,.social';

export class RobotsBlockedError extends Error { constructor(url: string) { super(`robots.txt disallows ${url}`); this.name = 'RobotsBlockedError'; } }

export async function fetchPage(url: string, opts: { userAgent: string; respectRobots: boolean; rps: number; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }): Promise<FetchedPage> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are fetched');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/.test(u.hostname)) throw new Error('Private network addresses are not fetched by research');
  if (opts.respectRobots && !(await robotsAllows(url, opts.userAgent, opts.signal))) throw new RobotsBlockedError(url);
  await politeWait(u.host, opts.rps, opts.signal);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000);
  opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': opts.userAgent, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' }, redirect: 'follow', signal: ctrl.signal });
    if (res.status === 401 || res.status === 403) throw new Error(`Access restricted (${res.status}); not bypassing`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/html|text\/plain|xml/.test(type)) throw new Error(`Unsupported content type ${type.split(';')[0]}`);
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0; const max = opts.maxBytes ?? 1_500_000;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
      if (size > max) { await reader.cancel(); break; }
    }
    const html = Buffer.concat(chunks).toString('utf8');
    if (type.includes('text/plain')) return { url: res.url, title: u.hostname, text: html.slice(0, 40_000), description: '', status: res.status };
    return { url: res.url || url, ...extractMain(html), status: res.status };
  } finally { clearTimeout(t); }
}

export function extractMain(html: string): { title: string; text: string; description: string } {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const title = (root.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? root.querySelector('title')?.text ?? '').trim();
  const description = (root.querySelector('meta[name="description"]')?.getAttribute('content') ?? root.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '').trim();
  for (const el of root.querySelectorAll(DROP)) el.remove();
  const candidates = root.querySelectorAll('article, main, [role=main], .content, #content, .post, .entry-content');
  let best: HTMLElement = root.querySelector('body') ?? root;
  let bestLen = 0;
  for (const c of candidates) {
    const len = c.text.length;
    if (len > bestLen) { best = c; bestLen = len; }
  }
  const blocks: string[] = [];
  for (const el of best.querySelectorAll('h1,h2,h3,h4,p,li,td,th,blockquote,dd,dt')) {
    const t = el.text.replace(/\s+/g, ' ').trim();
    if (t.length < 3) continue;
    if (/^h[1-4]$/i.test(el.tagName)) blocks.push(`\n## ${t}`);
    else if (el.tagName === 'LI') blocks.push(`- ${t}`);
    else blocks.push(t);
  }
  let text = blocks.join('\n');
  if (text.length < 200) text = best.text.replace(/\s+/g, ' ').trim();
  // De-duplicate repeated lines (menus, repeated cards).
  const seen = new Set<string>();
  text = text.split('\n').filter((l) => { const k = l.trim(); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; }).join('\n');
  return { title: title || '', text: text.slice(0, 40_000), description };
}

/** Pick the most query-relevant passages, bounded in size (keeps prompts small). */
export function relevantExcerpt(text: string, query: string, maxChars = 1800): string {
  const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 30);
  const scored = paras.map((p, i) => {
    const l = p.toLowerCase();
    let score = 0;
    for (const t of terms) if (l.includes(t)) score += 2;
    if (/\d/.test(p)) score += 1; // numbers/prices/dates tend to be informative
    if (/₹|\$|rs\.?|inr|price|open|hours|address|founded|rated|review/i.test(p)) score += 1;
    return { p, i, score: score - i * 0.002 };
  });
  const picked = scored.sort((a, b) => b.score - a.score).slice(0, 14).sort((a, b) => a.i - b.i);
  let out = '';
  for (const { p } of picked) {
    if (out.length + p.length > maxChars) break;
    out += (out ? '\n' : '') + p;
  }
  return out || text.slice(0, maxChars);
}
