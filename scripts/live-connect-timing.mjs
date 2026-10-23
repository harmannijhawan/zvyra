// Dev tool: times Gemini Live connection setup with the key stored in ZVYRA (DPAPI via Electron safeStorage).
// Copies only "Local State" + desktop/secrets.json into a temp profile, measures, then deletes the copy.
import { build } from '../backend/node_modules/esbuild/lib/main.js'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const model = process.argv[2] ?? 'gemini-3.1-flash-live-preview'
const dir = mkdtempSync(join(tmpdir(), 'zvyra-live-'))
const profile = join(dir, 'profile')
mkdirSync(join(profile, 'desktop'), { recursive: true })
const src = join(process.env.APPDATA, 'ZVYRA')
copyFileSync(join(src, 'Local State'), join(profile, 'Local State'))
copyFileSync(join(src, 'desktop', 'secrets.json'), join(profile, 'desktop', 'secrets.json'))
const out = join(dir, 'out.json')
writeFileSync(
  join(dir, 'entry.ts'),
  `import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GoogleGenAI, Modality } from '@google/genai'
app.whenReady().then(async () => {
  const res: Record<string, unknown> = {}
  try {
    const enc = JSON.parse(readFileSync(join(app.getPath('userData'), 'desktop', 'secrets.json'), 'utf8')).values['gemini.apiKey']
    const key = safeStorage.decryptString(Buffer.from(enc, 'base64'))
    const ai = new GoogleGenAI({ apiKey: key })
    for (const proactive of [true, false]) {
      const t0 = Date.now()
      let setup = 0, err = ''
      const s = await Promise.race([
        ai.live.connect({ model: ${JSON.stringify(model)}, config: { responseModalities: [Modality.AUDIO], ...(proactive ? { proactivity: { proactiveAudio: true } } : {}) },
          callbacks: { onmessage: (m) => { if (m.setupComplete && !setup) setup = Date.now() - t0 }, onerror: (e) => { err = String((e as { message?: string }).message) }, onclose: (e) => { err = err || ('closed ' + e.code + ' ' + e.reason) } } }),
        new Promise<null>((r) => setTimeout(() => r(null), 40000))
      ])
      const opened = Date.now() - t0
      await new Promise((r) => setTimeout(r, 3000))
      res[proactive ? 'proactive' : 'plain'] = { openedMs: s ? opened : 'timeout', setupMs: setup || 'none', error: err || undefined }
      try { (s as { close(): void } | null)?.close() } catch {}
    }
  } catch (e) { res.error = String((e as Error).message) }
  writeFileSync(${JSON.stringify(out)}, JSON.stringify(res, null, 1))
  app.exit(0)
})`
)
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'main.cjs'), external: ['electron'], nodePaths: [resolve('node_modules')], logLevel: 'error' })
spawnSync(resolve('node_modules/electron/dist/electron.exe'), [join(dir, 'main.cjs'), `--user-data-dir=${profile}`], { timeout: 120_000 })
try {
  console.log(readFileSync(out, 'utf8'))
} catch {
  console.log('no result')
}
rmSync(dir, { recursive: true, force: true })
