/**
 * OWNER: Kiro. Wake decision for "Hey Zvyra" (pure, unit-tested).
 *
 * Detection and decision are separate on purpose:
 *  - detectors (the on-device keyword spotter and the personal template matcher)
 *    only report evidence,
 *  - this gate decides, and prefers silence whenever the evidence is weak or
 *    ambiguous (look-alike phrase, mid-sentence, ZVYRA's own voice, a sound
 *    that matched an earlier false wake, a noisy room that already produced
 *    false wakes).
 *
 * No speech-to-text is involved: a transcript that merely contains "Zvyra" can
 * never wake ZVYRA.
 */

export type WakeSource = 'kws' | 'personal'

export interface WakeEvidence {
  source: WakeSource
  /** Keyword-spotter variant class ('core' = the real “Zvyra” sound, 'loose' = accent look-alike). */
  kind?: 'core' | 'loose'
  /** DTW distance to the user's recorded wake samples (lower = closer; Infinity = none/unusable). */
  personalScore: number
  /** Distance to clips that previously caused false wakes (Infinity = none). */
  negativeScore: number
  /** Number of recorded wake samples (explicit training only). */
  templates: number
  /** The phrase started after a pause (wake words are said after a pause, look-alikes inside sentences are not). */
  pauseBefore: boolean
  /** ZVYRA's own audio is (or just was) playing. */
  echo: boolean
  /** Length of the spoken segment in seconds (personal source only). */
  segmentSec?: number
  /** Distance limit calibrated on the user's own samples (see PersonalWake.calibratedLimit); default from sensitivity. */
  limit?: number
  now: number
}

export interface WakeGateConfig {
  enabled: boolean
  /** 0..1 user sensitivity. */
  sensitivity: number
}

export interface WakeDecision {
  wake: boolean
  reason: string
  /** 0..1, how sure the gate is (for logs / diagnostics). */
  confidence: number
}

/** Personal-template distance limit for a sensitivity (sensitivity 0.6 → 10.6). */
export const personalLimit = (sensitivity: number) => 9.4 + Math.min(0.95, Math.max(0.05, sensitivity)) * 2

const COOLDOWN_MS = 2500
const NOISY_WINDOW_MS = 5 * 60_000
const NOISY_FALSE_WAKES = 2

export class WakeGate {
  private cooldownUntil = 0
  private falseWakes: number[] = []

  /** Call after a session ends (and after a wake) so a repeated "Hey Zvyra" or ZVYRA's goodbye can't re-trigger instantly. */
  hold(now: number, ms = COOLDOWN_MS) {
    this.cooldownUntil = Math.max(this.cooldownUntil, now + ms)
  }

  /** A wake that turned out to be false (nobody spoke to ZVYRA afterwards). */
  noteFalseWake(now: number) {
    this.falseWakes = [...this.falseWakes.filter((t) => now - t < NOISY_WINDOW_MS), now]
  }

  /** Background speech / TV recently produced false wakes: demand stronger evidence. */
  noisy(now: number) {
    return this.falseWakes.filter((t) => now - t < NOISY_WINDOW_MS).length >= NOISY_FALSE_WAKES
  }

  decide(e: WakeEvidence, cfg: WakeGateConfig): WakeDecision {
    const no = (reason: string, confidence = 0): WakeDecision => ({ wake: false, reason, confidence })
    if (!cfg.enabled) return no('wake word is off')
    if (e.echo) return no('ZVYRA was speaking')
    if (e.now < this.cooldownUntil) return no('repeat within cooldown')

    const limit = e.limit && e.limit > 0 ? e.limit : personalLimit(cfg.sensitivity)
    const hasVoice = e.templates >= 3 && Number.isFinite(e.personalScore)
    const voiceMargin = hasVoice ? (limit - e.personalScore) / limit : -1
    // Sounds more like a previous false wake than like the user's own “Hey Zvyra”.
    if (Number.isFinite(e.negativeScore) && e.negativeScore < limit * 1.15 && (!hasVoice || e.negativeScore < e.personalScore)) {
      return no('matches a previous false wake')
    }
    const noisy = this.noisy(e.now)

    if (e.source === 'personal') {
      // Template match alone (no keyword-spotter agreement): stricter limit, short isolated phrase only.
      if (e.templates < 3) return no('not enough voice samples')
      if ((e.segmentSec ?? 0) > 2.4) return no('too long for a wake phrase')
      if (!e.pauseBefore) return no('not after a pause')
      const allowed = limit * (noisy ? 0.85 : 0.93)
      if (!(e.personalScore <= allowed)) return no('does not sound enough like your “Hey Zvyra”', Math.max(0, voiceMargin))
      return this.accept('matches your voice samples', 0.6 + Math.min(0.4, voiceMargin))
    }

    // Keyword spotter hit.
    const kind = e.kind ?? 'loose'
    if (!e.pauseBefore) return no(kind === 'loose' ? 'look-alike phrase in the middle of speech' : 'wake phrase in the middle of speech')
    if (hasVoice) {
      const allowed = limit * (kind === 'core' ? (noisy ? 1.15 : 1.3) : noisy ? 1.0 : 1.1)
      if (!(e.personalScore <= allowed)) return no('does not sound like your “Hey Zvyra”', Math.max(0, voiceMargin))
      return this.accept(`${kind} keyword + your voice`, kind === 'core' ? 0.85 : 0.7)
    }
    // No voice samples to compare with.
    if (noisy) return no('recent false wakes here: record your voice in Settings → Voice to wake in a noisy room')
    if (kind === 'loose') {
      if (cfg.sensitivity < 0.85) return no('look-alike phrase (raise sensitivity or record your voice to accept it)')
      return this.accept('look-alike keyword after a pause (high sensitivity)', 0.45)
    }
    return this.accept('core keyword after a pause', 0.65)
  }

  private accept(reason: string, confidence: number): WakeDecision {
    return { wake: true, reason, confidence: Math.max(0, Math.min(1, confidence)) }
  }
}
