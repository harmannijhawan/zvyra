import { describe, expect, it } from 'vitest'
import { toAccelerator } from '@renderer/lib/accelerator'
import { describeSchedule, validateSchedule } from '@renderer/lib/schedule'
import { normalizeUrl } from '@renderer/lib/url'

const key = (p: Partial<Parameters<typeof toAccelerator>[0]>) => ({ key: 'a', code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...p })

describe('toAccelerator', () => {
  it('builds Electron accelerators', () => {
    expect(toAccelerator(key({ ctrlKey: true, altKey: true, key: 'z', code: 'KeyZ' }))).toBe('Control+Alt+Z')
    expect(toAccelerator(key({ ctrlKey: true, key: ' ', code: 'Space' }))).toBe('Control+Space')
    expect(toAccelerator(key({ altKey: true, key: '1', code: 'Digit1' }))).toBe('Alt+1')
  })
  it('requires a real modifier and ignores lone modifier keys', () => {
    expect(toAccelerator(key({}))).toBeNull()
    expect(toAccelerator(key({ shiftKey: true }))).toBeNull()
    expect(toAccelerator(key({ ctrlKey: true, key: 'Control', code: 'ControlLeft' }))).toBeNull()
  })
})

describe('schedule helpers', () => {
  it('describes schedules', () => {
    expect(describeSchedule({ type: 'interval', everyMinutes: 120 })).toBe('Every 2 hours')
    expect(describeSchedule({ type: 'interval', everyMinutes: 15 })).toBe('Every 15 minutes')
    expect(describeSchedule({ type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] })).toMatch(/^Weekdays at /)
  })
  it('validates schedules', () => {
    const now = Date.parse('2026-10-15T12:00:00Z')
    expect(validateSchedule({ type: 'daily', time: '09:00', days: [] })).toMatch(/day/)
    expect(validateSchedule({ type: 'once', at: '2026-10-14T12:00:00Z' }, now)).toMatch(/future/)
    expect(validateSchedule({ type: 'once', at: '2026-10-16T12:00:00Z' }, now)).toBeNull()
    expect(validateSchedule({ type: 'interval', everyMinutes: 0 })).not.toBeNull()
  })
})

describe('normalizeUrl', () => {
  it('accepts bare domains and http(s) only', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/')
    expect(normalizeUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x')
    expect(normalizeUrl('localhost:5173')).toBe('https://localhost:5173/')
    expect(normalizeUrl('file:///C:/Windows')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('not a url')).toBeNull()
  })
})
