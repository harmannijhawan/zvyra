import { describe, expect, it } from 'vitest'
import { GEMINI_VOICES, isSleepPhrase, pickConversationalLiveModels } from '../../src/main/voice/catalog'
import { buildKeywords, WAKE_LABEL } from '../../src/main/voice/keywords'
import { pcm16ToFloat } from '../../src/main/voice/wakeSpotter'

describe('wake keywords', () => {
  it('emits one labelled line per pronunciation with sensitivity-driven threshold/boost', () => {
    const strict = buildKeywords(0.3).trim().split('\n')
    const loose = buildKeywords(0.9).trim().split('\n')
    expect(strict.length).toBeGreaterThanOrEqual(6)
    for (const l of strict) expect(l).toMatch(new RegExp(`^▁(HE|HI|HIS|HA) .+ @${WAKE_LABEL} :[\\d.]+ #[\\d.]+$`))
    const th = (l: string) => Number(/#([\d.]+)/.exec(l)![1])
    expect(th(loose[0])).toBeLessThan(th(strict[0]))
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
