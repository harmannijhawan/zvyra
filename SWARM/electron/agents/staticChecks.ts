// Targeted, real verification of the files an agent just wrote. Cheap (no installs, no model calls):
// JSON must parse, JavaScript must pass the engine's own syntax check, local HTML references must exist.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const JS = /\.(?:m|c)?js$/i;

function nodeCheck(file: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    // process.execPath is node under tests and the Electron binary in the app; ELECTRON_RUN_AS_NODE makes both act as node.
    execFile(process.execPath, ['--check', file], { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, _stdout, stderr) => {
      if (!err) return resolve(null);
      const text = String(stderr || err.message).split('\n').filter(l => l.trim() && !/^\s+at /.test(l)).slice(0, 6).join('\n');
      resolve(text || 'Syntax check failed');
    });
  });
}

function htmlReferences(html: string): string[] {
  const refs: string[] = [];
  for (const m of html.matchAll(/<(?:script|img|link|source|iframe)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"'#?]+)/gi)) refs.push(m[1]);
  return refs.filter(r => !/^(?:[a-z]+:)?\/\//i.test(r) && !/^(?:data|mailto|tel|javascript):/i.test(r) && !r.startsWith('{'));
}

/** Returns human-readable problems; an empty list means every check that applies passed. */
export async function staticCheck(root: string, files: string[], timeoutMs = 15_000): Promise<{ problems: string[]; checked: string[] }> {
  const problems: string[] = [];
  const checked: string[] = [];
  for (const rel of [...new Set(files)].slice(0, 40)) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root)) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    if (/node_modules|\.swarm[\\/]/.test(rel)) continue;
    if (/\.json$/i.test(rel)) {
      checked.push(rel);
      try { JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { problems.push(`${rel}: invalid JSON (${(e as Error).message})`); }
    } else if (JS.test(rel)) {
      checked.push(rel);
      const err = await nodeCheck(abs, timeoutMs);
      if (err) problems.push(`${rel}: syntax error\n${err}`);
    } else if (/\.html?$/i.test(rel)) {
      checked.push(rel);
      const html = fs.readFileSync(abs, 'utf8');
      if (html.trim().length < 20) problems.push(`${rel}: file is empty`);
      for (const ref of htmlReferences(html)) {
        const target = ref.startsWith('/') ? path.join(root, ref) : path.resolve(path.dirname(abs), ref);
        if (!fs.existsSync(target)) problems.push(`${rel}: references missing file "${ref}"`);
      }
    }
  }
  return { problems, checked };
}
