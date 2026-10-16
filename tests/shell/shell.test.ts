import { describe, expect, it } from 'vitest'
import { METHOD_NAMES } from '../../src/shared/contract'
import { ISLAND_SIZE, SHELL_METHOD_NAMES } from '../../src/shared/shell'
import { anchorFromBounds, boundsForMode, defaultAnchor } from '../../src/main/shell/islandGeometry'
import { renderZIcon } from '../../src/main/shell/iconRaster'

const work = { x: 0, y: 0, width: 1920, height: 1040 }

describe('island geometry', () => {
  it('starts top-centre and keeps the pill centred across modes', () => {
    const a = defaultAnchor(work)
    const compact = boundsForMode(a, 'compact', work).bounds
    const mini = boundsForMode(a, 'mini', work).bounds
    expect(compact.x + compact.width / 2).toBe(960)
    expect(mini.x + mini.width / 2).toBe(960)
    expect(compact.y).toBe(10)
  })

  it('expands downward with room, upward near the bottom edge', () => {
    expect(boundsForMode({ centerX: 960, top: 10 }, 'expanded', work).direction).toBe('down')
    const low = boundsForMode({ centerX: 960, top: 900 }, 'expanded', work)
    expect(low.direction).toBe('up')
    // The pill stays where it was: bottom of window == bottom of the compact pill.
    expect(low.bounds.y + low.bounds.height).toBe(900 + ISLAND_SIZE.compact.height)
  })

  it('round-trips the anchor when expanded upward', () => {
    const low = boundsForMode({ centerX: 960, top: 900 }, 'expanded', work)
    expect(anchorFromBounds(low.bounds, 'expanded', 'up')).toEqual({ centerX: 960, top: 900 })
  })

  it('never lets the compact pill sit below the work area', () => {
    expect(boundsForMode({ centerX: 960, top: 5000 }, 'compact', work).bounds.y).toBe(work.height - ISLAND_SIZE.compact.height)
  })

  it('clamps into the work area on other displays and off-screen positions', () => {
    const second = { x: 1920, y: 0, width: 1280, height: 680 }
    const b = boundsForMode({ centerX: 5000, top: -400 }, 'compact', second).bounds
    expect(b.x + b.width).toBeLessThanOrEqual(second.x + second.width)
    expect(b.y).toBe(0)
    const e = boundsForMode({ centerX: 2000, top: 300 }, 'expanded', second).bounds
    expect(e.y).toBeGreaterThanOrEqual(0)
    expect(e.y + e.height).toBeLessThanOrEqual(680)
  })
})

describe('tray icon raster', () => {
  it('produces premultiplied BGRA with transparent corners and opaque strokes', () => {
    const size = 32
    const buf = renderZIcon(size)
    expect(buf.length).toBe(size * size * 4)
    expect(buf[3]).toBe(0) // top-left transparent
    let opaque = 0
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > 200) opaque++
    expect(opaque).toBeGreaterThan(100)
    for (let i = 0; i < buf.length; i += 4) expect(Math.max(buf[i], buf[i + 1], buf[i + 2])).toBeLessThanOrEqual(buf[i + 3])
  })
})

describe('contract whitelists', () => {
  it('has unique method names', () => {
    expect(new Set(METHOD_NAMES).size).toBe(METHOD_NAMES.length)
    expect(new Set(SHELL_METHOD_NAMES).size).toBe(SHELL_METHOD_NAMES.length)
  })
})
