/**
 * OWNER: Kiro. ZVYRA voice engine.
 *
 *   mic (hidden voice window, echo-cancelled) ──16 kHz PCM──▶ main
 *     standby:  on-device "Hey Zvyra" spotter (sherpa-onnx, nothing leaves the PC)
 *     awake:    Gemini Live session (native audio in/out, transcripts, tools)
 *   Gemini 24 kHz PCM ──▶ voice window playback (gapless, flushable)
 *
 * Conversation ends after an idle timeout, a sleep phrase, or the model calling
 * end_conversation; the engine then returns to standby (wake word) or off.
 */
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ActivityHandling,
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  Type,
  type FunctionDeclaration,
  type LiveConnectConfig,
  type LiveServerMessage,
  type Session
} from '@google/genai'
import type { Interaction, MicDevice, VoiceEngineOption, VoiceState, VoiceStatus, ZvyraEventMap } from '../../shared/contract'
import type { VoiceCommand, VoiceWindowEvent } from '../../shared/voiceIo'
import type { ShellLogger } from '../backendContext'
import { DEFAULT_LIVE_MODEL, DEFAULT_VOICE, GEMINI_VOICES, isSleepPhrase, pickConversationalLiveModels, type LiveModel } from './catalog'
import { concatFrames, pcm16ToFloat, startsAfterPause, WakeSpotter } from './wakeSpotter'
import { PersonalWake, SpeechSegmenter, wavHeader } from './personalWake'
import { AGENT_GUIDE } from './desktopTools'
import { ALL_TOOL_DECLARATIONS, runTool, type ToolHost } from './extraTools'

export interface VoiceConfig {
  wakeEnabled: boolean
  sensitivity: number
  micDeviceId: string | null
  model: string
  voice: string
  /** Seconds of silence before a conversation goes back to sleep. */
  idleTimeoutSec: number
  /** End-of-speech pause the model waits for (ms). */
  silenceMs: number
  speakingRate: number
  /** Keep the conversation open until the user ends it (no idle timeout). */
  stayAwake?: boolean
}

export interface VoiceTools {
  host: ToolHost
  systemContext(): Promise<string>
}

export interface VoiceEngineDeps {
  resourcesPath: string
  workDir: string
  logger: ShellLogger
  getKey(): string | null
  getConfig(): VoiceConfig
  tools: VoiceTools
  emit<K extends keyof ZvyraEventMap>(type: K, payload: ZvyraEventMap[K]): void
  activity(type: string, title: string, detail?: string, level?: 'info' | 'success' | 'warning' | 'error'): void
  /** Called with each finished voice exchange (for history). */
  onInteraction?(i: Interaction): void
}

type Phase = 'off' | 'standby' | 'connecting' | 'listening' | 'speaking'

const PRE_ROLL_FRAMES = 60 // 6 s of 100 ms frames buffered while the session opens
const BARGE_RMS = 0.045
const BARGE_FRAMES = 3
/** Voice activity thresholds for the "speech detected" indicator (echo-cancelled mic RMS). */
const SPEECH_RMS = 0.03
const SILENCE_RMS = 0.018
const SPEECH_MIN_MS = 150
/** If the model hasn't started answering this long after the user stopped, drop the "processing" state. */
const REPLY_GUARD_MS = 12_000
/** 100 ms frames of standby audio kept for verifying a wake (~1.8 s, the length of "Hey Zvyra"). */
const WAKE_RING_FRAMES = 18
/** No words heard this long after a wake → it was a false wake: go back to standby quietly. */
const FALSE_WAKE_MS = 10_000
const MAX_AUTO_SAMPLES = 10
const MAX_NEGATIVE_SAMPLES = 24

// Builder-only tools stay with the background agent; voice hands big builds to run_task.
const VOICE_SKIP = new Set(['edit_file', 'list_tree', 'check_site'])
const TOOLS: FunctionDeclaration[] = [
  ...ALL_TOOL_DECLARATIONS.filter((d) => !VOICE_SKIP.has(d.name ?? '')),
  { name: 'end_conversation', description: 'Call when the user says goodbye or indicates they are done talking. Say a brief goodbye first.', parameters: { type: Type.OBJECT, properties: {} } }
]

export class VoiceEngine {
  private win: BrowserWindow | null = null
  private winReady = false
  private capturing = false
  private phase: Phase = 'off'
  private error: string | undefined
  private micLabel: string | null = null
  private devices: MicDevice[] = []
  private spotter: WakeSpotter | null = null
  private spotterKey = ''
  private session: Session | null = null
  private sessionId = 0
  private resumeHandle: string | null = null
  private preRoll: Uint8Array[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private lastActivity = 0
  private bargeCount = 0
  private modelTurnActive = false
  private drained = true
  private endAfterTurn = false
  private interaction: Interaction | null = null
  private partial = ''
  private lastTranscript: string | undefined
  private levelAt = 0
  private outLevel = 0
  private models: LiveModel[] = []
  private modelsAt = 0
  private disabledFeatures = new Set<'vad' | 'resume' | 'compression'>()
  private speakOnly: { resolve: () => void } | null = null
  private ipcBound = false
  private micRetries = 0
  private captureDevice: string | null | undefined = undefined
  /* Live interaction state (drives the Dynamic Island; all derived from real audio / session events). */
  private userSpeaking = false
  private speechSince = 0
  private quietSince = 0
  /** The user finished an utterance and ZVYRA hasn't answered yet. */
  private awaitingReply = false
  private awaitTimer: NodeJS.Timeout | null = null
  private toolsRunning = 0
  private wakeAt = 0
  /* Wake-word accuracy: last ~2 s of standby audio, ZVYRA's own playback, and the clip that woke us. */
  private wakeRing: Float32Array[] = []
  private lastOutAt = 0
  private wakeClip: Float32Array | null = null
  private wakeCheck: { timer: NodeJS.Timeout; session: number } | null = null
  private negativeWake: PersonalWake | null = null

  constructor(private readonly d: VoiceEngineDeps) {}

  /* ================================================================ status */

  private state(): VoiceState {
    if (this.error && this.phase === 'off') return 'error'
    switch (this.phase) {
      case 'off':
        return 'off'
      case 'standby':
        return 'standby'
      case 'connecting':
        return 'wake_detected'
      case 'listening':
        // "Processing": the model is producing a turn, a tool is running, or the user
        // finished speaking and the reply hasn't started yet.
        return this.modelTurnActive || this.toolsRunning > 0 || (this.awaitingReply && !this.userSpeaking) ? 'transcribing' : 'listening'
      case 'speaking':
        return 'speaking'
    }
  }

  status(): VoiceStatus {
    const cfg = this.d.getConfig()
    const hasKey = !!this.d.getKey()
    const live = { id: 'gemini-live', name: `Gemini Live · ${cfg.model}`, ready: hasKey, processing: 'external' as const, setupRequired: hasKey ? undefined : 'Add a Gemini API key in Settings → Voice' }
    return {
      state: this.state(),
      wakeWordEnabled: cfg.wakeEnabled,
      wakePhrase: 'Hey Zvyra',
      wake: { id: 'zvyra-kws', name: 'ZVYRA wake word (on-device)', ready: true, processing: 'local' },
      stt: live,
      tts: { ...live, name: `Gemini voice · ${cfg.voice}` },
      micAvailable: this.capturing || this.devices.length > 0,
      micDeviceId: cfg.micDeviceId,
      micLabel: this.micLabel ?? undefined,
      partialTranscript: this.partial || undefined,
      lastTranscript: this.lastTranscript,
      error: this.error,
      userSpeaking: this.phase === 'listening' && this.userSpeaking
    }
  }

  /* ================================================================ live interaction state */

  /** On-device voice activity detection while a conversation is open (100 ms frames). */
  private trackSpeech(rms: number, now: number) {
    const cfg = this.d.getConfig()
    if (rms > SPEECH_RMS) {
      this.quietSince = 0
      if (!this.speechSince) this.speechSince = now
      if (!this.userSpeaking && now - this.speechSince >= SPEECH_MIN_MS) {
        this.userSpeaking = true
        this.setAwaiting(false)
        this.publish()
      }
      return
    }
    this.speechSince = 0
    if (!this.userSpeaking) return
    if (rms < SILENCE_RMS) {
      if (!this.quietSince) this.quietSince = now
      // Same end-of-speech pause the model's own detector uses.
      if (now - this.quietSince >= Math.min(3000, Math.max(300, cfg.silenceMs))) {
        this.userSpeaking = false
        this.quietSince = 0
        this.setAwaiting(true)
        this.publish()
      }
    }
  }

  /** Waiting for ZVYRA's answer. A guard clears it if the model never responds (noise, dropped turn). */
  private setAwaiting(on: boolean) {
    if (this.awaitTimer) clearTimeout(this.awaitTimer)
    this.awaitTimer = null
    this.awaitingReply = on
    if (on) {
      const session = this.sessionId
      this.awaitTimer = setTimeout(() => {
        this.awaitTimer = null
        if (session !== this.sessionId || !this.awaitingReply) return
        this.awaitingReply = false
        this.publish()
      }, REPLY_GUARD_MS)
    }
  }

  private resetLive() {
    this.userSpeaking = false
    this.speechSince = 0
    this.quietSince = 0
    this.toolsRunning = 0
    this.setAwaiting(false)
  }

  private publish() {
    this.d.emit('voice.status', this.status())
  }

  private fail(message: string) {
    this.error = message
    this.d.logger.warn('voice', message)
    this.publish()
  }

  /* ================================================================ window */

  private ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return
    this.winReady = false
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/voice.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        partition: 'zvyra-voice' // own session so its mic-only permission policy can't affect other windows
      }
    })
    win.webContents.session.setPermissionRequestHandler((wc, permission, cb, details) => {
      if (wc.id !== win.webContents.id) return cb(false)
      const media = details as { mediaTypes?: string[] }
      cb(permission === 'media' && !(media.mediaTypes ?? []).includes('video'))
    })
    this.win = win
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev) void win.loadURL(`${dev}/voice.html`)
    else void win.loadFile(join(__dirname, '../renderer/voice.html'))
    win.on('closed', () => {
      this.win = null
      this.winReady = false
      this.capturing = false
    })
    if (!this.ipcBound) {
      this.ipcBound = true
      ipcMain.on('zvyra:voice-audio', (e, pcm: Uint8Array) => {
        if (this.isVoiceSender(e)) this.onAudio(pcm)
      })
      ipcMain.on('zvyra:voice-event', (e, ev: VoiceWindowEvent) => this.isVoiceSender(e) && this.onWindowEvent(ev))
    }
  }

  private isVoiceSender(e: IpcMainEvent) {
    return !!this.win && !this.win.isDestroyed() && e.sender.id === this.win.webContents.id
  }

  private cmd(c: VoiceCommand) {
    if (!this.win || this.win.isDestroyed()) return
    if (!this.winReady) return
    if (c.type === 'start') this.captureDevice = c.deviceId
    if (c.type === 'stop') this.captureDevice = undefined
    this.win.webContents.send('zvyra:voice-cmd', c)
  }

  private pendingStart = false

  private startCapture() {
    this.ensureWindow()
    if (!this.winReady) {
      this.pendingStart = true
      return
    }
    this.cmd({ type: 'start', deviceId: this.d.getConfig().micDeviceId })
  }

  private stopCapture() {
    this.pendingStart = false
    this.cmd({ type: 'stop' })
    this.capturing = false
  }

  private onWindowEvent(ev: VoiceWindowEvent) {
    switch (ev.type) {
      case 'ready':
        this.winReady = true
        if (this.pendingStart || this.phase !== 'off') {
          this.pendingStart = false
          this.cmd({ type: 'start', deviceId: this.d.getConfig().micDeviceId })
        }
        break
      case 'started':
        this.capturing = true
        this.micRetries = 0
        this.micLabel = ev.deviceLabel
        if (this.error?.startsWith('Microphone') || this.error?.startsWith('No microphone')) this.error = undefined
        this.publish()
        break
      case 'stopped':
        this.capturing = false
        break
      case 'error': {
        this.capturing = false
        this.d.emit('voice.level', { level: 0 })
        // Transient device loss (sleep/resume, USB re-plug): retry a few times before giving up.
        if (!ev.permission && this.micRetries < 5 && this.phase !== 'off') {
          this.micRetries++
          this.d.logger.warn('voice', `${ev.message} — retrying (${this.micRetries})`)
          setTimeout(() => this.phase !== 'off' && this.cmd({ type: 'start', deviceId: this.d.getConfig().micDeviceId }), 1500 * this.micRetries)
          break
        }
        this.endSession('mic error')
        this.phase = 'off'
        this.fail(ev.message)
        break
      }
      case 'devices':
        this.devices = ev.devices.map((x) => ({ id: x.id, label: x.label, isDefault: x.isDefault }))
        break
      case 'drained':
        this.drained = true
        if (this.speakOnly) {
          this.speakOnly.resolve()
          this.speakOnly = null
        }
        if (this.phase === 'speaking' && !this.modelTurnActive) {
          this.phase = 'listening'
          this.touch()
          if (this.endAfterTurn) this.sleep('conversation ended')
          else this.publish()
        }
        break
      case 'outLevel':
        this.outLevel = ev.level
        if (ev.level > 0.02) this.lastOutAt = Date.now()
        if (this.phase === 'speaking') this.d.emit('voice.level', { level: ev.level })
        break
    }
  }

  /* ================================================================ audio in */

  private spotterFor(cfg: VoiceConfig) {
    const key = cfg.sensitivity.toFixed(2)
    if (!this.spotter || this.spotterKey !== key) {
      this.spotter = new WakeSpotter({ modelDir: join(this.d.resourcesPath, 'kws'), workDir: this.d.workDir, sensitivity: cfg.sensitivity })
      this.spotterKey = key
    }
    return this.spotter
  }

  private onAudio(pcm: Uint8Array, injected = false) {
    if (this.injecting && !injected) return
    const now = Date.now()
    const floats = pcm16ToFloat(pcm)
    let sum = 0
    for (let i = 0; i < floats.length; i++) sum += floats[i] * floats[i]
    const rms = Math.sqrt(sum / Math.max(1, floats.length))
    if (this.phase !== 'speaking' && now - this.levelAt > 60) {
      this.levelAt = now
      this.d.emit('voice.level', { level: Math.min(1, rms * 6) })
    }

    switch (this.phase) {
      case 'standby': {
        if (process.env['ZVYRA_WAKE_DEBUG']) this.wakeDebug(pcm, rms, now)
        this.wakeRing.push(floats)
        if (this.wakeRing.length > WAKE_RING_FRAMES) this.wakeRing.shift()
        // Personal wake word: the user's own recorded “Hey Zvyra” samples.
        const segment = this.segmenter.push(floats, rms)
        if (segment && this.onSegment(segment, pcm, now)) return
        try {
          const hit = this.spotterFor(this.d.getConfig()).feed(floats, now)
          if (hit) this.verifyWake(hit, now)
        } catch (err) {
          this.fail(`Wake word engine failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'connecting':
        this.preRoll.push(pcm)
        if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
        return
      case 'listening':
        this.send(pcm)
        if (rms > 0.02) this.touch()
        this.trackSpeech(rms, now)
        return
      case 'speaking': {
        // Barge-in: sustained speech over the (echo-cancelled) mic interrupts the reply.
        const threshold = Math.max(BARGE_RMS, this.outLevel * 0.35)
        this.bargeCount = rms > threshold ? this.bargeCount + 1 : 0
        if (this.bargeCount >= BARGE_FRAMES) {
          this.bargeCount = 0
          this.cmd({ type: 'flush' })
          this.phase = 'listening'
          this.modelTurnActive = false
          // The user is talking over the reply: that's speech, not processing.
          this.setAwaiting(false)
          this.userSpeaking = true
          this.speechSince = now
          this.quietSince = 0
          this.touch()
          this.publish()
          this.send(pcm)
        }
        return
      }
      default:
        return
    }
  }

  /* Dev diagnostic (ZVYRA_WAKE_DEBUG=1): logs standby mic levels and saves each spoken
     utterance as a local 16 kHz WAV so the spotter can be tuned to the user's real voice. */
  private dbg = { frames: 0, peak: 0, lastLog: 0, ring: [] as Uint8Array[], speech: 0, quiet: 0, saved: 0 }
  private wakeDebug(pcm: Uint8Array, rms: number, now: number) {
    const d = this.dbg
    d.frames++
    d.peak = Math.max(d.peak, rms)
    if (now - d.lastLog > 5000) {
      this.d.logger.info('wake-debug', 'standby mic', { frames: d.frames, peakRms: +d.peak.toFixed(4), device: this.micLabel })
      d.lastLog = now
      d.frames = 0
      d.peak = 0
    }
    d.ring.push(pcm)
    if (d.ring.length > 40) d.ring.shift()
    if (rms > 0.015) {
      d.speech++
      d.quiet = 0
    } else if (d.speech) d.quiet++
    if (d.speech >= 3 && d.quiet >= 6 && d.saved < 30) {
      const body = Buffer.concat(d.ring.map((b) => Buffer.from(b)))
      const h = Buffer.alloc(44)
      h.write('RIFF', 0)
      h.writeUInt32LE(36 + body.length, 4)
      h.write('WAVEfmt ', 8)
      h.writeUInt32LE(16, 16)
      h.writeUInt16LE(1, 20)
      h.writeUInt16LE(1, 22)
      h.writeUInt32LE(16000, 24)
      h.writeUInt32LE(32000, 28)
      h.writeUInt16LE(2, 32)
      h.writeUInt16LE(16, 34)
      h.write('data', 36)
      h.writeUInt32LE(body.length, 40)
      const dir = join(this.d.workDir, 'wake-debug')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `utt-${String(++d.saved).padStart(2, '0')}.wav`)
      writeFileSync(file, Buffer.concat([h, body]))
      this.d.logger.info('wake-debug', 'saved utterance', { file, seconds: +(body.length / 32000).toFixed(1) })
      d.speech = d.quiet = 0
      d.ring = []
    }
    if (d.quiet > 30) d.speech = d.quiet = 0
  }

  /* ================================================================ personal wake word */

  private segmenter = new SpeechSegmenter()
  private personalWake: PersonalWake | null = null
  private personalCooldown = 0
  private training = 0

  private get templatesDir() {
    return join(this.d.workDir, 'wake-templates')
  }

  private personal() {
    if (!this.personalWake) this.personalWake = new PersonalWake(this.templatesDir)
    return this.personalWake
  }

  private get negativesDir() {
    return join(this.d.workDir, 'wake-negatives')
  }

  private negatives() {
    if (!this.negativeWake) this.negativeWake = new PersonalWake(this.negativesDir)
    return this.negativeWake
  }

  /** Returns true when the segment woke ZVYRA (or was consumed as a training sample). */
  private onSegment(segment: Float32Array, _pcm: Uint8Array, now: number): boolean {
    if (this.training > 0) {
      this.saveTemplate(segment)
      return true
    }
    const pw = this.personal()
    if (!pw.count) return false
    const s = this.d.getConfig().sensitivity
    pw.setThreshold(9.4 + s * 2) // sensitivity 0.8 → 11.0 (look-alike phrases score ≥ 12)
    const m = pw.match(segment)
    if (Number.isFinite(m.score) && m.score < 13) this.d.logger.info('voice', 'personal wake', { score: +m.score.toFixed(2), fired: m.fired })
    if (m.fired && now >= this.personalCooldown) {
      // A clip that sounds more like an earlier false wake than like the user's "Hey Zvyra" is ignored.
      const neg = this.negatives().nearest(segment)
      if (neg < m.score) {
        this.d.logger.info('voice', 'wake rejected', { why: 'matches a previous false wake', score: +m.score.toFixed(2), negative: +neg.toFixed(2) })
        return false
      }
      if (this.echoing(now)) return false
      this.personalCooldown = now + 2000
      this.spotter?.reset()
      this.wakeClip = segment
      this.onWake()
      return true
    }
    return false
  }

  /** ZVYRA's own voice is (or just was) coming out of the speakers. */
  private echoing(now: number) {
    if (now - this.lastOutAt < 1500) {
      this.d.logger.info('voice', 'wake rejected', { why: 'ZVYRA was speaking' })
      return true
    }
    return false
  }

  /**
   * Second stage for keyword-spotter hits. The spotter is tuned to catch the
   * wake word easily; this check removes false triggers:
   *  - never while ZVYRA's own audio plays (echo),
   *  - clips that match an earlier false wake are rejected,
   *  - with the user's voice samples (recorded or learned), the clip must sound like them,
   *  - accent look-alikes ("his veera") must start after a pause, not mid-sentence.
   */
  private verifyWake(kind: 'core' | 'loose', now: number) {
    if (now < this.personalCooldown || this.echoing(now)) return
    const clip = concatFrames(this.wakeRing)
    const pw = this.personal()
    const s = this.d.getConfig().sensitivity
    pw.setThreshold(9.4 + s * 2)
    const pos = pw.nearest(clip)
    const neg = this.negatives().nearest(clip)
    const reject = (why: string) => this.d.logger.info('voice', 'wake rejected', { why, kind, score: Number.isFinite(pos) ? +pos.toFixed(2) : null, negative: Number.isFinite(neg) ? +neg.toFixed(2) : null })
    if (neg < pos && neg < pw.limit * 1.15) return reject('matches a previous false wake')
    if (pw.count >= 3) {
      // The spotter already agrees, so the voice match can be a little looser than the personal-only path.
      const allowed = pw.limit * (kind === 'core' ? 1.35 : 1.12)
      if (!(pos <= allowed)) return reject('does not sound like your “Hey Zvyra”')
    } else if (kind === 'loose' && !startsAfterPause(this.wakeRing)) {
      return reject('look-alike phrase in the middle of speech')
    }
    this.d.logger.info('voice', 'wake verified', { kind, score: Number.isFinite(pos) ? +pos.toFixed(2) : null })
    this.personalCooldown = now + 2000
    this.wakeClip = clip
    this.onWake()
  }

  /** Called when the woken conversation hears real words: this wake was right, so learn from it. */
  private confirmWake(learn: boolean) {
    if (!this.wakeCheck) return
    clearTimeout(this.wakeCheck.timer)
    this.wakeCheck = null
    const clip = this.wakeClip
    this.wakeClip = null
    if (clip && learn) this.saveSample(this.templatesDir, 'auto', clip, MAX_AUTO_SAMPLES, () => this.personal().reload())
  }

  /** After a wake: if no words arrive in time, it was a false wake. */
  private armWakeCheck() {
    const session = this.sessionId
    const arm = (ms: number): NodeJS.Timeout =>
      setTimeout(() => {
        if (!this.wakeCheck || this.sessionId !== session) return
        // Still talking or ZVYRA is answering: give it a little longer.
        if (this.userSpeaking || this.modelTurnActive || this.toolsRunning > 0 || this.phase === 'speaking') {
          this.wakeCheck.timer = arm(4000)
          return
        }
        if (this.phase === 'listening') this.falseWake()
      }, ms)
    this.wakeCheck = { session, timer: arm(FALSE_WAKE_MS) }
  }

  /** Woke up but nobody spoke: remember the clip so the same sound won't wake ZVYRA again. */
  private falseWake() {
    this.wakeCheck = null
    const clip = this.wakeClip
    this.wakeClip = null
    if (clip) this.saveSample(this.negativesDir, 'neg', clip, MAX_NEGATIVE_SAMPLES, () => this.negatives().reload())
    this.d.logger.info('voice', 'false wake: nothing was said, back to standby')
    this.sleep('false-wake')
  }

  private saveSample(dir: string, prefix: string, clip: Float32Array, max: number, after: () => void) {
    try {
      const sec = clip.length / 16000
      if (sec < 0.35 || sec > 3) return
      mkdirSync(dir, { recursive: true })
      const body = Buffer.alloc(clip.length * 2)
      for (let i = 0; i < clip.length; i++) body.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(clip[i] * 32767))), i * 2)
      writeFileSync(join(dir, `${prefix}-${Date.now()}.wav`), Buffer.concat([wavHeader(body.length), body]))
      const mine = readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`)).sort()
      for (const f of mine.slice(0, Math.max(0, mine.length - max))) rmSync(join(dir, f), { force: true })
      after()
      this.d.logger.info('voice', prefix === 'auto' ? 'learned from a real wake' : 'learned a false wake', { seconds: +sec.toFixed(2) })
    } catch (err) {
      this.d.logger.warn('voice', 'could not save wake sample', { message: String(err) })
    }
  }

  private saveTemplate(segment: Float32Array) {
    const sec = segment.length / 16000
    if (sec < 0.35 || sec > 2.8) return
    mkdirSync(this.templatesDir, { recursive: true })
    const body = Buffer.alloc(segment.length * 2)
    for (let i = 0; i < segment.length; i++) body.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(segment[i] * 32767))), i * 2)
    writeFileSync(join(this.templatesDir, `sample-${Date.now()}.wav`), Buffer.concat([wavHeader(body.length), body]))
    this.training--
    this.cmd({ type: 'chime', kind: this.training ? 'wake' : 'sleep' })
    this.d.logger.info('voice', 'wake sample saved', { seconds: +sec.toFixed(2), left: this.training })
    if (!this.training) this.personal().reload()
    this.d.emit('voice.wakeTraining', { recording: this.training, templates: this.wakeSamples() })
    if (!this.training) {
      this.d.activity('voice.wake', 'Learned your “Hey Zvyra”', `${this.personal().count} voice samples on this PC`, 'success')
    }
  }

  wakeSamples() {
    return existsSync(this.templatesDir) ? readdirSync(this.templatesDir).filter((f) => f.toLowerCase().endsWith('.wav')).length : 0
  }

  /** Teach the wake word: the next five short phrases spoken in standby become templates. */
  trainWake(action: 'start' | 'clear'): { templates: number; recording: number } {
    if (action === 'clear') {
      if (existsSync(this.templatesDir)) for (const f of readdirSync(this.templatesDir)) rmSync(join(this.templatesDir, f), { force: true })
      this.training = 0
      this.personal().reload()
      this.d.emit('voice.wakeTraining', { recording: 0, templates: 0 })
      return { templates: 0, recording: 0 }
    }
    if (this.phase !== 'standby') throw new Error('Turn on “Listen for Hey Zvyra” and end any conversation first.')
    this.segmenter.reset()
    this.training = 5
    this.cmd({ type: 'chime', kind: 'wake' })
    this.d.emit('voice.wakeTraining', { recording: this.training, templates: this.wakeSamples() })
    return { templates: this.wakeSamples(), recording: this.training }
  }

  private send(pcm: Uint8Array) {
    try {
      this.session?.sendRealtimeInput({ audio: { data: Buffer.from(pcm).toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    } catch (err) {
      this.d.logger.warn('voice', 'send failed', { message: String(err) })
    }
  }

  /* ================================================================ lifecycle */

  /** Applies wake-word on/off and device changes. */
  refresh() {
    const cfg = this.d.getConfig()
    if (this.phase === 'off' && cfg.wakeEnabled) {
      this.error = undefined
      this.phase = 'standby'
      this.startCapture()
    } else if (this.phase === 'standby' && !cfg.wakeEnabled) {
      this.phase = 'off'
      this.stopCapture()
      this.d.emit('voice.level', { level: 0 })
    } else if (this.capturing && this.captureDevice !== cfg.micDeviceId) {
      this.cmd({ type: 'start', deviceId: cfg.micDeviceId }) // device changed
    }
    if (this.phase === 'standby') this.prefetchContext()
    // Stay-awake switched off mid-conversation: start the normal idle countdown.
    if (this.phase === 'listening' || this.phase === 'speaking') this.touch()
    this.publish()
  }

  private onWake() {
    this.d.logger.info('voice', 'wake word detected')
    this.wakeAt = Date.now()
    this.d.activity('voice.wake', 'Wake word detected', '“Hey Zvyra”')
    this.cmd({ type: 'chime', kind: 'wake' })
    void this.converse('wake')
  }

  /** Push-to-talk or wake: opens a Gemini Live conversation. */
  async converse(reason: 'wake' | 'push') {
    if (this.phase === 'listening' || this.phase === 'speaking' || this.phase === 'connecting') return
    const key = this.d.getKey()
    if (!key) {
      this.cmd({ type: 'chime', kind: 'error' })
      this.fail('Add a Gemini API key in Settings → Voice to talk with ZVYRA')
      return
    }
    this.error = undefined
    if (reason === 'push') this.cmd({ type: 'chime', kind: 'wake' })
    this.phase = 'connecting'
    this.preRoll = []
    this.partial = ''
    this.endAfterTurn = false
    if (!this.capturing) this.startCapture()
    this.publish()
    try {
      await this.openSession(key)
    } catch (err) {
      this.phase = this.d.getConfig().wakeEnabled ? 'standby' : 'off'
      if (this.phase === 'off') this.stopCapture()
      this.cmd({ type: 'chime', kind: 'error' })
      this.fail(friendlyError(err))
      this.d.activity('voice.failed', 'Voice conversation failed to start', friendlyError(err), 'error')
      return
    }
    this.phase = 'listening'
    this.d.logger.info('voice', 'conversation open', { model: this.d.getConfig().model, voice: this.d.getConfig().voice, preRollFrames: this.preRoll.length, ms: this.wakeAt ? Date.now() - this.wakeAt : undefined })
    this.wakeAt = 0
    for (const f of this.preRoll) this.send(f)
    this.preRoll = []
    if (reason === 'wake') this.armWakeCheck()
    else this.wakeClip = null
    this.touch()
    this.publish()
  }

  /*
   * System context (date, name, workspace, pinned memories) is fetched ahead of
   * time and refreshed in the background, so a wake word doesn't wait on three
   * backend lookups before it can even start connecting.
   */
  private ctxCache: { text: string; at: number } | null = null
  private ctxLoading: Promise<string> | null = null
  private loadContext(): Promise<string> {
    if (!this.ctxLoading) {
      this.ctxLoading = this.d.tools
        .systemContext()
        .catch(() => '')
        .then((text) => {
          this.ctxCache = { text, at: Date.now() }
          return text
        })
        .finally(() => (this.ctxLoading = null))
    }
    return this.ctxLoading
  }
  /** Warm the context cache (called while waiting for the wake word). */
  prefetchContext() {
    if (!this.ctxCache || Date.now() - this.ctxCache.at > 60_000) void this.loadContext()
  }
  private async contextNow(): Promise<string> {
    const c = this.ctxCache
    if (c && Date.now() - c.at < 5 * 60_000) {
      if (Date.now() - c.at > 30_000) void this.loadContext()
      // The clock line must be current even when the rest is cached.
      return c.text.replace(/^Current date and time: [^\n]*/, `Current date and time: ${new Date().toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`)
    }
    return this.loadContext()
  }

  private async buildConfig(): Promise<LiveConnectConfig> {
    const cfg = this.d.getConfig()
    const ctx = await this.contextNow()
    const pace = cfg.speakingRate >= 1.25 ? ' Speak at a brisk pace.' : cfg.speakingRate <= 0.8 ? ' Speak slowly and clearly.' : ''
    const c: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
      systemInstruction: [
        'You are ZVYRA, a warm, sharp personal AI that lives on the user’s Windows PC and talks with them by voice.',
        'Keep spoken replies short and natural (one to three sentences) unless asked for detail. No markdown, lists or emojis — this is speech.',
        AGENT_GUIDE,
        'While a tool runs, you may say a few words like “On it.” Do quick things yourself with the tools. For big builds (a whole website, store, app or multi-file project) call run_task with the complete request — the builder agent does it in the background — then tell the user it’s underway.',
        'When you get web_search results, speak the key answer in one to three sentences; the sources show on screen. For camera look results, answer naturally from the description.',
        'When the user says goodbye or is clearly finished, say a short goodbye and call end_conversation.',
        pace,
        ctx
      ]
        .filter(Boolean)
        .join('\n'),
      tools: [{ functionDeclarations: TOOLS }]
    }
    if (!this.disabledFeatures.has('vad')) {
      c.realtimeInputConfig = {
        automaticActivityDetection: {
          silenceDurationMs: Math.min(3000, Math.max(300, cfg.silenceMs)),
          prefixPaddingMs: 150,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH
        },
        activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
      }
    }
    if (!this.disabledFeatures.has('resume')) c.sessionResumption = { handle: this.resumeHandle ?? undefined }
    if (!this.disabledFeatures.has('compression')) c.contextWindowCompression = { slidingWindow: {} }
    return c
  }

  private async openSession(key: string, attempt = 0): Promise<void> {
    const id = ++this.sessionId
    const ai = new GoogleGenAI({ apiKey: key })
    const config = await this.buildConfig()
    const model = this.d.getConfig().model
    let opened = false
    let setupDone = false
    let onSetup: (() => void) | null = null
    let closeReason = ''
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Gemini Live')), 15000)
      ai.live
        .connect({
          model,
          config,
          callbacks: {
            onopen: () => {
              opened = true
            },
            onmessage: (m) => {
              // The server confirms the config with setupComplete: that's the moment audio can flow.
              if (m.setupComplete && !setupDone) {
                setupDone = true
                onSetup?.()
              }
              if (id === this.sessionId) this.onMessage(m)
            },
            onerror: (e) => {
              closeReason = (e as { message?: string }).message ?? 'connection error'
            },
            onclose: (e) => {
              closeReason = closeReason || e.reason || `closed (${e.code})`
              if (!opened) return
              if (id === this.sessionId) this.onSessionClosed(closeReason, e.code)
            }
          }
        })
        .then(
          (s) => {
            clearTimeout(timer)
            if (id !== this.sessionId) {
              s.close()
              return resolve()
            }
            this.session = s
            // A config the model rejects closes the socket right away. Ready = setupComplete
            // (usually well under 400 ms); the old fixed 400 ms wait stays only as a fallback.
            const check = () => (this.session === s && opened ? resolve() : reject(new Error(closeReason || 'Gemini Live closed the session')))
            if (setupDone) return check()
            const fallback = setTimeout(check, 400)
            onSetup = () => {
              clearTimeout(fallback)
              check()
            }
          },
          (err) => {
            clearTimeout(timer)
            reject(err)
          }
        )
    }).catch(async (err) => {
      const msg = `${(err as Error)?.message ?? err} ${closeReason}`
      if (attempt < 3) {
        if (/resum|handle/i.test(msg) && this.resumeHandle) {
          this.resumeHandle = null
          return this.openSession(key, attempt + 1)
        }
        if (/realtime_input_config|activity|sensitivity|silence/i.test(msg) && !this.disabledFeatures.has('vad')) {
          this.disabledFeatures.add('vad')
          return this.openSession(key, attempt + 1)
        }
        if (/compression|sliding/i.test(msg) && !this.disabledFeatures.has('compression')) {
          this.disabledFeatures.add('compression')
          return this.openSession(key, attempt + 1)
        }
      }
      throw err
    })
  }

  private onSessionClosed(reason: string, code: number) {
    this.session = null
    if (this.phase === 'listening' || this.phase === 'speaking') {
      // Server-side limits (goAway / max duration) → resume transparently.
      if (code === 1000 && !this.endAfterTurn && this.resumeHandle) {
        const key = this.d.getKey()
        if (key) {
          void this.openSession(key).catch((err) => {
            this.fail(friendlyError(err))
            this.sleep('connection lost')
          })
          return
        }
      }
      if (code !== 1000) this.fail(`Gemini Live: ${reason}`)
      this.sleep('session closed')
    }
  }

  private onMessage(m: LiveServerMessage) {
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) this.resumeHandle = m.sessionResumptionUpdate.newHandle
    if (m.toolCall?.functionCalls?.length) void this.onToolCall(m.toolCall.functionCalls)
    const sc = m.serverContent
    if (!sc) return

    if (sc.interrupted) {
      this.cmd({ type: 'flush' })
      this.modelTurnActive = false
      this.setAwaiting(false)
      if (this.phase === 'speaking') this.phase = 'listening'
      this.finishInteraction('done')
      this.publish()
    }

    const userText = sc.inputTranscription?.text
    if (userText) {
      this.partial = (this.partial + userText).replace(/\s+/g, ' ')
      // Real words after a wake: it was a true wake (two or more words → learn this voice clip).
      if (this.wakeCheck) {
        const words = this.partial.trim().split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length
        if (words) this.confirmWake(words >= 2)
      }
      this.touch()
      this.d.emit('voice.transcript', { text: this.partial.trim(), final: false })
      this.upsertInteraction({ input: this.partial.trim() })
      if (isSleepPhrase(this.partial)) this.endAfterTurn = true
    }

    for (const p of sc.modelTurn?.parts ?? []) {
      const data = p.inlineData?.data
      if (!data) continue
      if (!this.modelTurnActive) {
        this.modelTurnActive = true
        this.lastTranscript = this.partial.trim() || this.lastTranscript
      }
      if (this.awaitingReply) this.setAwaiting(false)
      this.userSpeaking = false
      this.drained = false
      if (this.phase !== 'speaking' && !this.speakOnly) {
        this.phase = 'speaking'
        this.publish()
      }
      this.cmd({ type: 'play', pcm: Buffer.from(data, 'base64') })
      this.touch()
    }

    const botText = sc.outputTranscription?.text
    if (botText) {
      const cur = this.interaction?.response ?? ''
      this.upsertInteraction({ response: (cur + botText).replace(/\s+/g, ' '), status: 'streaming' })
    }

    if (sc.turnComplete) {
      this.d.logger.info('voice', 'turn complete', { heard: this.partial.trim().slice(0, 200), said: (this.interaction?.response ?? '').slice(0, 300) })
      this.modelTurnActive = false
      if (this.partial.trim()) {
        this.lastTranscript = this.partial.trim()
        this.d.emit('voice.transcript', { text: this.lastTranscript, final: true })
      }
      this.partial = ''
      this.finishInteraction('done')
      if (!this.toolsRunning) this.setAwaiting(false)
      if (this.drained && this.phase === 'speaking') this.phase = 'listening'
      if (this.endAfterTurn && this.drained) this.sleep('conversation ended')
      this.touch()
      this.publish()
    }
  }

  private async onToolCall(calls: { id?: string; name?: string; args?: Record<string, unknown> }[]) {
    const responses = []
    const session = this.sessionId
    this.toolsRunning++
    this.userSpeaking = false
    this.publish()
    try {
      for (const c of calls) {
        let response: Record<string, unknown>
        try {
          this.touch()
          if (c.name === 'end_conversation') {
            this.endAfterTurn = true
            response = { ok: true }
          } else {
            response = await runTool(this.d.tools.host, c.name ?? '', c.args ?? {})
            if (typeof response['taskId'] === 'string') this.upsertInteraction({ taskId: response['taskId'] })
          }
          this.d.logger.info('voice', `tool ${c.name}`, { ok: !response['error'], error: response['error'] as string | undefined })
          this.touch()
        } catch (err) {
          response = { error: err instanceof Error ? err.message : String(err) }
        }
        responses.push({ id: c.id, name: c.name, response })
      }
    } finally {
      // A conversation that ended meanwhile already reset the counter.
      if (session === this.sessionId && this.toolsRunning > 0) this.toolsRunning--
      // The model answers the tool result next: keep showing "processing" until it does.
      if (session === this.sessionId) {
        this.setAwaiting(true)
        this.publish()
      }
    }
    if (session !== this.sessionId) return
    try {
      this.session?.sendToolResponse({ functionResponses: responses })
    } catch (err) {
      this.d.logger.warn('voice', 'tool response failed', { message: String(err) })
    }
    if (this.endAfterTurn && this.drained && !this.modelTurnActive) setTimeout(() => this.drained && this.sleep('conversation ended'), 1500)
  }

  /* ================================================================ interactions */

  private upsertInteraction(patch: Partial<Interaction>) {
    const now = new Date().toISOString()
    if (!this.interaction) this.interaction = { id: randomUUID(), source: 'voice', input: '', status: 'streaming', createdAt: now, updatedAt: now }
    this.interaction = { ...this.interaction, ...patch, updatedAt: now }
    this.d.emit('assistant.interaction', this.interaction)
  }

  private finishInteraction(status: Interaction['status']) {
    if (!this.interaction) return
    const i = { ...this.interaction, status, updatedAt: new Date().toISOString() }
    this.interaction = null
    if (i.input || i.response) {
      this.d.emit('assistant.interaction', i)
      this.d.onInteraction?.(i)
    }
  }

  /* ================================================================ idle / sleep */

  private touch() {
    this.lastActivity = Date.now()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    // Stay awake: the conversation (and the island) stays active until "go to sleep" or the stop button.
    if (this.d.getConfig().stayAwake) return
    const ms = Math.max(5, this.d.getConfig().idleTimeoutSec) * 1000
    this.idleTimer = setTimeout(() => {
      if (this.phase === 'listening' && !this.modelTurnActive && Date.now() - this.lastActivity >= ms - 50) this.sleep('idle')
      else if (this.phase === 'listening' || this.phase === 'speaking') this.touch()
    }, ms)
  }

  private endSession(_why: string) {
    this.sessionId++
    const s = this.session
    this.session = null
    try {
      s?.close()
    } catch {
      /* ignore */
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.wakeCheck) clearTimeout(this.wakeCheck.timer)
    this.wakeCheck = null
    this.modelTurnActive = false
    this.resetLive()
    this.finishInteraction('done')
  }

  sleep(why: string) {
    this.d.logger.info('voice', 'sleep', { why })
    const wasActive = this.phase === 'listening' || this.phase === 'speaking' || this.phase === 'connecting'
    this.endSession(why)
    this.partial = ''
    this.endAfterTurn = false
    const cfg = this.d.getConfig()
    this.phase = cfg.wakeEnabled ? 'standby' : 'off'
    this.spotter?.reset()
    if (this.phase === 'standby') this.prefetchContext()
    if (this.phase === 'off') this.stopCapture()
    if (wasActive && why !== 'cancel' && why !== 'false-wake') this.cmd({ type: 'chime', kind: 'sleep' })
    this.wakeRing = []
    this.d.emit('voice.level', { level: 0 })
    this.publish()
  }

  cancel() {
    this.cmd({ type: 'flush' })
    this.sleep('cancel')
  }

  stopSpeaking() {
    this.cmd({ type: 'flush' })
    if (this.phase === 'speaking') {
      this.phase = 'listening'
      this.modelTurnActive = false
      this.touch()
      this.publish()
    }
  }

  /* ================================================================ one-shot speech */

  /** Speaks arbitrary text in the configured Gemini voice (notifications, tests). */
  async speak(text: string) {
    const key = this.d.getKey()
    if (!key) throw new Error('Add a Gemini API key in Settings → Voice')
    if (this.session) {
      this.session.sendRealtimeInput({ text: `Say this to the user, word for word: ${text}` })
      return
    }
    this.ensureWindow()
    const cfg = this.d.getConfig()
    const ai = new GoogleGenAI({ apiKey: key })
    const prev = this.phase
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session?.close()
        reject(new Error('Timed out'))
      }, 30000)
      let session: Session | undefined
      const done = () => {
        clearTimeout(timer)
        session?.close()
        if (this.phase === 'speaking' && prev !== 'speaking') this.phase = prev
        this.publish()
        resolve()
      }
      ai.live
        .connect({
          model: cfg.model,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
            systemInstruction: 'Read the user’s message aloud exactly as written, with natural expression. Do not add anything.'
          },
          callbacks: {
            onmessage: (m) => {
              for (const p of m.serverContent?.modelTurn?.parts ?? []) {
                if (p.inlineData?.data) {
                  if (this.phase !== 'speaking') {
                    this.phase = 'speaking'
                    this.publish()
                  }
                  this.drained = false
                  this.cmd({ type: 'play', pcm: Buffer.from(p.inlineData.data, 'base64') })
                }
              }
              if (m.serverContent?.turnComplete) {
                if (this.drained) done()
                else this.speakOnly = { resolve: done }
              }
            },
            onerror: (e) => reject(new Error((e as { message?: string }).message ?? 'error')),
            onclose: () => undefined
          }
        })
        .then((s) => {
          session = s
          s.sendRealtimeInput({ text })
        }, reject)
    })
  }

  /* ================================================================ catalogue */

  async listModels(refresh = false): Promise<LiveModel[]> {
    if (!refresh && this.models.length && Date.now() - this.modelsAt < 3600_000) return this.models
    const key = this.d.getKey()
    if (!key) return [{ id: this.d.getConfig().model, label: this.d.getConfig().model }]
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) })
    const json = (await r.json()) as { models?: { name: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }[]; error?: { message?: string } }
    if (!r.ok) throw new Error(json.error?.message ?? `HTTP ${r.status}`)
    this.models = pickConversationalLiveModels(json.models ?? [])
    this.modelsAt = Date.now()
    return this.models
  }

  testWake(): { ok: boolean; message: string } {
    try {
      this.spotterFor(this.d.getConfig())
      return { ok: true, message: 'Wake word model loaded. Say “Hey Zvyra” with listening on to try it.' }
    } catch (err) {
      return { ok: false, message: `Wake word model failed to load: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  devicesList(): MicDevice[] {
    if (!this.devices.length) {
      this.ensureWindow()
      this.cmd({ type: 'enumerate' })
    }
    return this.devices.length ? this.devices : [{ id: '', label: 'Windows default microphone', isDefault: true }]
  }

  async engines(): Promise<VoiceEngineOption[]> {
    const cfg = this.d.getConfig()
    const models = await this.listModels().catch(() => [{ id: cfg.model, label: cfg.model }])
    const ids = models.some((m) => m.id === cfg.model) ? models : [{ id: cfg.model, label: cfg.model }, ...models]
    return [
      {
        id: 'zvyra-kws',
        kind: 'wake',
        name: 'ZVYRA wake word',
        processing: 'local',
        description: 'Listens for “Hey Zvyra” entirely on this PC with a small neural keyword spotter. No audio leaves your computer until it hears the wake word.',
        installed: true,
        fields: []
      },
      {
        id: 'gemini-live',
        kind: 'stt',
        name: 'Gemini Live',
        processing: 'external',
        description: 'Real-time spoken conversation with Google Gemini: natural voice, interruptions, live transcripts and the ability to start ZVYRA tasks. Audio is streamed to Google only while a conversation is active.',
        installed: true,
        fields: [
          { key: 'apiKey', label: 'Gemini API key', type: 'secret', required: true, hasValue: !!this.d.getKey(), help: 'From aistudio.google.com/apikey. Stored encrypted on this PC.' },
          { key: 'model', label: 'Live model', type: 'select', value: cfg.model, options: ids.map((m) => ({ value: m.id, label: m.label })) },
          { key: 'voice', label: 'Voice', type: 'select', value: cfg.voice, options: GEMINI_VOICES.map((v) => ({ value: v.name, label: `${v.name} — ${v.style}` })) }
        ]
      }
    ]
  }

  /** Verifies the key/model/voice by opening a session and speaking a short line. */
  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const t0 = Date.now()
      await this.speak('Hi, I’m ZVYRA. My voice is ready.')
      return { ok: true, message: `Gemini Live answered in ${((Date.now() - t0) / 1000).toFixed(1)} s with the ${this.d.getConfig().voice} voice.` }
    } catch (err) {
      return { ok: false, message: friendlyError(err) }
    }
  }

  /** Dev/QA only: plays a 16 kHz mono PCM16 WAV into the pipeline in real time, as if spoken into the mic. */
  async injectWav(pcm: Uint8Array) {
    const frame = 3200 // 100 ms
    const silence = new Uint8Array(frame)
    this.injecting = true
    this.d.logger.info('voice', 'QA: injecting test audio', { seconds: +(pcm.byteLength / 32000).toFixed(1), phase: this.phase })
    const feed = async (f: Uint8Array) => {
      this.onAudio(f, true)
      await new Promise((r) => setTimeout(r, 100))
    }
    for (let i = 0; i < 5; i++) await feed(silence)
    for (let i = 0; i < pcm.byteLength; i += frame) await feed(pcm.subarray(i, Math.min(pcm.byteLength, i + frame)))
    for (let i = 0; i < 40; i++) await feed(silence)
    this.injecting = false
  }
  private injecting = false

  dispose() {
    this.endSession('quit')
    this.stopCapture()
    this.win?.destroy()
    this.win = null
  }
}

export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/API key not valid|API_KEY_INVALID|permission denied|1007|401|403/i.test(msg)) return 'Gemini rejected the API key. Check it in Settings → Voice.'
  if (/quota|429|exhausted/i.test(msg)) return 'Gemini quota reached. Try again later or use another key.'
  if (/not found|404|unsupported model|is not supported/i.test(msg)) return 'That Gemini Live model isn’t available for this key. Pick another model in Settings → Voice.'
  if (/ENOTFOUND|ECONN|network|fetch failed|timed out/i.test(msg)) return 'Couldn’t reach Gemini — check your internet connection.'
  return `Gemini Live: ${msg}`
}

export { DEFAULT_LIVE_MODEL, DEFAULT_VOICE }
