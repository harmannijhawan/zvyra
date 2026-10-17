import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ desktopCapturer: {}, screen: {} }))
const { parseGuide } = await import('../../src/main/tools/screenVision')

describe('show me how: guide parsing', () => {
  const size = { width: 1920, height: 1080 }
  it('turns normalised boxes into screen boxes, in order', () => {
    const g = parseGuide(
      JSON.stringify({ steps: [{ label: 'Open Settings', box_2d: [100, 50, 150, 150] }, { label: 'Click Bluetooth', box_2d: [500, 500, 540, 700] }], say: 'Open Settings, then Bluetooth.', next: '' }),
      size
    )
    expect(g.steps).toHaveLength(2)
    expect(g.steps[0]).toEqual({ label: 'Open Settings', box: { x: 96, y: 108, w: 192, h: 54 } })
    expect(g.steps[1].box.x).toBe(960)
    expect(g.say).toContain('Bluetooth')
  })
  it('accepts fenced JSON, clamps out-of-range values and drops broken steps', () => {
    const g = parseGuide('```json\n{"steps":[{"label":"x","box_2d":[-20,0,50,1200]},{"label":"bad","box_2d":[1,2]},{"label":"tiny","box_2d":[10,10,10,10]}]}\n```', size)
    expect(g.steps).toHaveLength(1)
    expect(g.steps[0].box).toEqual({ x: 0, y: 0, w: 1920, h: 54 })
  })
  it('fails clearly on non-JSON', () => {
    expect(() => parseGuide('sorry I cannot', size)).toThrow(/Couldn’t read/)
  })
})
