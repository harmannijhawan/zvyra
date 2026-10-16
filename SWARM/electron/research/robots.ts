// Minimal robots.txt implementation (REP: user-agent groups, allow/disallow,
// longest-match precedence, `*` and `$` wildcards).
interface Rule { allow: boolean; pattern: string }
interface Group { agents: string[]; rules: Rule[] }

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (!current) continue;
      if (key === 'disallow' && value === '') continue; // empty disallow = allow all
      current.rules.push({ allow: key === 'allow', pattern: value });
    } else lastWasAgent = false;
  }
  return groups;
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export function isAllowed(groups: Group[], userAgent: string, pathWithQuery: string): boolean {
  const ua = userAgent.toLowerCase();
  const token = ua.split(/[/\s]/)[0];
  let group = groups.find((g) => g.agents.some((a) => a !== '*' && (token.includes(a) || a.includes(token))));
  if (!group) group = groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  let best: Rule | null = null;
  for (const r of group.rules) {
    if (!patternToRegex(r.pattern).test(pathWithQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

const cache = new Map<string, { ts: number; groups: Group[] | 'deny' | 'allow' }>();

export async function robotsAllows(url: string, userAgent: string, signal?: AbortSignal): Promise<boolean> {
  const u = new URL(url);
  const origin = u.origin;
  let entry = cache.get(origin);
  if (!entry || Date.now() - entry.ts > 6 * 3600_000) {
    let groups: Group[] | 'deny' | 'allow' = 'allow';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
      const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': userAgent }, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(t);
      if (res.ok) groups = parseRobots(await res.text());
      else if (res.status === 401 || res.status === 403) groups = 'deny';
      else groups = 'allow'; // 404 etc.: no restrictions
    } catch { groups = 'allow'; }
    entry = { ts: Date.now(), groups };
    cache.set(origin, entry);
  }
  if (entry.groups === 'allow') return true;
  if (entry.groups === 'deny') return false;
  return isAllowed(entry.groups, userAgent, u.pathname + u.search);
}
