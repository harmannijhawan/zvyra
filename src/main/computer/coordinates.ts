import type { Point } from './paths'
export interface FrameGeometry { width: number; height: number; bounds: { x: number; y: number; width: number; height: number }; crop?: { x: number; y: number; width: number; height: number } }
/** Model pixels -> original capture region -> global DIPs -> physical OS pixels. */
export function framePoint(p: Point, frame: FrameGeometry, toNative: (p: Point) => Point): Point {
  if (![p.x, p.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0 || p.x < 0 || p.y < 0 || p.x >= frame.width || p.y >= frame.height) throw new Error('Target is outside the observed frame')
  const r = frame.crop ?? { x: 0, y: 0, width: frame.bounds.width, height: frame.bounds.height }
  if (r.width <= 0 || r.height <= 0 || r.x < 0 || r.y < 0 || r.x + r.width > frame.bounds.width || r.y + r.height > frame.bounds.height) throw new Error('Invalid capture crop')
  return toNative({ x: frame.bounds.x + r.x + p.x * r.width / frame.width, y: frame.bounds.y + r.y + p.y * r.height / frame.height })
}
