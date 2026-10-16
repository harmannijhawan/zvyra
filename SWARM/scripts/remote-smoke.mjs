// Bundles scripts/remote-smoke.entry.ts with esbuild and runs it with Node.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'remote-smoke.mjs');
const conn = { name: 'conn', setup(b) { b.onResolve({ filter: /^swarm-remote-connectivity$/ }, () => { const e = path.join(root, 'electron/remote/connectivity/index.ts'); return fs.existsSync(e) ? { path: e } : { path: 'x', namespace: 'stub' }; }); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export {};', loader: 'js' })); } };
await build({ plugins: [conn], entryPoints: [path.join(root, 'scripts/remote-smoke.entry.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, target: 'node22', logLevel: 'error', external: ['bufferutil', 'utf-8-validate', 'electron'] });
process.exit(spawnSync(process.execPath, [out], { stdio: 'inherit' }).status ?? 1);