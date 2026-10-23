// End-to-end test of the assisted-call audio path, no phone call needed.
//   1. ZVYRA speaks a test sentence with its real Gemini Live voice into "CABLE Input" (the call output).
//   2. "CABLE Output" (what WhatsApp sends to the other person) is recorded -> call-test/zvyra-through-cable.wav
//   3. That recording is played on your speakers/headphones so you can hear what the other person would hear.
//   4. While it plays, ZVYRA's call listener (system loopback) captures it and Gemini transcribes it:
//      this is exactly how ZVYRA hears the other person on a call.
// Uses the Gemini key stored in ZVYRA (copies only "Local State" + secrets.json to a temp profile, deleted after).
// Usage: npm run build; node scripts/call-voice-test.mjs
import { build } from '../backend/node_modules/esbuild/lib/main.js'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const outDir = resolve('.agents/tasks/operator-upgrade/call-test')
mkdirSync(outDir, { recursive: true })
const dir = mkdtempSync(join(tmpdir(), 'zvyra-calltest-'))
const profile = join(dir, 'profile')
mkdirSync(join(profile, 'desktop'), { recursive: true })
const src = join(process.env.APPDATA, 'ZVYRA')
copyFileSync(join(src, 'Local State'), join(profile, 'Local State'))
copyFileSync(join(src, 'desktop', 'secrets.json'), join(profile, 'desktop', 'secrets.json'))
let model = 'gemini-3.1-flash-live-preview'
let voice = 'Charon'
try {
  const p = JSON.parse(readFileSync(join(src, 'desktop', 'prefs.json'), 'utf8'))
  if (/live|native-audio/i.test(p.voice?.sttProvider ?? '')) model = p.voice.sttProvider
  if (p.voice?.ttsVoice) voice = p.voice.ttsVoice
} catch {
  /* defaults */
}
const SENTENCE = "Hi, this is Harman's AI assistant. This is a test of the call audio. If you can hear me clearly, the call line works."
const resultFile = join(dir, 'result.json')
writeFileSync(join(dir, 'rec.html'), '<title>rec</title>')
writeFileSync(
  join(dir, 'entry.ts'),
  `import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GoogleGenAI, Modality } from '@google/genai'
import { CallAgent } from ${JSON.stringify(resolve('src/main/voice/callAgent.ts'))}
app.on('window-all-closed', () => {})
const wav = (pcm: Buffer, rate: number) => { const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]) }
app.whenReady().then(async () => {
  const res: Record<string, unknown> = {}
  const step = (s: string) => { res.lastStep = s; console.log(s) }
  try {
    const enc = JSON.parse(readFileSync(join(app.getPath('userData'), 'desktop', 'secrets.json'), 'utf8')).values['gemini.apiKey']
    const key = safeStorage.decryptString(Buffer.from(enc, 'base64'))
    const ai = new GoogleGenAI({ apiKey: key })
    const log = { info() {}, warn() {}, error() {} }
    const agent = new CallAgent(log as never, ${JSON.stringify(resolve('out/preload'))})
    const cmd = (c: unknown) => (agent as unknown as { cmd(c: unknown): void }).cmd(c)
    step('1/5 checking the cable')
    res.cable = await agent.checkAudio()
    if (!(res.cable as { ok: boolean }).ok) throw new Error('CABLE Input not found')

    step('2/5 ZVYRA speaks (Gemini Live voice)')
    const chunks: Buffer[] = []
    await new Promise<void>((done, fail) => {
      const t = setTimeout(() => fail(new Error('Gemini Live voice timed out')), 40000)
      ai.live.connect({
        model: ${JSON.stringify(model)},
        config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ${JSON.stringify(voice)} } } }, systemInstruction: 'Read the user message aloud exactly as written. Add nothing.' },
        callbacks: {
          onmessage: (m) => {
            for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, 'base64'))
            if (m.serverContent?.turnComplete) { clearTimeout(t); done() }
          },
          onclose: (e) => { if (!chunks.length) { clearTimeout(t); fail(new Error('Live closed: ' + (e.reason || e.code))) } }
        }
      }).then((s) => { s.sendRealtimeInput({ text: ${JSON.stringify(SENTENCE)} }); setTimeout(() => { try { s.close() } catch {} }, 38000) }, fail)
    })
    const voicePcm = Buffer.concat(chunks)
    res.zvyraSeconds = +(voicePcm.length / 48000).toFixed(1)

    step('3/5 recording CABLE Output while ZVYRA plays into the call line')
    const ses = session.fromPartition('zvyra-calltest-rec')
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(true))
    ses.setPermissionCheckHandler(() => true)
    const rec = new BrowserWindow({ show: false, webPreferences: { session: ses, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } })
    await rec.loadFile(${JSON.stringify(join(dir, 'rec.html'))})
    const seconds = Math.ceil(voicePcm.length / 48000) + 2
    const recording = rec.webContents.executeJavaScript(\`(async () => {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); probe.getTracks().forEach(t => t.stop())
      const dev = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audioinput' && /CABLE Output/i.test(d.label))
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } })
      const ctx = new AudioContext({ sampleRate: 24000 }); const src = ctx.createMediaStreamSource(s); const sp = ctx.createScriptProcessor(4096, 1, 1)
      const parts = []; sp.onaudioprocess = (e) => parts.push(new Float32Array(e.inputBuffer.getChannelData(0))); src.connect(sp); sp.connect(ctx.destination)
      await new Promise(r => setTimeout(r, \${seconds} * 1000))
      s.getTracks().forEach(t => t.stop()); await ctx.close()
      const n = parts.reduce((a, p) => a + p.length, 0); const pcm = new Int16Array(n); let o = 0; let peak = 0
      for (const p of parts) for (const v of p) { peak = Math.max(peak, Math.abs(v)); pcm[o++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767))) }
      let bin = ''; const u8 = new Uint8Array(pcm.buffer); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
      return { device: dev.label, peak, b64: btoa(bin) }
    })()\`, true)
    await new Promise((r) => setTimeout(r, 800))
    for (let i = 0; i < voicePcm.length; i += 9600) cmd({ type: 'play', pcm: new Uint8Array(voicePcm.subarray(i, i + 9600)) })
    const got = (await recording) as { device: string; peak: number; b64: string }
    const recorded = Buffer.from(got.b64, 'base64')
    writeFileSync(${JSON.stringify(join(outDir, 'zvyra-through-cable.wav'))}, wav(recorded, 24000))
    res.cableRecording = { device: got.device, peak: +got.peak.toFixed(3), seconds: +(recorded.length / 48000).toFixed(1), file: ${JSON.stringify(join(outDir, 'zvyra-through-cable.wav'))} }

    step('4/5 playing the recording on your speakers while ZVYRA listens (system loopback)')
    const heard: Buffer[] = []
    ipcMain.on('zvyra:voice-audio', (_e, pcm: Uint8Array) => heard.push(Buffer.from(pcm)))
    cmd({ type: 'start', deviceId: null })
    await new Promise((r) => setTimeout(r, 1200))
    await rec.webContents.executeJavaScript(\`(async () => {
      const b = Uint8Array.from(atob(\${JSON.stringify(got.b64)}), c => c.charCodeAt(0)); const pcm = new Int16Array(b.buffer)
      const ctx = new AudioContext({ sampleRate: 24000 }); const buf = ctx.createBuffer(1, pcm.length, 24000); const ch = buf.getChannelData(0)
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
      const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination); s.start()
      await new Promise(r => s.onended = r); await ctx.close(); return true
    })()\`, true)
    await new Promise((r) => setTimeout(r, 800))
    cmd({ type: 'stop' })
    const loop = Buffer.concat(heard)
    writeFileSync(${JSON.stringify(join(outDir, 'zvyra-heard-on-pc.wav'))}, wav(loop, 16000))
    res.loopback = { seconds: +(loop.length / 32000).toFixed(1), file: ${JSON.stringify(join(outDir, 'zvyra-heard-on-pc.wav'))} }

    step('5/5 transcribing what ZVYRA heard')
    const r = await ai.models.generateContent({ model: 'gemini-flash-lite-latest', contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: wav(loop, 16000).toString('base64') } }, { text: 'Transcribe the speech in this audio exactly. Reply with the words only.' }] }] })
    res.transcript = (r.text ?? '').trim()
    rec.destroy()
    agent.dispose()
  } catch (e) { res.error = String((e as Error)?.message ?? e) }
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(res, null, 1))
  app.exit(0)
})`
)
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'main.cjs'), external: ['electron'], nodePaths: [resolve('node_modules')], logLevel: 'error' })
const r = spawnSync(resolve('node_modules/electron/dist/electron.exe'), [join(dir, 'main.cjs'), `--user-data-dir=${profile}`], { encoding: 'utf8', timeout: 180_000 })
process.stdout.write(r.stdout ?? '')
try {
  const res = JSON.parse(readFileSync(resultFile, 'utf8'))
  console.log(JSON.stringify(res, null, 1))
  if (res.transcript) {
    const words = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean)
    const said = new Set(words(SENTENCE))
    const got = new Set(words(res.transcript))
    console.log(`\nMATCH: ${[...said].filter((w) => got.has(w)).length}/${said.size} words of the test sentence were heard back`)
  }
} catch {
  console.log('no result (Electron exited early)', r.stderr?.slice(0, 500))
}
rmSync(dir, { recursive: true, force: true })
