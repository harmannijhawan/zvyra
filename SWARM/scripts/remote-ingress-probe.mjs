// node scripts/remote-ingress-probe.mjs [--port=47821] [--external]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const outfile = path.join(root, 'dist', 'remote-ingress-probe.cjs');
await build({ entryPoints: [path.join(root, 'scripts/remote-ingress-probe.entry.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'error', external: ['electron', '@nut-tree-fork/nut-js', 'bufferutil', 'utf-8-validate'] });
process.exit(spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1);
