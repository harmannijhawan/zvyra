/**
 * OWNER: Kiro. Hidden voice window: captures the microphone with echo
 * cancellation, resamples to 16 kHz PCM16 for the main-process engine, and
 * plays Gemini's 24 kHz PCM16 replies gaplessly. No UI, no network access.
 */
import type { VoiceCommand, VoiceWindowEvent } from '@shared/voiceIo'

interface VoiceBridge {
  sendAudio(pcm: ArrayBuffer): void
  sendEvent(e: VoiceWindowEvent): void
  onCommand(cb: (c: VoiceCommand) => void): void
}
const io = (window as unknown as { zvyraVoice?: VoiceBridge }).zvyraVoice
if (!io) throw new Error('voice bridge unavailable')

/** voice.html#call: the call window. Captures what the PC plays (the other person on a WhatsApp call)
 *  and plays ZVYRA's voice into a chosen output (a virtual cable that WhatsApp uses as its microphone). */
const CALL = location.hash === '#call'

/* ---------------------------------------------------------------- capture */

// AudioWorklet: averages input down to 16 kHz and posts 100 ms PCM16 frames.
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; this.sum = 0; this.n = 0;
    this.buf = new Int16Array(1600); this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.n++; this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        let v = this.sum / this.n; this.sum = 0; this.n = 0;
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        this.buf[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.len === this.buf.length) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Int16Array(1600); this.len = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('zvyra-capture', Capture);
`

let capture: { ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null = null

async function startCapture(deviceId: string | null) {
  await stopCapture()
  try {
    const stream = CALL
      ? await loopbackStream()
      : await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        })
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'zvyra-capture', { numberOfInputs: 1, numberOfOutputs: 0 })
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => io!.sendAudio(e.data)
    src.connect(node)
    capture = { ctx, stream, node }
    const track = stream.getAudioTracks()[0]
    track.addEventListener('ended', () => {
      if (capture?.stream === stream) io!.sendEvent({ type: 'error', message: 'The microphone was disconnected' })
    })
    io!.sendEvent({ type: 'started', deviceLabel: track.label })
    void enumerate()
  } catch (err) {
    const e = err as DOMException
    const permission = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
    io!.sendEvent({
      type: 'error',
      permission,
      message: permission
        ? 'Microphone access is blocked. Allow desktop apps to use the microphone in Windows Settings → Privacy & security → Microphone.'
        : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError'
          ? 'No microphone found. Plug one in or choose another device.'
          : `Microphone error: ${e?.message ?? String(err)}`
    })
  }
}

/** System audio (WASAPI loopback, granted by the main process); the video track is dropped at once. */
async function loopbackStream(): Promise<MediaStream> {
  const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  for (const v of s.getVideoTracks()) {
    v.stop()
    s.removeTrack(v)
  }
  if (!s.getAudioTracks().length) throw new Error('System audio capture is not available')
  return s
}

/** The user's own microphone routed into the call output (for "let me talk"). */
let pass: { stream: MediaStream; ctx: AudioContext } | null = null
/** Output device chosen for the call (the cable); the passthrough plays into the same device. */
let sinkId = ''

async function passthrough(micLabel: string | null) {
  if (pass) {
    pass.stream.getTracks().forEach((t) => t.stop())
    void pass.ctx.close()
    pass = null
  }
  if (micLabel === null) {
    io!.sendEvent({ type: 'passthrough', ok: true })
    return
  }
  try {
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && !/CABLE/i.test(d.label) && !/^(default|communications)$/.test(d.deviceId))
    const want = micLabel.toLowerCase()
    const mic = mics.find((d) => d.label.toLowerCase().includes(want) || want.includes(d.label.toLowerCase().replace(/\s*\(.*$/, ''))) ?? mics[0]
    if (!mic) throw new Error('No microphone found')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: mic.deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    // Its own context at the mic's native rate (mixing sample rates across contexts isn't allowed).
    const ctx = new AudioContext({ latencyHint: 'interactive' }) as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (sinkId && ctx.setSinkId) await ctx.setSinkId(sinkId)
    ctx.createMediaStreamSource(stream).connect(ctx.destination)
    pass = { stream, ctx }
    io!.sendEvent({ type: 'passthrough', ok: true, label: mic.label })
  } catch (err) {
    io!.sendEvent({ type: 'passthrough', ok: false, error: String((err as Error)?.message ?? err) })
  }
}

async function chooseSink(label: string | null) {
  try {
    // Device labels are only visible after an audio permission grant.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
    probe?.getTracks().forEach((t) => t.stop())
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
    const pick = label ? outs.find((d) => d.label.toLowerCase().includes(label.toLowerCase())) : undefined
    const sinkable = out as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (label && (!pick || !sinkable.setSinkId)) {
      io!.sendEvent({ type: 'sink', ok: false, outputs: outs.map((d) => d.label) })
      return
    }
    if (sinkable.setSinkId) await sinkable.setSinkId(pick ? pick.deviceId : '')
    sinkId = pick ? pick.deviceId : ''
    io!.sendEvent({ type: 'sink', ok: true, label: pick?.label ?? 'default', outputs: outs.map((d) => d.label) })
  } catch (err) {
    io!.sendEvent({ type: 'sink', ok: false, outputs: [], label: String((err as Error)?.message ?? err) })
  }
}

async function stopCapture() {
  if (!capture) return
  const c = capture
  capture = null
  c.node.port.onmessage = null
  c.stream.getTracks().forEach((t) => t.stop())
  await c.ctx.close().catch(() => undefined)
  io!.sendEvent({ type: 'stopped' })
}

async function enumerate() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices()
    io!.sendEvent({
      type: 'devices',
      devices: list
        .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
        .map((d) => ({ id: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || 'Microphone', isDefault: d.deviceId === 'default' }))
    })
  } catch {
    /* ignore */
  }
}
navigator.mediaDevices.addEventListener('devicechange', () => void enumerate())

/* ---------------------------------------------------------------- playback */

const out = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' })
const outGain = out.createGain()
const analyser = out.createAnalyser()
analyser.fftSize = 512
outGain.connect(analyser)
analyser.connect(out.destination)
let playHead = 0
let sources: AudioBufferSourceNode[] = []
let drainTimer: number | null = null
let levelTimer: number | null = null

function play(pcm: Uint8Array) {
  if (out.state === 'suspended') void out.resume()
  const n = Math.floor(pcm.byteLength / 2)
  if (!n) return
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  const buf = out.createBuffer(1, n, 24000)
  const ch = buf.getChannelData(0)
  for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768
  const src = out.createBufferSource()
  src.buffer = buf
  src.connect(outGain)
  const now = out.currentTime
  if (playHead < now + 0.02) playHead = now + 0.06 // small jitter buffer after gaps
  src.start(playHead)
  playHead += buf.duration
  sources.push(src)
  src.onended = () => {
    sources = sources.filter((s) => s !== src)
    scheduleDrain()
  }
  startLevels()
}

function scheduleDrain() {
  if (drainTimer !== null) clearTimeout(drainTimer)
  const remaining = Math.max(0, playHead - out.currentTime)
  drainTimer = window.setTimeout(() => {
    drainTimer = null
    if (sources.length === 0 && playHead <= out.currentTime + 0.01) {
      stopLevels()
      io!.sendEvent({ type: 'drained' })
    }
  }, remaining * 1000 + 120)
}

function flush() {
  for (const s of sources) {
    try {
      s.stop()
    } catch {
      /* already stopped */
    }
  }
  sources = []
  playHead = 0
  stopLevels()
  io!.sendEvent({ type: 'drained' })
}

function startLevels() {
  if (levelTimer !== null) return
  const data = new Uint8Array(analyser.fftSize)
  levelTimer = window.setInterval(() => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (const v of data) sum += ((v - 128) / 128) ** 2
    io!.sendEvent({ type: 'outLevel', level: Math.min(1, Math.sqrt(sum / data.length) * 3) })
  }, 70)
}
function stopLevels() {
  if (levelTimer !== null) clearInterval(levelTimer)
  levelTimer = null
  io!.sendEvent({ type: 'outLevel', level: 0 })
}

/** Short, soft two-tone chime generated locally. */
function chime(kind: 'wake' | 'sleep' | 'error') {
  if (CALL) return // never beep into a phone call
  if (out.state === 'suspended') void out.resume()
  const tones = kind === 'wake' ? [660, 990] : kind === 'sleep' ? [880, 587] : [330, 262]
  const t0 = out.currentTime + 0.01
  tones.forEach((f, i) => {
    const o = out.createOscillator()
    const g = out.createGain()
    o.type = 'sine'
    o.frequency.value = f
    const s = t0 + i * 0.11
    g.gain.setValueAtTime(0, s)
    g.gain.linearRampToValueAtTime(0.12, s + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.16)
    o.connect(g).connect(out.destination)
    o.start(s)
    o.stop(s + 0.18)
  })
}

/* ---------------------------------------------------------------- commands */

io.onCommand((c) => {
  switch (c.type) {
    case 'start':
      void startCapture(c.deviceId)
      break
    case 'stop':
      void stopCapture()
      break
    case 'play':
      play(c.pcm)
      break
    case 'flush':
      flush()
      break
    case 'chime':
      chime(c.kind)
      break
    case 'enumerate':
      void enumerate()
      break
    case 'sink':
      void chooseSink(c.label)
      break
    case 'passthrough':
      void passthrough(c.micLabel)
      break
  }
})

io.sendEvent({ type: 'ready' })
void enumerate()
