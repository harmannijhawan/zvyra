import { describe, expect, it } from 'vitest'
import { GEMINI_VOICES, isSleepPhrase, pickConversationalLiveModels } from '../../src/main/voice/catalog'
import { buildKeywords, WAKE_LABEL, WAKE_LABEL_LOOSE } from '../../src/main/voice/keywords'
import { pcm16ToFloat, startsAfterPause } from '../../src/main/voice/wakeSpotter'

describe('wake keywords', () => {
  it('emits one labelled line per pronunciation with sensitivity-driven threshold/boost', () => {
    const strict = buildKeywords(0.3).trim().split('\n')
    const loose = buildKeywords(0.9).trim().split('\n')
    expect(strict.length).toBeGreaterThanOrEqual(6)
    for (const l of strict) expect(l).toMatch(new RegExp(`^▁(HE|HI|HIS|HA) .+ @(${WAKE_LABEL}|${WAKE_LABEL_LOOSE}) :[\\d.]+ #[\\d.]+$`))
    const th = (l: string) => Number(/#([\d.]+)/.exec(l)![1])
    expect(th(loose[0])).toBeLessThan(th(strict[0]))
  })
  it('makes look-alike phrases ("his veera") clearly stricter than the real wake word', () => {
    const lines = buildKeywords(0.8).trim().split('\n')
    const th = (l: string) => Number(/#([\d.]+)/.exec(l)![1])
    const core = lines.find((l) => l.startsWith('▁HE Y ▁ Z V Y RA'))!
    const alt = lines.find((l) => l.startsWith('▁HIS ▁VI RA'))!
    expect(core).toContain(`@${WAKE_LABEL} `)
    expect(alt).toContain(`@${WAKE_LABEL_LOOSE} `)
    expect(th(alt)).toBeGreaterThan(th(core) + 0.05)
  })
})

describe('wake verification', () => {
  const frame = (amp: number) => Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 5) * amp)
  it('accepts a phrase said after a pause', () => {
    expect(startsAfterPause([...Array.from({ length: 8 }, () => frame(0.002)), ...Array.from({ length: 10 }, () => frame(0.2))])).toBe(true)
  })
  it('rejects a look-alike in the middle of continuous speech', () => {
    expect(startsAfterPause(Array.from({ length: 18 }, () => frame(0.18)))).toBe(false)
  })
})

describe('voice catalogue', () => {
  it('keeps only conversational Live models, newest first', () => {
    const models = pickConversationalLiveModels([
      { name: 'models/gemini-3.1-flash-live-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-3.5-transcribe-live', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-3.5-live-translate-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] }
    ])
    expect(models.map((m) => m.id)).toEqual(['gemini-3.8-live', 'gemini-3.1-flash-live-preview'])
  })

  it('has 30 unique prebuilt voices', () => {
    expect(new Set(GEMINI_VOICES.map((v) => v.name)).size).toBe(30)
  })

  it('recognises sleep phrases without firing on normal speech', () => {
    expect(isSleepPhrase('Okay, that’s all for now')).toBe(true)
    expect(isSleepPhrase('go to sleep')).toBe(true)
    expect(isSleepPhrase('Goodbye Zvyra!')).toBe(true)
    expect(isSleepPhrase('Is that all the files in the folder?')).toBe(false)
    expect(isSleepPhrase('Put my laptop to sleep at 10')).toBe(false)
  })
})

describe('pcm16ToFloat', () => {
  it('converts little-endian PCM16 to floats', () => {
    const b = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80])
    const f = pcm16ToFloat(b)
    expect(f[0]).toBe(0)
    expect(f[1]).toBeCloseTo(1, 3)
    expect(f[2]).toBe(-1)
  })
})
