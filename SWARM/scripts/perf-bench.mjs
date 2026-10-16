// SWARM performance harness. Usage:
//   node scripts/perf-bench.mjs --label before|after [--skip-build] [--skip-renderer] [--only=a,b]
// Writes _perf/results-<label>.json. Compare two results with scripts/perf-report.mjs.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
const root = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); if (a) return a.split('=')[1]; const i = process.argv.indexOf(`--${n}`); return i >= 0 ? (process.argv[i + 1]?.startsWith('--') || !process.argv[i + 1] ? true : process.argv[i + 1]) : d; };
const label = arg('label', 'run');
const perf = path.join(root, '_perf'); const outDir = path.join(perf, label);
fs.mkdirSync(outDir, { recursive: true });
const only = arg('only', '') ? String(arg('only')).split(',') : null;
const results = { label, at: new Date().toISOString(), node: process.version, machine: process.env.COMPUTERNAME };

// 1. bundle the main-process bench (electron + search stubs)
const alias = { name: 'alias', setup(b) {
  b.onResolve({ filter: /^electron$/ }, () => ({ path: path.join(root, 'scripts/perf/electron-stub.ts') }));
  b.onResolve({ filter: /research\/search$/ }, () => ({ path: path.join(root, 'scripts/perf/search-stub.ts') }));
} };
await build({ entryPoints: [path.join(root, 'scripts/perf/main-bench.ts')], outfile: path.join(outDir, 'main-bench.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'error', external: ['node:sqlite', 'playwright-core'], plugins: [alias] });

// 2. build bundles for size metrics (separate output dirs; never touches dist/)
const size = (f) => fs.existsSync(f) ? fs.statSync(f).size : 0;
if (!arg('skip-build', false)) {
  for (const entry of ['main', 'preload']) await build({ entryPoints: [path.join(root, `electron/${entry}.ts`)], outfile: path.join(outDir, 'main', `${entry}.js`), bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: false, logLevel: 'error', external: ['electron', 'playwright-core', 'node:sqlite'], metafile: false });
  const vite = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', path.join(outDir, 'renderer'), '--emptyOutDir'], { cwd: root, encoding: 'utf8' });
  if (vite.status !== 0) { console.error(vite.stdout, vite.stderr); throw new Error('vite build failed'); }
}
{
  const assets = path.join(outDir, 'renderer', 'assets');
  const files = fs.existsSync(assets) ? fs.readdirSync(assets) : [];
  const js = files.filter((f) => f.endsWith('.js')).map((f) => ({ f, bytes: size(path.join(assets, f)) })).sort((a, b) => b.bytes - a.bytes);
  const html = fs.existsSync(path.join(outDir, 'renderer', 'index.html')) ? fs.readFileSync(path.join(outDir, 'renderer', 'index.html'), 'utf8') : '';
  const eager = [...html.matchAll(/assets\/([^"']+\.js)/g)].map((m) => m[1]);
  results.bundles = {
    mainJsKB: Math.round(size(path.join(outDir, 'main/main.js')) / 1024), preloadJsKB: Math.round(size(path.join(outDir, 'main/preload.js')) / 1024),
    rendererJsTotalKB: Math.round(js.reduce((n, x) => n + x.bytes, 0) / 1024), rendererJsChunks: js.length,
    rendererEntryKB: Math.round(eager.reduce((n, f) => n + size(path.join(assets, f)), 0) / 1024),
    rendererEntryGzipKB: Math.round(eager.reduce((n, f) => n + zlib.gzipSync(fs.readFileSync(path.join(assets, f))).length, 0) / 1024),
    largestChunks: js.slice(0, 5).map((x) => `${x.f} ${Math.round(x.bytes / 1024)}KB`),
  };
}

// 3. main-process scenarios (one process each: fresh DB and registry)
const scenarios = ['discovery', 'rank', 'hang1', 'hang3', 'slow1', 'fail3', 'flaky1', 'unmeasuredHang1', 'chatBig', 'researchSlow', 'purpose'];
results.main = {};
for (const sc of scenarios) {
  if (only && !only.includes(sc)) continue;
  const r = spawnSync(process.execPath, [path.join(outDir, 'main-bench.cjs'), sc, outDir], { cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...process.env } });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  results.main[sc] = line ? JSON.parse(line.slice(7)) : { error: (r.stderr || r.stdout || 'no output').slice(0, 500) };
  console.log(sc, JSON.stringify(results.main[sc]).slice(0, 300));
}

// 4. renderer
if (!arg('skip-renderer', false) && (!only || only.includes('renderer'))) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/perf/renderer-bench.mjs'), path.join(outDir, 'renderer'), outDir], { cwd: root, encoding: 'utf8', timeout: 300_000 });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RENDERER '));
  results.renderer = line ? JSON.parse(line.slice(9)) : { error: (r.stderr || r.stdout || 'no output').slice(0, 800) };
  console.log('renderer', JSON.stringify(results.renderer).slice(0, 600));
}
fs.writeFileSync(path.join(perf, `results-${label}.json`), JSON.stringify(results, null, 2));
console.log('wrote', path.join(perf, `results-${label}.json`));
