// Dev tool: checks the assisted-call audio route without placing a call.
//  1. lists audio outputs and whether "CABLE Input" (VB-CABLE) exists,
//  2. captures 3 s of system audio (loopback) through the call window and reports the level.
// Usage: npm run build; node scripts/call-audio-check.mjs   (play some audio on the PC to see a level)
import { build } from '../backend/node_modules/esbuild/lib/main.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'zvyra-callcheck-'))
const out = join(dir, 'out.json')
writeFileSync(
  join(dir, 'entry.ts'),
  `import { app, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { CallAgent } from ${JSON.stringify(resolve('src/main/voice/callAgent.ts'))}
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const log = { info() {}, warn() {}, error() {} }
  const agent = new CallAgent(log as never, ${JSON.stringify(resolve('out/preload'))})
  const result: Record<string, unknown> = {}
  try {
    result.audio = await agent.checkAudio()
    let frames = 0, peak = 0
    ipcMain.on('zvyra:voice-audio', (_e, pcm: Uint8Array) => {
      frames++
      const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      for (let i = 0; i + 1 < pcm.byteLength; i += 2) peak = Math.max(peak, Math.abs(v.getInt16(i, true)))
    })
    let started: unknown = null
    ipcMain.on('zvyra:voice-event', (_e, ev) => { if (ev.type === 'started' || ev.type === 'error') started = ev })
    ;(agent as unknown as { cmd(c: unknown): void }).cmd({ type: 'start', deviceId: null })
    await new Promise((r) => setTimeout(r, 3500))
    result.loopback = { started, frames, peak }
    // 3. Play a 1 s tone through the call window (into CABLE Input) and listen on CABLE Output, which is
    //    what WhatsApp will use as its microphone.
    const { BrowserWindow, session } = await import('electron')
    const ses = session.fromPartition('zvyra-callcheck-rec')
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(true))
    ses.setPermissionCheckHandler(() => true)
    const rec = new BrowserWindow({ show: false, webPreferences: { session: ses } })
    writeFileSync(${JSON.stringify(join(dir, 'rec.html'))}, '<title>rec</title>')
    await rec.loadFile(${JSON.stringify(join(dir, 'rec.html'))})
    const listening = rec.webContents.executeJavaScript(\`(async () => {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); probe.getTracks().forEach(t => t.stop())
      const dev = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audioinput' && /CABLE Output/i.test(d.label))
      if (!dev) return { error: 'CABLE Output not found' }
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 2048; ctx.createMediaStreamSource(s).connect(an)
      const buf = new Float32Array(an.fftSize); let peak = 0
      const end = Date.now() + 3000
      while (Date.now() < end) { an.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); await new Promise(r => setTimeout(r, 30)) }
      s.getTracks().forEach(t => t.stop()); return { device: dev.label, peak }
    })()\`, true)
    await new Promise((r) => setTimeout(r, 900))
    const tone = new Int16Array(24000)
    for (let i = 0; i < tone.length; i++) tone[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 12000)
    ;(agent as unknown as { cmd(c: unknown): void }).cmd({ type: 'play', pcm: new Uint8Array(tone.buffer) })
    result.cableRoute = await listening
    rec.destroy()
  } catch (e) { result.error = String((e as Error)?.message ?? e) }
  writeFileSync(${JSON.stringify(out)}, JSON.stringify(result, null, 1))
  app.exit(0)
})`
)
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'main.cjs'), external: ['electron'], logLevel: 'error' })
spawnSync(resolve('node_modules/electron/dist/electron.exe'), [join(dir, 'main.cjs'), `--user-data-dir=${join(dir, 'profile')}`], { encoding: 'utf8', timeout: 60_000 })
try {
  console.log(readFileSync(out, 'utf8'))
} catch {
  console.log('no result (Electron exited early)')
}
rmSync(dir, { recursive: true, force: true })
