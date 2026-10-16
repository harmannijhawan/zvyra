// Project-scoped filesystem with change tracking (before/after snapshots),
// per-file write serialization, diffs, accept/revert.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { diffLines } from 'diff';
import type { AgentRole, AutonomyMode, FileChange, FileNode } from '../../shared/types';
import { db } from '../core/db';
import { emit } from '../core/bus';
import { getSettings } from '../core/settings';
import { uid, redact } from '../core/util';
import { requestApproval } from './approvals';

export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.swarm', '.cache', 'coverage', '.turbo', '.vite', 'out', '__pycache__', '.venv']);
const MAX_SNAPSHOT = 400 * 1024;

export class ScopeError extends Error { constructor(m: string) { super(m); this.name = 'ScopeError'; } }

export interface FsContext {
  projectId: string;
  root: string;
  /** Optional wider scope (Settings › Security › Filesystem scope = workspace). */
  scopeRoot?: string;
  runId?: string | null;
  taskId?: string | null;
  agent?: AgentRole | 'user' | null;
  autonomy: AutonomyMode;
  signal?: AbortSignal;
}

export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

/** Resolve a project-relative path, refusing anything outside the project root. */
export function resolveInProject(root: string, rel: string, scopeRoot?: string): string {
  const cleaned = rel.trim().replace(/^["']|["']$/g, '');
  const abs = path.resolve(root, /^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith('\\\\') ? cleaned : normalizeRel(cleaned));
  const relative = path.relative(scopeRoot ?? root, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ScopeError(`Path is outside the project: ${rel}`);
  if (fss.existsSync(scopeRoot ?? root)) {
    const realRoot = fss.realpathSync(scopeRoot ?? root);
    let ancestor = abs;
    while (!fss.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    const realRelative = path.relative(realRoot, fss.realpathSync(ancestor));
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new ScopeError(`Path traverses a link outside the project: ${rel}`);
  }
  return abs;
}

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  locks.set(key, prev.then(() => next));
  await prev.catch(() => undefined);
  try { return await fn(); }
  finally { release(); if (locks.get(key) === next) locks.delete(key); }
}

async function readIfExists(abs: string): Promise<string | null> {
  try { return await fs.readFile(abs, 'utf8'); } catch { return null; }
}

function countDiff(before: string | null, after: string | null) {
  let additions = 0, deletions = 0;
  const lineCount = (text: string) => text ? (text.match(/\n/g)?.length ?? 0) + (text.endsWith('\n') ? 0 : 1) : 0;
  if (before === null && after !== null) return { additions: lineCount(after), deletions: 0 };
  if (after === null && before !== null) return { additions: 0, deletions: lineCount(before) };
  if (before === null || after === null) return { additions, deletions };
  for (const part of diffLines(before, after)) {
    if (part.added) additions += part.count ?? 0;
    else if (part.removed) deletions += part.count ?? 0;
  }
  return { additions, deletions };
}

function recordChange(ctx: FsContext, rel: string, kind: FileChange['kind'], before: string | null, after: string | null, renamedFrom: string | null = null): FileChange {
  const { additions, deletions } = countDiff(before, after);
  const change: FileChange = {
    id: uid('fc_'), projectId: ctx.projectId, runId: ctx.runId ?? null, taskId: ctx.taskId ?? null, agent: ctx.agent ?? null,
    path: rel, kind,
    before: before !== null && before.length <= MAX_SNAPSHOT ? before : null,
    after: after !== null && after.length <= MAX_SNAPSHOT ? after : null,
    renamedFrom, status: 'applied', ts: Date.now(), additions, deletions,
  };
  db().put('file_changes', change.id, change, { project_id: change.projectId, run_id: change.runId, ts: change.ts, path: rel });
  const type = kind === 'created' ? 'FILE_CREATED' : kind === 'modified' ? 'FILE_MODIFIED' : kind === 'deleted' ? 'FILE_DELETED' : 'FILE_RENAMED';
  const verb = kind === 'created' ? 'Created' : kind === 'modified' ? 'Edited' : kind === 'deleted' ? 'Deleted' : 'Renamed';
  emit(type, `${verb} ${rel}${kind !== 'deleted' ? ` (+${additions} −${deletions})` : ''}`, {
    projectId: ctx.projectId, runId: ctx.runId ?? null, taskId: ctx.taskId ?? null, agent: ctx.agent === 'user' ? null : ctx.agent ?? null,
  }, 'info', { changeId: change.id, path: rel, additions, deletions, kind });
  return change;
}

function checkFsAllowed(ctx: FsContext) {
  if (ctx.agent !== 'user' && !getSettings().computer.filesystem) throw new ScopeError('Filesystem access for agents is disabled in Settings › Computer Use');
}

export async function readFile(ctx: FsContext, rel: string, maxBytes = 200_000): Promise<string> {
  checkFsAllowed(ctx);
  if (ctx.agent !== 'user' && /(^|[\\/])(?:\.env(?:\.(?!example|sample)[^/]+)?|\.ssh|credentials|[^/]+\.(?:pem|key|pfx))$/i.test(rel)) throw new ScopeError('Sensitive file contents are withheld from agents');
  const abs = resolveInProject(ctx.root, rel, ctx.scopeRoot);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) throw new Error(`${rel} is a directory`);
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return `[binary file, ${buf.length} bytes]`;
  const text = ctx.agent === 'user' ? buf.toString('utf8') : redact(buf.toString('utf8'));
  return text.length > maxBytes ? text.slice(0, maxBytes) + `\n…[truncated, ${text.length} chars total]` : text;
}

export async function writeFile(ctx: FsContext, rel: string, content: string): Promise<FileChange | null> {
  checkFsAllowed(ctx);
  const relN = normalizeRel(rel);
  const abs = resolveInProject(ctx.root, relN, ctx.scopeRoot);
  if (relN.split('/').some((seg) => seg === 'node_modules' || seg === '.git')) throw new ScopeError(`Refusing to write inside ${relN.includes('.git') ? '.git' : 'node_modules'}`);
  return withLock(abs, async () => {
    const before = await readIfExists(abs);
    if (before === content) return null;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return recordChange(ctx, relN, before === null ? 'created' : 'modified', before, content);
  });
}

/** Exact find/replace edit, with a whitespace-tolerant fallback. */
export async function editFile(ctx: FsContext, rel: string, find: string, replace: string): Promise<FileChange | null> {
  checkFsAllowed(ctx);
  const relN = normalizeRel(rel);
  const abs = resolveInProject(ctx.root, relN, ctx.scopeRoot);
  return withLock(abs, async () => {
    const before = await readIfExists(abs);
    if (before === null) throw new Error(`File not found: ${relN}`);
    let after: string | null = null;
    if (find && before.includes(find)) after = before.replace(find, () => replace);
    else {
      // Tolerate CRLF/indentation differences: match line-by-line on trimmed content.
      const bLines = before.split(/\r?\n/);
      const fLines = find.split(/\r?\n/).map((l) => l.trim());
      while (fLines.length && !fLines[0]) fLines.shift();
      while (fLines.length && !fLines[fLines.length - 1]) fLines.pop();
      if (fLines.length) {
        for (let i = 0; i + fLines.length <= bLines.length; i++) {
          if (fLines.every((l, j) => bLines[i + j].trim() === l)) {
            after = [...bLines.slice(0, i), ...replace.split(/\r?\n/), ...bLines.slice(i + fLines.length)].join('\n');
            break;
          }
        }
      }
    }
    if (after === null) throw new Error(`Edit failed: the <find> text was not found in ${relN}. Read the file and retry with exact text, or rewrite the file with <write>.`);
    if (after === before) return null;
    await fs.writeFile(abs, after, 'utf8');
    return recordChange(ctx, relN, 'modified', before, after);
  });
}

export async function deleteFile(ctx: FsContext, rel: string): Promise<FileChange | null> {
  checkFsAllowed(ctx);
  const s = getSettings();
  if (!s.security.allowDeletes && ctx.agent !== 'user') throw new ScopeError('File deletion by agents is disabled in Settings › Security');
  const relN = normalizeRel(rel);
  const abs = resolveInProject(ctx.root, relN, ctx.scopeRoot);
  if (ctx.agent !== 'user') {
    const ok = await requestApproval({ projectId: ctx.projectId, runId: ctx.runId ?? null, agent: ctx.agent ?? null, kind: 'fs_delete', title: `Delete ${relN}`, detail: relN, risk: 'medium' }, ctx.signal);
    if (!ok) throw new Error('Deletion denied by user');
  }
  return withLock(abs, async () => {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return null;
    if (stat.isDirectory()) { await fs.rm(abs, { recursive: true, force: true }); return recordChange(ctx, relN + '/', 'deleted', null, null); }
    const before = await readIfExists(abs);
    await fs.rm(abs, { force: true });
    return recordChange(ctx, relN, 'deleted', before, null);
  });
}

export async function renameFile(ctx: FsContext, from: string, to: string): Promise<FileChange> {
  checkFsAllowed(ctx);
  const a = resolveInProject(ctx.root, from), b = resolveInProject(ctx.root, to);
  const content = await readIfExists(a);
  await fs.mkdir(path.dirname(b), { recursive: true });
  await fs.rename(a, b);
  return recordChange(ctx, normalizeRel(to), 'renamed', content, content, normalizeRel(from));
}

export async function makeDir(ctx: FsContext, rel: string) {
  checkFsAllowed(ctx);
  await fs.mkdir(resolveInProject(ctx.root, rel), { recursive: true });
}

export async function listTree(root: string, rel = '', depth = 6, limit = { n: 4000 }): Promise<FileNode[]> {
  const abs = resolveInProject(root, rel || '.');
  let entries: fss.Dirent[] = [];
  try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return []; }
  entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
  const out: FileNode[] = [];
  for (const e of entries) {
    if (limit.n-- <= 0) break;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const ignored = IGNORED_DIRS.has(e.name);
      out.push({ name: e.name, path: p, dir: true, children: ignored || depth <= 0 ? undefined : await listTree(root, p, depth - 1, limit) });
    } else {
      const st = await fs.stat(path.join(abs, e.name)).catch(() => null);
      out.push({ name: e.name, path: p, dir: false, size: st?.size, mtime: st?.mtimeMs });
    }
  }
  return out;
}

/** Compact textual listing for model context (skips ignored dirs). */
export async function listForPrompt(root: string, maxEntries = 200): Promise<string> {
  const lines: string[] = [];
  const walk = (nodes: FileNode[], indent: string) => {
    for (const n of nodes) {
      if (lines.length >= maxEntries) return;
      lines.push(`${indent}${n.name}${n.dir ? '/' : ''}${!n.dir && n.size !== undefined ? ` (${n.size}b)` : ''}`);
      if (n.dir && n.children) walk(n.children, indent + '  ');
    }
  };
  walk(await listTree(root, '', 5), '');
  return lines.length ? lines.join('\n') : '(empty project)';
}

export function listChanges(projectId: string, opts: { runId?: string; path?: string; limit?: number } = {}): FileChange[] {
  const where = ['project_id = ?']; const params: (string | number)[] = [projectId];
  if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
  if (opts.path) { where.push('path = ?'); params.push(opts.path); }
  return db().list<FileChange>('file_changes', where.join(' AND '), params, 'ts DESC', opts.limit ?? 500);
}

export async function revertChange(ctx: FsContext, changeId: string): Promise<FileChange | null> {
  const c = db().get<FileChange>('file_changes', changeId);
  if (!c) throw new Error('Change not found');
  if (c.status === 'reverted') return null;
  const abs = resolveInProject(ctx.root, c.path.replace(/\/$/, ''));
  let result: FileChange | null = null;
  await withLock(abs, async () => {
    const current = await readIfExists(abs);
    if (c.kind === 'created') { await fs.rm(abs, { force: true }); result = recordChange(ctx, c.path, 'deleted', current, null); }
    else if (c.kind === 'renamed' && c.renamedFrom) { await fs.rename(abs, resolveInProject(ctx.root, c.renamedFrom)); result = recordChange(ctx, c.renamedFrom, 'renamed', current, current, c.path); }
    else {
      if (c.before === null) throw new Error('Original content was too large to snapshot; cannot revert');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, c.before, 'utf8');
      result = recordChange(ctx, c.path, current === null ? 'created' : 'modified', current, c.before);
    }
  });
  db().put('file_changes', c.id, { ...c, status: 'reverted' }, { project_id: c.projectId, run_id: c.runId, ts: c.ts, path: c.path });
  emit('FILE_REVERTED', `Reverted change to ${c.path}`, { projectId: c.projectId, runId: c.runId }, 'info', { changeId: c.id });
  return result;
}

export function acceptChange(changeId: string) {
  const c = db().get<FileChange>('file_changes', changeId);
  if (!c) return;
  db().put('file_changes', c.id, { ...c, status: 'accepted' }, { project_id: c.projectId, run_id: c.runId, ts: c.ts, path: c.path });
}
