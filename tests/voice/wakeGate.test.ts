import { describe, expect, it } from 'vitest'
import { personalLimit, WakeGate, type WakeEvidence } from '../../src/main/voice/wakeGate'

const cfg = { enabled: true, sensitivity: 0.6 }
const limit = personalLimit(cfg.sensitivity)
const base = (over: Partial<WakeEvidence> = {}): WakeEvidence => ({
  source: 'kws',
  kind: 'core',
  personalScore: Infinity,
  negativeScore: Infinity,
  templates: 0,
  pauseBefore: true,
  echo: false,
  now: 1_000_000,
  ...over
})

describe('wake gate: true wakes (false negatives)', () => {
  it('wakes on the core phrase said after a pause, without voice samples', () => {
    expect(new WakeGate().decide(base(), cfg).wake).toBe(true)
  })
  it('wakes when the spotter and the user’s voice samples agree', () => {
    const d = new WakeGate().decide(base({ templates: 5, personalScore: limit * 0.9 }), cfg)
    expect(d.wake).toBe(true)
    expect(d.confidence).toBeGreaterThan(0.7)
  })
  it('wakes on a personal-template match of a short isolated phrase', () => {
    expect(new WakeGate().decide(base({ source: 'personal', kind: undefined, templates: 5, personalScore: limit * 0.8, segmentSec: 1.1 }), cfg).wake).toBe(true)
  })
})

describe('wake gate: background conversation and TV (false positives)', () => {
  it('ignores the wake phrase in the middle of continuous speech', () => {
    expect(new WakeGate().decide(base({ pauseBefore: false }), cfg)).toMatchObject({ wake: false, reason: expect.stringMatching(/middle of speech/) })
  })
  it('ignores accent look-alikes ("his veera") at normal sensitivity', () => {
    expect(new WakeGate().decide(base({ kind: 'loose' }), cfg).wake).toBe(false)
  })
  it('ignores look-alikes inside a sentence even at high sensitivity', () => {
    expect(new WakeGate().decide(base({ kind: 'loose', pauseBefore: false }), { enabled: true, sensitivity: 0.95 }).wake).toBe(false)
  })
  it('ignores another voice when the user has recorded samples', () => {
    expect(new WakeGate().decide(base({ templates: 5, personalScore: limit * 1.6 }), cfg)).toMatchObject({ wake: false, reason: expect.stringMatching(/sound like/) })
  })
  it('ignores clips that match a previous false wake (e.g. a TV jingle)', () => {
    expect(new WakeGate().decide(base({ templates: 5, personalScore: limit * 0.95, negativeScore: limit * 0.7 }), cfg)).toMatchObject({ wake: false, reason: expect.stringMatching(/false wake/) })
  })
  it('never wakes from a template match of a long sentence', () => {
    expect(new WakeGate().decide(base({ source: 'personal', templates: 5, personalScore: limit * 0.5, segmentSec: 2.9 }), cfg).wake).toBe(false)
  })
  it('personal-only matches are stricter than spotter-confirmed matches', () => {
    const score = limit * 1.0
    expect(new WakeGate().decide(base({ source: 'personal', templates: 5, personalScore: score, segmentSec: 1 }), cfg).wake).toBe(false)
    expect(new WakeGate().decide(base({ templates: 5, personalScore: score }), cfg).wake).toBe(true)
  })
  it('becomes stricter after repeated false wakes (noisy room / TV)', () => {
    const g = new WakeGate()
    g.noteFalseWake(990_000)
    g.noteFalseWake(995_000)
    expect(g.noisy(1_000_000)).toBe(true)
    // Without voice samples a noisy room needs them before waking again.
    expect(g.decide(base(), cfg).wake).toBe(false)
    // A clear match with the user's samples still works.
    expect(g.decide(base({ templates: 5, personalScore: limit * 0.8 }), cfg).wake).toBe(true)
    // The noisy state expires.
    expect(g.noisy(1_000_000 + 6 * 60_000)).toBe(false)
  })
  it('never wakes from ZVYRA’s own voice', () => {
    expect(new WakeGate().decide(base({ echo: true, templates: 5, personalScore: 1 }), cfg).wake).toBe(false)
  })
})

describe('wake gate: repeats, interruptions and the off switch', () => {
  it('debounces a repeated "Hey Zvyra, hey Zvyra"', () => {
    const g = new WakeGate()
    expect(g.decide(base(), cfg).wake).toBe(true)
    g.hold(1_000_000)
    expect(g.decide(base({ now: 1_001_000 }), cfg)).toMatchObject({ wake: false, reason: expect.stringMatching(/cooldown/) })
    expect(g.decide(base({ now: 1_003_000 }), cfg).wake).toBe(true)
  })
  it('holds after a conversation ends so the goodbye cannot re-wake', () => {
    const g = new WakeGate()
    g.hold(1_000_000, 2500)
    expect(g.decide(base({ now: 1_002_000 }), cfg).wake).toBe(false)
  })
  it('interrupted speech that never finished the phrase (no pause, look-alike) stays silent', () => {
    expect(new WakeGate().decide(base({ kind: 'loose', pauseBefore: false, templates: 5, personalScore: limit * 1.05 }), cfg).wake).toBe(false)
  })
  it('does nothing when wake-word mode is disabled', () => {
    expect(new WakeGate().decide(base({ templates: 5, personalScore: 1 }), { enabled: false, sensitivity: 0.6 })).toMatchObject({ wake: false, reason: 'wake word is off' })
  })
})
