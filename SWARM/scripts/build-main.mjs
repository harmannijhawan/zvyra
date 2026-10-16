import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// Optional connectivity plug-in: 'swarm-remote-connectivity' resolves to electron/remote/connectivity/index.ts when present, else an empty stub.
const connectivityPlugin = {
  name: 'swarm-remote-connectivity',
  setup(b) {
    b.onResolve({ filter: /^swarm-remote-connectivity$/ }, () => {
      const entry = path.join(root, 'electron/remote/connectivity/index.ts');
      return fs.existsSync(entry) ? { path: entry } : { path: 'swarm-remote-connectivity', namespace: 'swarm-stub' };
    });
    b.onLoad({ filter: /.*/, namespace: 'swarm-stub' }, () => ({ contents: 'export {};', loader: 'js' }));
  },
};

const common = {
  plugins: [connectivityPlugin],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', '@nut-tree-fork/nut-js', 'playwright-core', 'node:sqlite', 'bufferutil', 'utf-8-validate'],
};

await Promise.all([
  build({ ...common, entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(root, 'dist/main/main.js') }),
  build({ ...common, entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(root, 'dist/main/preload.js') }),
]);
