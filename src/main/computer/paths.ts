export interface Point { x: number; y: number }
export interface PreparedPath { strokes: Point[][]; inputPoints: number; outputPoints: number; length: number; durationMs: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
/** Iterative RDP preserves endpoints and bounds simplification error, including loops. */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3 || tolerance === 0) return points.slice()
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let far = tolerance, index = -1
    for (let i = a + 1; i < b; i++) { const d = segmentDistance(points[i], points[a], points[b]); if (d > far) { far = d; index = i } }
    if (index >= 0) { keep.add(index); stack.push([a, index], [index, b]) }
  }
  return [...keep].sort((a, b) => a - b).map(i => points[i])
}
export function preparePath(strokes: Point[][], speed = 1800, precision = 0.6, hz = 125): PreparedPath {
  if (!Number.isFinite(speed) || speed < 20 || speed > 12000 || !Number.isFinite(precision) || precision < 0 || precision > 3 || !Number.isFinite(hz) || hz < 30 || hz > 250) throw new Error('Invalid drawing speed (20–12000 px/s), precision (0–3 px) or rate (30–250 Hz)')
  const count = strokes.reduce((n, p) => n + p.length, 0)
  if (!strokes.length || strokes.length > 100 || count > 20000 || strokes.some(s => s.length < 2 || s.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 100000 || Math.abs(p.y) > 100000))) throw new Error('Provide 1–100 strokes with 2–20000 finite points total')
  let length = 0, outputPoints = 0
  const result = strokes.map(stroke => {
    // Bounded lookahead keeps worst-case zigzags off the UI's critical path.
    const reduced: Point[] = []
    for (let n = 0; n < stroke.length - 1; n += 255) {
      const chunk = simplify(stroke.slice(n, Math.min(stroke.length, n + 256)), precision)
      reduced.push(...(n ? chunk.slice(1) : chunk))
    }
    const out = [reduced[0]]
    for (let i = 1; i < reduced.length; i++) {
      const a = reduced[i - 1], b = reduced[i], d = distance(a, b)
      length += d
      // Speed-aware interpolation; corners remain explicit and short segments get more time.
      const steps = Math.max(1, Math.ceil(d / Math.max(1, speed / hz)))
      for (let j = 1; j <= steps; j++) out.push({ x: a.x + (b.x - a.x) * j / steps, y: a.y + (b.y - a.y) * j / steps })
      if (out.length + outputPoints > 50000) throw new Error('Drawing exceeds the 50000-sample limit')
    }
    outputPoints += out.length
    return out
  })
  const durationMs = Math.max(length / speed * 1000, (outputPoints - strokes.length) / hz * 1000)
  if (durationMs > 120000) throw new Error('Drawing exceeds the two-minute action deadline; split it into strokes')
  return { strokes: result, inputPoints: count, outputPoints, length, durationMs }
}
