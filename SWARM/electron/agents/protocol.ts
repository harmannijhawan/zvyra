// Parser for the model-agnostic action protocol (works with any chat model,
// no native tool-calling support required).
export type Action =
  | { type: 'write'; path: string; content: string }
  | { type: 'edit'; path: string; find: string; replace: string }
  | { type: 'read'; path: string }
  | { type: 'list'; path: string }
  | { type: 'search'; pattern: string; glob: string; path: string }
  | { type: 'run'; command: string }
  | { type: 'computer'; json: string }
  | { type: 'swarm'; json: string }
  | { type: 'message'; to: string; content: string; messageType?: string }
  | { type: 'done'; summary: string };

export interface ParseResult { actions: Action[]; truncatedWrite: string | null }

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>/]+))`, 'i'));
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
};

/** Remove a wrapping markdown fence inside a write block. */
export function unfence(content: string): string {
  let c = content.replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '');
  const m = c.match(/^\s*```[\w.+-]*[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (m) c = m[1];
  return c.endsWith('\n') ? c : c + '\n';
}

export function parseActions(raw: string): ParseResult {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const found: { idx: number; action: Action }[] = [];
  let truncatedWrite: string | null = null;

  const writeRe = /<write\b([^>]*)>([\s\S]*?)<\/write>/gi;
  let m: RegExpExecArray | null;
  const consumed: [number, number][] = [];
  while ((m = writeRe.exec(text))) {
    const p = attr(m[1], 'path') || attr(m[1], 'file');
    if (p) found.push({ idx: m.index, action: { type: 'write', path: p, content: unfence(m[2]) } });
    consumed.push([m.index, m.index + m[0].length]);
  }
  // Unclosed <write> at the end = output was truncated.
  const lastOpen = text.lastIndexOf('<write');
  if (lastOpen >= 0 && !consumed.some(([a, b]) => lastOpen >= a && lastOpen < b)) {
    truncatedWrite = attr(text.slice(lastOpen, text.indexOf('>', lastOpen) + 1), 'path') || 'unknown file';
  }
  const inConsumed = (i: number) => consumed.some(([a, b]) => i >= a && i < b);

  const editRe = /<edit\b([^>]*)>([\s\S]*?)<\/edit>/gi;
  while ((m = editRe.exec(text))) {
    if (inConsumed(m.index)) continue;
    const p = attr(m[1], 'path');
    const find = m[2].match(/<find>([\s\S]*?)<\/find>/i)?.[1];
    const replace = m[2].match(/<replace>([\s\S]*?)<\/replace>/i)?.[1];
    if (p && find !== undefined && replace !== undefined) {
      found.push({ idx: m.index, action: { type: 'edit', path: p, find: find.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), replace: replace.replace(/^\r?\n/, '').replace(/\r?\n$/, '') } });
    }
    consumed.push([m.index, m.index + m[0].length]);
  }
  const simple: [RegExp, (g: RegExpExecArray) => Action | null][] = [
    [/<swarm>([\s\S]*?)<\/swarm>/gi, (g) => ({ type: 'swarm', json: g[1].trim() })],
    [/<computer>([\s\S]*?)<\/computer>/gi, (g) => ({ type: 'computer', json: g[1].trim() })],
    [/<read\b([^>]*?)\/?>(?:([^<]*)<\/read>)?/gi, (g) => { const p = attr(g[1], 'path') || (g[2] ?? '').trim(); return p ? { type: 'read', path: p } : null; }],
    [/<search\b([^>]*?)\/?>(?:([^<]*)<\/search>)?/gi, (g) => { const pattern = attr(g[1], 'pattern') || (g[2] ?? '').trim(); return pattern ? { type: 'search', pattern, glob: attr(g[1], 'glob'), path: attr(g[1], 'path') || '.' } : null; }],
    [/<list\b([^>]*?)\/?>(?:([^<]*)<\/list>)?/gi, (g) => ({ type: 'list', path: attr(g[1], 'path') || (g[2] ?? '').trim() || '.' })],
    [/<run>([\s\S]*?)<\/run>/gi, (g) => { const c = g[1].trim().replace(/^`+|`+$/g, ''); return c ? { type: 'run', command: c } : null; }],
    [/<message\b([^>]*)>([\s\S]*?)<\/message>/gi, (g) => ({ type: 'message', messageType: attr(g[1], 'type') || 'STATUS', to: attr(g[1], 'to') || 'manager', content: g[2].trim() })],
    [/<done>([\s\S]*?)<\/done>|<done\s*\/>/gi, (g) => ({ type: 'done', summary: (g[1] ?? '').trim() || 'Task complete.' })],
  ];
  for (const [re, make] of simple) {
    let g: RegExpExecArray | null;
    while ((g = re.exec(text))) {
      if (inConsumed(g.index)) continue;
      const a = make(g);
      if (a) found.push({ idx: g.index, action: a });
    }
  }

  // Fallback for models that ignore the tags: fenced code blocks labelled with a file path.
  if (!found.length) {
    const fenceRe = /(?:^|\n)(?:#+\s*|\*\*|`)?([\w./\\-]+\.[a-z0-9]{1,6})(?:\*\*|`)?:?\s*\n```[\w+-]*\n([\s\S]*?)\n```/gi;
    while ((m = fenceRe.exec(text))) {
      const p = m[1].replace(/\\/g, '/');
      if (/^[\w.-]+(\/[\w.-]+)*$/.test(p)) found.push({ idx: m.index, action: { type: 'write', path: p, content: m[2] + '\n' } });
    }
    const labelled = /```[\w+-]*\s+(?:file(?:name)?=)?([\w./-]+\.[a-z0-9]{1,6})\s*\n([\s\S]*?)\n```/gi;
    while ((m = labelled.exec(text))) found.push({ idx: m.index, action: { type: 'write', path: m[1], content: m[2] + '\n' } });
  }

  found.sort((a, b) => a.idx - b.idx);
  return { actions: found.map((f) => f.action), truncatedWrite };
}
