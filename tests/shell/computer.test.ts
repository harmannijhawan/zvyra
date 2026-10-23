import { describe, expect, it } from 'vitest'
import { InputQueue } from '../../src/main/computer/inputQueue'
import { framePoint } from '../../src/main/computer/coordinates'
import { preparePath, segmentDistance, simplify } from '../../src/main/computer/paths'
import { CompletionEvidence } from '../../src/main/agent/completion'
import {isDesktopMission,pixelChange,sameRect} from '../../src/main/computer/focusPolicy'

describe('desktop mission routing and focus guards',()=>{
  it('routes natural desktop instructions and Computer page tasks',()=>{
    for(const s of ['Computer task: prepare my report','Open Notepad and write a shopping list','Use my mouse to arrange these windows','Draw a house in Paint','Save the note using the GUI'])expect(isDesktopMission(s),s).toBe(true)
    expect(isDesktopMission('Research a business and build a website')).toBe(false)
  })
  it('detects moved windows and meaningful screenshot changes',()=>{
    const r={x:-100,y:20,w:800,h:600};expect(sameRect(r,{...r,x:-99})).toBe(true);expect(sameRect(r,{...r,x:30})).toBe(false)
    expect(pixelChange(new Uint8Array(40),new Uint8Array(40))).toBe(0);expect(pixelChange(new Uint8Array(40),new Uint8Array(40).fill(200))).toBe(1)
  })
})

describe('physical desktop coordinate mapping', () => {
  it('maps a resized crop on a negative-offset display through the OS DPI mapper', () => {
    const p = framePoint({ x: 400, y: 200 }, { width: 800, height: 400, bounds: { x: -1600, y: -100, width: 1600, height: 900 }, crop: { x: 200, y: 100, width: 800, height: 400 } }, p => ({ x: p.x * 1.5, y: p.y * 1.5 }))
    expect(p).toEqual({ x: -1500, y: 300 })
  })
  it('rejects missing dimensions, off-frame targets and invalid crops', () => {
    const f = { width: 800, height: 400, bounds: { x: 0, y: 0, width: 1600, height: 800 } }
    for (const p of [{ x: -1, y: 0 }, { x: 800, y: 100 }, { x: NaN, y: 2 }]) expect(() => framePoint(p, f, p => p)).toThrow()
    expect(() => framePoint({ x: 1, y: 1 }, { ...f, crop: { x: 1500, y: 0, width: 200, height: 100 } }, p => p)).toThrow()
  })
})
describe('arbitrary stroke geometry', () => {
  it('removes redundant line samples but preserves endpoints', () => {
    const source = Array.from({ length: 1000 }, (_, x) => ({ x, y: x / 2 }))
    expect(simplify(source, 0.5)).toEqual([source[0], source.at(-1)])
    const p = preparePath([source], 2000)
    expect(p.outputPoints).toBeLessThan(100)
    expect(p.strokes[0].at(-1)).toEqual(source.at(-1))
  })
  it('preserves circles, spirals, sharp turns, loops and separate strokes within tolerance', () => {
    for (const shape of ['circle', 'spiral', 'irregular']) {
      const s = Array.from({ length: 601 }, (_, i) => { const t = i / 600 * Math.PI * 6, r = shape === 'spiral' ? i / 6 : shape === 'irregular' ? 75 + 20 * Math.sin(7 * t) : 90; return { x: 200 + Math.cos(t) * r, y: 200 + Math.sin(t) * r } })
      const out = preparePath([s, [{ x: -200, y: -20 }, { x: -50, y: 10 }]], 1800, 0.5)
      expect(out.strokes).toHaveLength(2)
      expect(out.strokes[0][0]).toEqual(s[0])
      expect(out.strokes[0].at(-1)).toEqual(s.at(-1))
      const deviation = Math.max(...s.map(p => Math.min(...out.strokes[0].slice(1).map((b, i) => segmentDistance(p, out.strokes[0][i], b)))))
      expect(deviation).toBeLessThanOrEqual(0.501)
    }
  })
  it('rejects unbounded workloads and invalid rates', () => {
    expect(() => preparePath([[{ x: 0, y: 0 }, { x: Infinity, y: 1 }]])).toThrow()
    expect(() => preparePath([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], 0)).toThrow()
    expect(() => preparePath([[{ x: 0, y: 0 }, { x: 100000, y: 100000 }]], 20)).toThrow()
  })
})
describe('bounded input execution', () => {
  it('never overlaps and drops queued work after stop', async () => {
    const q = new InputQueue(), order: number[] = []
    let unblock!: () => void
    const first = q.run(async () => { order.push(1); await new Promise<void>(r => { unblock = r }); order.push(2) })
    await Promise.resolve()
    const next = q.run(async () => { order.push(3) })
    const outcome = expect(next).rejects.toThrow(/stopped/)
    q.stop(); unblock(); await first; await outcome
    expect(order).toEqual([1, 2])
    expect(await q.run(async () => 4)).toBe(4)
  })
  it('enforces queue capacity and rejects pre-cancelled work', async () => {
    const q = new InputQueue()
    let unblock!: () => void
    const one = q.run(() => new Promise<void>(r => { unblock = r }))
    await Promise.resolve()
    const queued = Array.from({ length: 31 }, () => q.run(async () => 1))
    await expect(q.run(async () => 2)).rejects.toThrow(/full/)
    unblock(); await Promise.all([one, ...queued])
    await expect(q.run(async () => 1, AbortSignal.abort())).rejects.toThrow()
  })
  it('requires verified UI evidence after both successful and failed input', () => {
    const e = new CompletionEvidence()
    e.observe('computer', { action: 'click' }, { ok: true, inputExecuted: true })
    expect(e.issues()).toHaveLength(1)
    e.observe('computer', { action: 'observe' }, { ok: true, verified: false })
    expect(e.issues()).toHaveLength(1)
    e.observe('computer', { action: 'observe' }, { ok: true, verified: true })
    expect(e.issues()).toEqual([])
    e.observe('computer', { action: 'draw' }, { error: 'Focus lost' })
    expect(e.issues()).toHaveLength(1)
  })
})
