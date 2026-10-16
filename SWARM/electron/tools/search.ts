// Bounded project search for agents: regex over text files, skipping dependencies,
// build output, VCS data, secrets and binaries. Path-traversal safe via resolveInProject.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInProject } from './fs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', 'coverage', '.gradle', '.idea', '.vscode', 'target', '__pycache__', '.venv', 'venv', 'release', '.swarm-test']);
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|pfx|p12|keystore|jks)|id_rsa.*|credentials(\.json)?)$/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|bmp|pdf|zip|gz|tgz|7z|rar|exe|dll|so|dylib|bin|class|jar|apk|aab|woff2?|ttf|otf|mp[34]|mov|wav|db|sqlite|wasm|lock)$/i;

export interface SearchOptions { pattern: string; glob?: string; path?: string; maxMatches?: number; maxBytes?: number; maxFiles?: number }
export interface SearchResult { text: string; matches: number; files: number; truncated: boolean }

/** Minimal glob → regex: supports *, **, ? and {a,b}. Matched against the project-relative path with forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = glob.indexOf('}', i); if (end > i) { re += '(' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; } else re += '\\{'; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp((glob.includes('/') ? '^' : '(^|/)') + re + '$', 'i');
}

export async function searchProject(root: string, o: SearchOptions): Promise<SearchResult> {
  if (o.pattern.length > 500) throw new Error('Search pattern is too long');
  let re: RegExp;
  try { re = new RegExp(o.pattern, 'i'); } catch { re = new RegExp(o.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const glob = o.glob ? globToRegExp(o.glob) : null;
  const start = resolveInProject(root, o.path && o.path !== '.' ? o.path : '');
  const maxMatches = o.maxMatches ?? 200, maxBytes = o.maxBytes ?? 64_000, maxFiles = o.maxFiles ?? 4000;
  const lines: string[] = [];
  let bytes = 0, matches = 0, files = 0, scanned = 0, truncated = false;
  const queue = [start];
  outer: while (queue.length) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) queue.push(full); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (SECRET_FILE.test(rel) || BINARY_EXT.test(e.name) || (glob && !glob.test(rel))) continue;
      if (++scanned > maxFiles) { truncated = true; break outer; }
      let content: string;
      try { const st = await fs.stat(full); if (st.size > 1_000_000) continue; content = await fs.readFile(full, 'utf8'); } catch { continue; }
      if (content.includes('\u0000')) continue;
      let hit = false;
      const rows = content.split(/\r?\n/);
      for (let i = 0; i < rows.length; i++) {
        if (!re.test(rows[i])) continue;
        hit = true;
        const line = `${rel}:${i + 1}: ${rows[i].trim().slice(0, 240)}`;
        bytes += line.length + 1; matches++;
        lines.push(line);
        if (matches >= maxMatches || bytes >= maxBytes) { truncated = true; files++; break outer; }
      }
      if (hit) files++;
    }
  }
  const text = matches ? lines.join('\n') + (truncated ? `\n… results truncated after ${matches} matches. Narrow the pattern or add glob="…".` : '') : `No matches for /${o.pattern}/${o.glob ? ` in ${o.glob}` : ''}.`;
  return { text, matches, files, truncated };
}
