import { randomUUID } from 'node:crypto';

export const uid = (prefix = ''): string => prefix + randomUUID().replace(/-/g, '').slice(0, 16);

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new CancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class CancelledError extends Error {
  constructor(msg = 'Cancelled') { super(msg); this.name = 'CancelledError'; }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new CancelledError();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/** Keep the tail of long output (errors usually appear at the end). */
export function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…[${s.length - max} earlier chars omitted]\n` + s.slice(s.length - max);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_\-]{16,})/g,
  /\b(nvapi-[A-Za-z0-9_\-]{16,})/g,
  /\b(gsk_[A-Za-z0-9]{16,})/g,
  /\b(hf_[A-Za-z0-9]{16,})/g,
  /\b(AIza[0-9A-Za-z_\-]{20,})/g,
  /(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi,
  /\b(api[_-]?key["'=:\s]+)[A-Za-z0-9._\-]{12,}/gi,
];
const knownSecrets = new Set<string>();
export function registerSecret(s: string | null | undefined) { if (s && s.length >= 8) knownSecrets.add(s); }

export function redact(s: string): string {
  let out = s;
  for (const k of knownSecrets) if (out.includes(k)) out = out.split(k).join('••••' + k.slice(-4));
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1: string) => (m.startsWith(p1) && p1.length < m.length ? p1 + '••••' : '••••' + m.slice(-4)));
  return out;
}

/** Extract the first JSON object/array from a model response. */
export function extractJson(text: string): unknown {
  try { return extractJsonStrict(text); }
  catch (e) {
    const repaired = repairTruncatedJson(text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, ''));
    if (repaired !== null) return repaired;
    throw e;
  }
}

/** Close an output that was cut off mid-JSON (common when a model hits its token limit). */
export function repairTruncatedJson(text: string): unknown | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const s = text.slice(start).replace(/```\s*$/, '');
  const stack: string[] = [];
  let inStr = false, esc = false, lastClose = -1, lastComma = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') { stack.pop(); if (!stack.length) return null; /* complete object would have parsed */ lastClose = i; }
    else if (ch === ',') lastComma = i;
  }
  // Prefer cutting after the last complete nested element; otherwise at the last comma.
  const lastSafe = lastClose >= 0 ? lastClose : lastComma;
  if (lastSafe < 0) return null;
  // Cut back to the last complete element, then close all open containers.
  const body = s.slice(0, lastSafe + (s[lastSafe] === ',' ? 0 : 1));
  const st: string[] = []; inStr = false; esc = false;
  for (const ch of body) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') st.push('}'); else if (ch === '[') st.push(']'); else if (ch === '}' || ch === ']') st.pop();
  }
  try { return JSON.parse(body.replace(/,\s*$/, '') + st.reverse().join('')); } catch { return null; }
}

function extractJsonStrict(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], cleaned].filter(Boolean) as string[];
  for (const c of candidates) {
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const slice = c.slice(start, i + 1);
          try { return JSON.parse(slice); }
          catch {
            try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); } catch { break; }
          }
        }
      }
    }
  }
  throw new Error('No valid JSON found in model response');
}

export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

export function limitConcurrency<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  return Promise.all(workers).then(() => undefined);
}
