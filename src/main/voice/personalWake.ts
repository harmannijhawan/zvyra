/**
 * OWNER: Kiro. Personal wake word: matches the user's own “Hey Zvyra” recordings
 * (MFCC features + dynamic time warping), fully on-device.
 *
 * The bundled English keyword model can't hear “Zvyra” in many accents (it
 * decodes real recordings as “his vitamin”, “Israel”…), so the engine runs this
 * alongside it. Templates are 16 kHz mono WAVs in <workDir>/wake-templates.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const N = 512
const WIN = 400 // 25 ms
const HOP = 160 // 10 ms
const MELS = 26
const CEPS = 12

const hamming = Float32Array.from({ length: WIN }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WIN - 1)))
const mel = (f: number) => 2595 * Math.log10(1 + f / 700)
const imel = (m: number) => 700 * (10 ** (m / 2595) - 1)
const BINS = Array.from({ length: MELS + 2 }, (_, i) => Math.floor(((N + 1) * imel(mel(80) + ((mel(7600) - mel(80)) * i) / (MELS + 1))) / 16000))
const COS: Float32Array[] = []
const SIN: Float32Array[] = []
for (let k = 0; k <= N / 2; k++) {
  COS.push(Float32Array.from({ length: WIN }, (_, i) => Math.cos((2 * Math.PI * k * i) / N)))
  SIN.push(Float32Array.from({ length: WIN }, (_, i) => Math.sin((2 * Math.PI * k * i) / N)))
}
const DCT = Array.from({ length: CEPS }, (_, j) => Float32Array.from({ length: MELS }, (_, m) => Math.cos((Math.PI * (j + 1) * (m + 0.5)) / MELS)))

type Feat = Float32Array[]

function features(x: Float32Array): Feat {
  const frames: Float32Array[] = []
  const energies: number[] = []
  const fr = new Float32Array(WIN)
  const pow = new Float32Array(N / 2 + 1)
  const lm = new Float32Array(MELS)
  for (let s = 0; s + WIN <= x.length; s += HOP) {
    let e = 0
    for (let i = 0; i < WIN; i++) {
      const v = x[s + i]
      e += v * v
      fr[i] = (v - (i ? 0.97 * x[s + i - 1] : 0)) * hamming[i]
    }
    for (let k = 0; k <= N / 2; k++) {
      let re = 0
      let im = 0
      const c = COS[k]
      const sn = SIN[k]
      for (let i = 0; i < WIN; i++) {
        re += fr[i] * c[i]
        im -= fr[i] * sn[i]
      }
      pow[k] = re * re + im * im
    }
    for (let m = 1; m <= MELS; m++) {
      let acc = 0
      const a = BINS[m - 1]
      const b = BINS[m]
      const c = BINS[m + 1]
      for (let k = a; k < c; k++) acc += (k < b ? (k - a) / Math.max(1, b - a) : (c - k) / Math.max(1, c - b)) * pow[k]
      lm[m - 1] = Math.log(acc + 1e-10)
    }
    const cep = new Float32Array(CEPS)
    for (let j = 0; j < CEPS; j++) {
      let acc = 0
      const d = DCT[j]
      for (let m = 0; m < MELS; m++) acc += lm[m] * d[m]
      cep[j] = acc
    }
    frames.push(cep)
    energies.push(e / WIN)
  }
  // Keep the voiced span (above the clip's own noise floor), then remove the channel (mean) so mics/rooms matter less.
  const sorted = [...energies].sort((a, b) => a - b)
  if (!sorted.length) return []
  const floor = sorted[Math.floor(sorted.length * 0.2)] + 1e-9
  const on = energies.map((e) => e > Math.max(floor * 10, sorted[sorted.length - 1] * 0.003))
  let a = on.indexOf(true)
  let b = on.lastIndexOf(true)
  if (a < 0) return []
  a = Math.max(0, a - 3)
  b = Math.min(frames.length - 1, b + 3)
  const f = frames.slice(a, b + 1)
  const mean = new Float32Array(CEPS)
  for (const v of f) for (let j = 0; j < CEPS; j++) mean[j] += v[j] / f.length
  return f.map((v) => v.map((x, j) => x - mean[j]))
}

function dtw(a: Feat, b: Feat): number {
  const n = a.length
  const m = b.length
  if (!n || !m) return Infinity
  const band = Math.max(Math.abs(n - m), Math.ceil(Math.max(n, m) * 0.3))
  let prev = new Float64Array(m + 1).fill(Infinity)
  let cur = new Float64Array(m + 1)
  prev[0] = 0
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity)
    const mid = Math.round((i * m) / n)
    const lo = Math.max(1, mid - band)
    const hi = Math.min(m, mid + band)
    const ai = a[i - 1]
    for (let j = lo; j <= hi; j++) {
      const bj = b[j - 1]
      let d = 0
      for (let k = 0; k < CEPS; k++) {
        const t = ai[k] - bj[k]
        d += t * t
      }
      cur[j] = Math.sqrt(d) + Math.min(prev[j], cur[j - 1], prev[j - 1])
    }
    const t = prev
    prev = cur
    cur = t
  }
  return prev[m] / (n + m)
}

export function readWav16k(file: string): Float32Array | null {
  const b = readFileSync(file)
  let off = 12
  let rate = 16000
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
    if (id === 'data') {
      if (rate !== 16000) return null
      const n = Math.floor(Math.min(size, b.length - off - 8) / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768
      return out
    }
    off += 8 + size + (size % 2)
  }
  return null
}

export function wavHeader(dataBytes: number, rate = 16000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

export interface WakeMatch {
  score: number
  fired: boolean
}

export class PersonalWake {
  private templates: Feat[] = []
  private medianLen = 0

  constructor(
    private readonly dir: string,
    /** Lower = stricter. ~10 separates the user's own samples from other phrases. */
    private threshold = 10.2,
    /** Which WAV files count as templates (default: all). */
    private readonly accept: (file: string) => boolean = () => true
  ) {
    this.reload()
  }

  get count() {
    return this.templates.length
  }

  setThreshold(t: number) {
    this.threshold = t
  }

  reload() {
    this.templates = []
    if (!existsSync(this.dir)) return
    for (const f of readdirSync(this.dir).filter((x) => x.toLowerCase().endsWith('.wav') && this.accept(x)).sort()) {
      try {
        const x = readWav16k(join(this.dir, f))
        const feat = x ? features(x) : []
        if (feat.length >= 25 && feat.length <= 300) this.templates.push(feat)
      } catch {
        /* skip unreadable sample */
      }
    }
    const lens = this.templates.map((t) => t.length).sort((a, b) => a - b)
    this.medianLen = lens[Math.floor(lens.length / 2)] ?? 0
    // How far the user's own samples are from each other (leave-one-out, best two): the natural
    // variation of their "Hey Zvyra". Distances depend on mic and room, so limits scale with it.
    this.spread = 0
    if (this.templates.length >= 3) {
      const own = this.templates.map((t, i) => {
        const d = this.templates.filter((_, j) => j !== i).map((o) => dtw(t, o)).sort((a, b) => a - b)
        return (d[0] + d[1]) / 2
      })
      this.spread = Math.max(...own)
    }
  }

  private spread = 0

  /**
   * Distance limit calibrated on the user's own samples (0 when there are fewer
   * than three). Sensitivity 0.6 allows ~14% more variation than the samples show.
   */
  calibratedLimit(sensitivity: number): number {
    if (!this.spread) return 0
    const s = Math.min(0.95, Math.max(0.05, sensitivity))
    return Math.min(12, Math.max(4, this.spread * (1.05 + s * 0.15)))
  }

  get limit() {
    return this.threshold
  }

  /**
   * Distance from a clip (16 kHz floats) to the closest samples (average of the
   * best two, or the best one when only one exists). Infinity = no usable data.
   */
  nearest(clip: Float32Array): number {
    if (!this.templates.length) return Infinity
    const feat = features(clip)
    if (feat.length < 15 || feat.length > 320) return Infinity
    const d = this.templates.map((t) => dtw(feat, t)).sort((a, b) => a - b)
    return d.length > 1 ? (d[0] + d[1]) / 2 : d[0]
  }

  /** Compare one spoken segment (16 kHz floats) against the user's samples. */
  match(segment: Float32Array): WakeMatch {
    if (this.templates.length < 3) return { score: Infinity, fired: false }
    const feat = features(segment)
    // Wake phrases are short: skip long sentences and clicks quickly.
    if (feat.length < 20 || feat.length > Math.max(160, this.medianLen * 2.2)) return { score: Infinity, fired: false }
    const d = this.templates.map((t) => dtw(feat, t)).sort((a, b) => a - b)
    const score = (d[0] + d[1]) / 2
    return { score, fired: score <= this.threshold }
  }
}

/**
 * Energy-based segmenter for the standby stream: emits each burst of speech
 * (with a little lead-in) once it ends, capped at ~3 s.
 */
export class SpeechSegmenter {
  private frames: Float32Array[] = []
  private lead: Float32Array[] = []
  private floor = 0.004
  private voiced = 0
  private quiet = 0

  push(frame: Float32Array, rms: number): Float32Array | null {
    if (!this.frames.length) this.floor = this.floor * 0.95 + Math.min(rms, 0.05) * 0.05
    const loud = rms > Math.max(0.012, this.floor * 3.5)
    if (this.frames.length) {
      this.frames.push(frame)
      if (loud) {
        this.voiced++
        this.quiet = 0
      } else this.quiet++
      if (this.quiet >= 3 || this.frames.length >= 30) {
        const done = this.voiced >= 2 && this.frames.length < 30 ? concat(this.frames) : null
        this.frames = []
        this.voiced = this.quiet = 0
        return done
      }
      return null
    }
    if (loud) {
      this.frames = [...this.lead, frame]
      this.voiced = 1
      this.quiet = 0
      this.lead = []
    } else {
      this.lead.push(frame)
      if (this.lead.length > 2) this.lead.shift()
    }
    return null
  }

  reset() {
    this.frames = []
    this.lead = []
    this.voiced = this.quiet = 0
  }
}

function concat(list: Float32Array[]) {
  const out = new Float32Array(list.reduce((n, f) => n + f.length, 0))
  let o = 0
  for (const f of list) {
    out.set(f, o)
    o += f.length
  }
  return out
}
