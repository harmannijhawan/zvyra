// Dev tool: run ZVYRA's website QA (src/main/agent/siteCheck.ts) on a folder, file or URL.
// Usage: node scripts/site-check.mjs <site-folder|index.html|url>
// Bundles the checker with esbuild and runs it in Electron; prints the report JSON.
import { build } from '../backend/node_modules/esbuild/lib/main.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/site-check.mjs <site-folder|index.html|url>')
  process.exit(2)
}
const dir = mkdtempSync(join(tmpdir(), 'zvyra-sitecheck-'))
const entry = join(dir, 'entry.ts')
writeFileSync(
  entry,
  `import { app } from 'electron'
import { checkSite } from ${JSON.stringify(resolve('src/main/agent/siteCheck.ts'))}
// QA windows open and close; without this Electron quits after the first one.
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try {
    const r = await checkSite(${JSON.stringify(/^https?:/.test(target) ? target : resolve(target))})
    require('fs').writeFileSync(${JSON.stringify(join(dir, 'out.txt'))}, 'REPORT ' + JSON.stringify({ ...r, screenshotJpegBase64: undefined }))
  } catch (e) { require('fs').writeFileSync(${JSON.stringify(join(dir, 'out.txt'))}, 'ERROR ' + (e && e.message)) }
  app.exit(0)
})`
)
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'main.cjs'), external: ['electron'], logLevel: 'error' })
const electron = resolve('node_modules/electron/dist/electron.exe')
const r = spawnSync(electron, [join(dir, 'main.cjs'), `--user-data-dir=${join(tmpdir(), 'zvyra-sitecheck-profile')}`], { encoding: 'utf8', timeout: 180_000 })
let line = ''
try {
  line = readFileSync(join(dir, 'out.txt'), 'utf8')
} catch {
  /* no report */
}
console.log(line ? line.replace(/^REPORT /, '') : `no report (exit ${r.status}) ${r.stderr?.slice(0, 500)}`)
rmSync(dir, { recursive: true, force: true })
