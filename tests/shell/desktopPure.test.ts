import { describe, expect, it } from 'vitest'
import { atLeast, debrand, inQuietHours, isE164, isInside, maskPhone, nextRun, relevance, splitKeys, stripToolMarkup, toWholeHour, xmlEscape } from '../../src/main/desktop/pure'

describe('isInside', () => {
  it('contains children and the root itself, case-insensitively on Windows', () => {
    expect(isInside('C:\\Proj', 'C:\\Proj', true)).toBe(true)
    expect(isInside('C:\\Proj', 'c:\\proj\\src\\a.ts', true)).toBe(true)
    expect(isInside('C:\\Proj\\', 'C:\\Proj\\x', true)).toBe(true)
  })
  it('rejects siblings with the same prefix and parents', () => {
    expect(isInside('C:\\Proj', 'C:\\Project2\\a', true)).toBe(false)
    expect(isInside('C:\\Proj\\src', 'C:\\Proj', true)).toBe(false)
    expect(isInside('/home/a', '/home/A/x', false)).toBe(false)
  })
})

describe('debrand', () => {
  it('removes engine branding from visible strings', () => {
    expect(debrand('Embedded SWARM: connect a BYOK provider and test it')).toBe('Connect an AI provider and test it')
    expect(debrand('SWARM providers')).toBe('AI providers')
    expect(debrand('SWARM embedded')).toBe('ZVYRA engine')
    expect(debrand('Run failed in SWARM')).toBe('Run failed in ZVYRA')
    expect(debrand(undefined)).toBeUndefined()
    expect(debrand("Hello! I'm SWARM, a conversational AI team")).toBe("Hello! I'm ZVYRA, a conversational AI team")
    expect(debrand('lowercase text stays as is')).toBe('lowercase text stays as is')
  })

  it('strips leaked tool-call markup', () => {
    expect(stripToolMarkup("<|tool_call_start|>[swarm(action='status')]<|tool_call_end|>")).toBe('')
    expect(stripToolMarkup('Hi there <tool_call>{"x":1}</tool_call>')).toBe('Hi there')
  })
})

describe('nextRun', () => {
  const from = new Date(2026, 9, 15, 10, 30).getTime() // Thu 15 Oct 2026 10:30 local
  it('handles once/interval', () => {
    expect(nextRun({ type: 'once', at: new Date(from + 1000).toISOString() }, from)).toBe(from + 1000)
    expect(nextRun({ type: 'once', at: new Date(from - 1000).toISOString() }, from)).toBeNull()
    expect(nextRun({ type: 'interval', everyMinutes: 15 }, from)).toBe(from + 15 * 60_000)
  })
  it('finds the next matching weekday time', () => {
    expect(nextRun({ type: 'daily', time: '11:00', days: [4] }, from)).toBe(new Date(2026, 9, 15, 11, 0).getTime())
    expect(nextRun({ type: 'daily', time: '09:00', days: [4] }, from)).toBe(new Date(2026, 9, 22, 9, 0).getTime())
    expect(nextRun({ type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, from)).toBe(new Date(2026, 9, 16, 9, 0).getTime())
    expect(nextRun({ type: 'daily', time: '09:00', days: [] }, from)).toBeNull()
  })
})

describe('notification helpers', () => {
  it('compares priorities and quiet hours (wrapping midnight)', () => {
    expect(atLeast('critical', 'high')).toBe(true)
    expect(atLeast('normal', 'high')).toBe(false)
    expect(inQuietHours('22:00', '07:00', new Date(2026, 0, 1, 23, 0))).toBe(true)
    expect(inQuietHours('22:00', '07:00', new Date(2026, 0, 1, 12, 0))).toBe(false)
    expect(inQuietHours('09:00', '17:00', new Date(2026, 0, 1, 12, 0))).toBe(true)
    expect(toWholeHour('22:45')).toBe('22:00')
  })
})

describe('misc helpers', () => {
  it('splits keys, masks phones, validates E.164, escapes XML, scores relevance', () => {
    expect(splitKeys({ a: 1, b: 2, c: undefined }, ['a'])).toEqual([{ a: 1 }, { b: 2 }])
    expect(maskPhone('+14155550123')).toBe('+14••••0123')
    expect(isE164('+14155550123')).toBe(true)
    expect(isE164('4155550123')).toBe(false)
    expect(xmlEscape('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;')
    expect(relevance('write the quarterly report', 'Quarterly report format: one page')).toBeGreaterThan(0.4)
    expect(relevance('hi', 'anything')).toBe(0)
  })
})
