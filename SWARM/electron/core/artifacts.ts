import fs from 'node:fs';
import path from 'node:path';

/** Bounded discovery; never follow links into another project or report stale outputs. */
export function discoverArtifacts(root: string, since: number): { path: string; kind: string; bytes: number }[] {
  const found: { path: string; kind: string; bytes: number }[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || visited > 5000) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 5000) break;
      if (entry.isSymbolicLink() || ['node_modules', '.git', '.gradle', 'obj'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(absolute, depth + 1); continue; }
      if (!/\.(exe|msi|apk|aab|zip|dmg|deb|rpm|png)$|(?:REPORT|report)\.(md|json|html)$/.test(entry.name)) continue;
      const stat = fs.statSync(absolute);
      if (stat.mtimeMs < since || !stat.size) continue;
      found.push({ path: path.relative(root, absolute).replace(/\\/g, '/'), kind: path.extname(entry.name).slice(1), bytes: stat.size });
    }
  };
  walk(root, 0);
  return found;
}
