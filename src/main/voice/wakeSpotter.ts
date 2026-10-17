/**
 * OWNER: Kiro. Local, offline "Hey Zvyra" wake-word spotter built on
 * sherpa-onnx open-vocabulary keyword spotting (zipformer, int8, ~5 MB).
 * Audio never leaves the PC in this stage.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { buildKeywords, WAKE_LABEL, WAKE_LABEL_LOOSE } from './keywords'

interface OnlineStream {
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void
}
interface KeywordSpotter {
  createStream(): OnlineStream
  isReady(s: OnlineStream): boolean
  decode(s: OnlineStream): void
  reset(s: OnlineStream): void
  getResult(s: OnlineStream): { keyword: string }
}

export interface WakeSpotterOptions {
  modelDir: string
  workDir: string
  sensitivity: number
}

const MODEL = {
  encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'
}

export class WakeSpotter {
  private spotter: KeywordSpotter
  private stream: OnlineStream
  private cooldownUntil = 0

  constructor(opts: WakeSpotterOptions) {
    const req = createRequire(__filename)
    const sherpa = req('sherpa-onnx-node') as { KeywordSpotter: new (c: unknown) => KeywordSpotter }
    mkdirSync(opts.workDir, { recursive: true })
    const keywordsFile = join(opts.workDir, 'wake-keywords.txt')
    writeFileSync(keywordsFile, buildKeywords(opts.sensitivity), 'utf8')
    this.spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(opts.modelDir, MODEL.encoder),
          decoder: join(opts.modelDir, MODEL.decoder),
          joiner: join(opts.modelDir, MODEL.joiner)
        },
        tokens: join(opts.modelDir, 'tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: 0
      },
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 1.0,
      keywordsThreshold: 0.25,
      keywordsFile
    })
    this.stream = this.spotter.createStream()
  }

  /**
   * Feed 16 kHz mono float samples in [-1, 1]. Returns which kind of variant
   * fired ('core' = the real "Zvyra" sound, 'loose' = an accent look-alike), or null.
   */
  feed(samples: Float32Array, now = Date.now()): 'core' | 'loose' | null {
    this.stream.acceptWaveform({ samples, sampleRate: 16000 })
    let fired: 'core' | 'loose' | null = null
    while (this.spotter.isReady(this.stream)) {
      this.spotter.decode(this.stream)
      const r = this.spotter.getResult(this.stream)
      if (r.keyword) {
        this.spotter.reset(this.stream)
        if (now < this.cooldownUntil) continue
        if (r.keyword.includes(WAKE_LABEL_LOOSE)) fired = fired ?? 'loose'
        else if (r.keyword.includes(WAKE_LABEL)) fired = 'core'
        if (fired) this.cooldownUntil = now + 1500
      }
    }
    return fired
  }

  /** Clears buffered audio (e.g. after a conversation ends). */
  reset() {
    this.stream = this.spotter.createStream()
  }
}

export function concatFrames(list: Float32Array[]): Float32Array {
  const out = new Float32Array(list.reduce((n, f) => n + f.length, 0))
  let o = 0
  for (const f of list) {
    out.set(f, o)
    o += f.length
  }
  return out
}

const frameRms = (f: Float32Array) => {
  let s = 0
  for (let i = 0; i < f.length; i++) s += f[i] * f[i]
  return Math.sqrt(s / Math.max(1, f.length))
}

/**
 * True when the phrase at the end of `frames` (100 ms each) was preceded by a
 * pause: the quietest early frames are clearly quieter than the phrase itself.
 * Wake words are said after a pause; look-alike words inside a sentence are not.
 */
export function startsAfterPause(frames: Float32Array[]): boolean {
  if (frames.length < 10) return true
  const levels = frames.map(frameRms)
  const head = levels.slice(0, Math.min(6, levels.length - 6)).sort((a, b) => a - b)
  const quiet = head[Math.floor(head.length / 2)] ?? 0
  const peak = Math.max(...levels.slice(-10))
  return quiet < Math.max(0.01, peak * 0.3)
}

/** PCM16 little-endian → float32 */
export function pcm16ToFloat(buf: Uint8Array): Float32Array {
  const n = Math.floor(buf.byteLength / 2)
  const view = new DataView(buf.buffer, buf.byteOffset, n * 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}
