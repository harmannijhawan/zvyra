/**
 * Wake-word pipeline on real audio: Windows speech synthesis renders the clips,
 * the real on-device keyword spotter (resources/kws) listens in 100 ms frames
 * exactly like the live mic, and the same gate as the app decides.
 *
 * Synthetic voices are not the user's voice. To evaluate the user's own
 * recordings, set ZVYRA_WAKE_DIR to the app's `desktop/voice` folder
 * (leave-one-out over wake-templates/sample-*.wav vs wake-negatives).
 * Skipped where Windows speech is unavailable.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readWav16k } from '../../src/main/voice/personalWake'
import { WakeGate } from '../../src/main/voice/wakeGate'
import { startsAfterPause, WakeSpotter } from '../../src/main/voice/wakeSpotter'

const DIR = join(tmpdir(), `zvyra-wake-audio-${process.pid}`)
const MODEL = resolve(__dirname, '../../resources/kws')

const CLIPS: Record<string, string> = {
  wake: '<break time="1200ms"/>Hey Zyra.<break time="1500ms"/>',
  wakeTwice: '<break time="1200ms"/>Hey Zyra. Hey Zyra.<break time="1500ms"/>',
  midSentence: 'and then I told him hey zyra can you believe it was so funny',
  conversation: 'Did you finish the report for the client yesterday? I think we should call them tomorrow morning before the meeting.',
  television: 'Good evening. Tonight markets fell sharply as investors reacted to new figures on inflation and interest rates across Europe.',
  nameOnly: 'Zyra is a lovely name for a company, she said.',
  lookAlike: '<break time="1200ms"/>Hey Vera, come here.<break time="1200ms"/>'
}

let available = process.platform === 'win32' && existsSync(join(MODEL, 'tokens.txt'))

beforeAll(() => {
  if (!available) return
  mkdirSync(DIR, { recursive: true })
  // Clip list goes through a JSON file so no text is spliced into the script.
  writeFileSync(join(DIR, 'clips.json'), JSON.stringify(Object.entries(CLIPS).map(([name, ssml]) => ({ file: join(DIR, `${name}.wav`), ssml }))))
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `foreach ($c in (Get-Content -Raw '${join(DIR, 'clips.json')}' | ConvertFrom-Json)) { $s.SetOutputToWaveFile($c.file, $fmt); $s.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' + $c.ssml + '</speak>') }`,
    '$s.SetOutputToNull()'
  ].join('\n')
  writeFileSync(join(DIR, 'make.ps1'), script)
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(DIR, 'make.ps1')], { timeout: 60_000, windowsHide: true })
    available = Object.keys(CLIPS).every((k) => existsSync(join(DIR, `${k}.wav`)))
  } catch {
    available = false
  }
}, 90_000)

afterAll(() => rmSync(DIR, { recursive: true, force: true }))

/** Streams a clip through spotter + gate like VoiceEngine.onAudio (standby). Returns the decisions made. */
function listen(name: string, opts: { enabled?: boolean; sensitivity?: number } = {}) {
  const sensitivity = opts.sensitivity ?? 0.6
  const spotter = new WakeSpotter({ modelDir: MODEL, workDir: join(DIR, `kw-${name}-${sensitivity}`), sensitivity })
  const gate = new WakeGate()
  const audio = readWav16k(join(DIR, `${name}.wav`))!
  const ring: Float32Array[] = []
  const decisions: { wake: boolean; reason: string }[] = []
  let now = 1_000_000
  const feed = (frame: Float32Array) => {
    ring.push(frame)
    if (ring.length > 18) ring.shift()
    const hit = spotter.feed(frame, now)
    if (hit) {
      const d = gate.decide(
        { source: 'kws', kind: hit, personalScore: Infinity, negativeScore: Infinity, templates: 0, pauseBefore: startsAfterPause(ring), echo: false, now },
        { enabled: opts.enabled ?? true, sensitivity }
      )
      decisions.push(d)
      if (d.wake) gate.hold(now)
    }
    now += 100
  }
  for (let i = 0; i < audio.length; i += 1600) feed(audio.subarray(i, Math.min(audio.length, i + 1600)))
  for (let i = 0; i < 10; i++) feed(new Float32Array(1600))
  return decisions
}

const wakes = (d: { wake: boolean }[]) => d.filter((x) => x.wake).length

describe.skipIf(process.platform !== 'win32')('wake word on real audio (Windows speech + on-device spotter)', () => {
  it('wakes once on "Hey Zyra" said after a pause', ({ skip }) => {
    if (!available) skip()
    expect(wakes(listen('wake'))).toBe(1)
  })
  it('wakes only once for a repeated wake phrase', ({ skip }) => {
    if (!available) skip()
    expect(wakes(listen('wakeTwice'))).toBe(1)
  })
  it('stays silent when the phrase is buried in a sentence to someone else', ({ skip }) => {
    if (!available) skip()
    expect(wakes(listen('midSentence'))).toBe(0)
  })
  it.for(['conversation', 'television', 'nameOnly', 'lookAlike'])('stays silent for %s', (name, { skip }) => {
    if (!available) skip()
    expect(wakes(listen(name))).toBe(0)
    expect(wakes(listen(name, { sensitivity: 0.8 }))).toBe(0)
  })
  it('never wakes with wake-word mode disabled', ({ skip }) => {
    if (!available) skip()
    expect(wakes(listen('wake', { enabled: false }))).toBe(0)
  })
})

/** Opt-in: the user's own recorded samples (never committed). */
describe.skipIf(!process.env['ZVYRA_WAKE_DIR'])('wake word on the user’s own recordings', () => {
  const root = process.env['ZVYRA_WAKE_DIR'] ?? ''
  it('accepts each recorded sample against the others and rejects past false wakes', async () => {
    const { readdirSync, copyFileSync } = await import('node:fs')
    const { PersonalWake } = await import('../../src/main/voice/personalWake')
    const { personalLimit } = await import('../../src/main/voice/wakeGate')
    const tdir = join(root, 'wake-templates')
    const samples = readdirSync(tdir).filter((f) => /^sample-.*\.wav$/i.test(f))
    const negDir = join(root, 'wake-negatives')
    const negs = existsSync(negDir) ? readdirSync(negDir).filter((f) => f.endsWith('.wav')) : []
    const limit = personalLimit(0.6)
    let accepted = 0
    for (const held of samples) {
      const tmp = join(DIR, `loo-${held}`)
      mkdirSync(tmp, { recursive: true })
      for (const s of samples) if (s !== held) copyFileSync(join(tdir, s), join(tmp, s))
      const pw = new PersonalWake(tmp, limit)
      const clip = readWav16k(join(tdir, held))!
      const d = new WakeGate().decide(
        { source: 'personal', personalScore: pw.match(clip).score, negativeScore: Infinity, templates: pw.count, pauseBefore: true, echo: false, segmentSec: clip.length / 16000, limit: pw.calibratedLimit(0.6), now: 1 },
        { enabled: true, sensitivity: 0.6 }
      )
      if (d.wake) accepted++
      console.log(`sample ${held}: score ${pw.match(clip).score.toFixed(2)} → ${d.reason}`)
    }
    const pw = new PersonalWake(tdir, limit, (f) => !f.startsWith('auto-'))
    console.log(`calibrated limit ${pw.calibratedLimit(0.6).toFixed(2)}`)
    // Each past false wake is judged with the *other* false wakes as the negative set
    // (in the app the clip itself would be in that set and match trivially).
    let falseAccepts = 0
    for (const n of negs) {
      const clip = readWav16k(join(negDir, n))
      if (!clip) continue
      const ndir = join(DIR, `neg-loo-${n}`)
      mkdirSync(ndir, { recursive: true })
      for (const o of negs) if (o !== n) copyFileSync(join(negDir, o), join(ndir, o))
      const neg = new PersonalWake(ndir).nearest(clip)
      const d = new WakeGate().decide(
        { source: 'personal', personalScore: pw.match(clip).score, negativeScore: neg, templates: pw.count, pauseBefore: true, echo: false, segmentSec: clip.length / 16000, limit: pw.calibratedLimit(0.6), now: 1 },
        { enabled: true, sensitivity: 0.6 }
      )
      if (d.wake) falseAccepts++
      console.log(`negative ${n}: score ${pw.match(clip).score.toFixed(2)}, nearest other false wake ${neg.toFixed(2)} → ${d.reason}`)
    }
    console.log(`user samples accepted ${accepted}/${samples.length}; past false wakes accepted ${falseAccepts}/${negs.length}`)
    // Report, not a pass/fail on false wakes: these clips are unlabelled (a "false wake" may have been
    // the user saying the phrase and then staying quiet), and template matching cannot separate them all.
    expect(accepted / Math.max(1, samples.length)).toBeGreaterThanOrEqual(0.8)
    expect(falseAccepts).toBeLessThan(Math.max(1, negs.length))
  })
})
