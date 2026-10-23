import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const dir = resolve('.publish-proof/computer')
const { build } = createRequire(resolve('backend/package.json'))('esbuild')
await mkdir(dir, { recursive: true })
await rm(resolve(dir,'results.json'),{force:true})
await build({ entryPoints: ['scripts/computer-check.entry.ts'], outfile: resolve(dir, 'check.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron','@nut-tree-fork/nut-js','playwright-core'], logLevel: 'warning' })
const env = { ...process.env, ZVYRA_COMPUTER_CHECK_DIR: dir }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [resolve(dir, 'check.cjs')], { env, stdio: 'inherit', windowsHide: true })
child.on('error',error=>{console.error(error.message);process.exitCode=1})
child.on('exit', async code => {
  try {
    const report=JSON.parse(await readFile(resolve(dir,'results.json'),'utf8'))
    process.exitCode=code===0&&report.tests?.length&&!report.fatal&&report.tests.every(t=>t.ok)?0:1
  }catch{console.error('The desktop test exited without a completion report.');process.exitCode=1}
})
