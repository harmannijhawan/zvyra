import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const common = { bundle:true, platform:'node', target:'node22', format:'cjs', sourcemap:true, external:['electron','@nut-tree-fork/nut-js','playwright-core','node:sqlite','bufferutil','utf-8-validate'], logLevel:'info' };
await mkdir('dist', {recursive:true});
await build({...common, entryPoints:['src/index.ts'], outfile:'dist/index.cjs'});
await build({...common, entryPoints:['src/ui.ts'], outfile:'dist/ui.cjs'});
await copyFile('src/speech.ps1','dist/speech.ps1');
await copyFile('src/speech.darwin.mjs','dist/speech.darwin.mjs');
