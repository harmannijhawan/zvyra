import { describe, expect, it } from 'vitest'
import { deriveIslandVisual, ISLAND_SIZES, surfaceHeight, visualGroup, type IslandInput } from '../../src/renderer/src/lib/islandVisual'

const base: IslandInput = { mode: 'compact', voice: { state: 'standby' }, permissions: 0, camera: { open: false }, freshTools: 0, agentWorking: false, hasPeek: false }
const v = (p: Partial<IslandInput>) => deriveIslandVisual({ ...base, ...p })

describe('island visual state', () => {
  it('is tiny and idle by default', () => {
    expect(v({})).toBe('idle')
    expect(v({ mode: 'mini' })).toBe('mini')
    expect(ISLAND_SIZES.idle.w).toBeLessThan(240)
    expect(ISLAND_SIZES.idle.h).toBeLessThanOrEqual(40)
  })
  it('follows the real voice pipeline states', () => {
    expect(v({ voice: { state: 'wake_detected' } })).toBe('listening')
    expect(v({ voice: { state: 'listening' } })).toBe('listening')
    expect(v({ voice: { state: 'listening', userSpeaking: true } })).toBe('speech')
    expect(v({ voice: { state: 'transcribing' } })).toBe('processing')
    expect(v({ voice: { state: 'speaking' } })).toBe('speaking')
  })
  it('returns to idle when the conversation ends, is cancelled or errors', () => {
    for (const state of ['standby', 'off', 'error', 'unavailable'] as const) expect(v({ voice: { state } })).toBe('idle')
  })
  it('shows approvals above everything except a pending camera capture', () => {
    expect(v({ permissions: 1, voice: { state: 'speaking' } })).toBe('approval')
    expect(v({ permissions: 1, mode: 'expanded' })).toBe('approval')
    expect(v({ permissions: 1, camera: { open: true, captureId: 'x' } })).toBe('camera')
  })
  it('keeps voice states in one content group so they morph in place', () => {
    expect(new Set(['listening', 'speech', 'processing', 'speaking'].map((x) => visualGroup(x as never)))).toEqual(new Set(['voice']))
  })
  it('shows notifications inside the island, but never over voice or approvals', () => {
    expect(v({ hasNotice: true })).toBe('notice')
    expect(v({ hasNotice: true, voice: { state: 'speaking' } })).toBe('speaking')
    expect(v({ hasNotice: true, permissions: 1 })).toBe('approval')
    expect(v({ hasNotice: true, hasPeek: true, agentWorking: true })).toBe('notice')
  })
  it('only grows as far as content needs, within bounds', () => {
    expect(surfaceHeight('idle', 500)).toBe(ISLAND_SIZES.idle.h)
    expect(surfaceHeight('peek', 10)).toBe(ISLAND_SIZES.peek.h)
    expect(surfaceHeight('peek', 120)).toBe(120)
    expect(surfaceHeight('approval', 9000)).toBe(ISLAND_SIZES.approval.max)
  })
})
