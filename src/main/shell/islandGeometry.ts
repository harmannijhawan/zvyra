/**
 * Pure geometry for the Dynamic Island window. The island is anchored by its
 * pill: horizontal centre + the top edge of the compact pill. Expanding grows
 * downward when there is room, otherwise upward, and everything is clamped to
 * the display work area (DIPs, so Windows scaling is handled by Electron).
 */
import { ISLAND_SIZE, type IslandMode } from '../../shared/shell'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface IslandAnchor {
  centerX: number
  top: number
}

export function anchorFromBounds(bounds: Rect, mode: IslandMode, direction: 'down' | 'up'): IslandAnchor {
  const centerX = bounds.x + bounds.width / 2
  const top = mode === 'expanded' && direction === 'up' ? bounds.y + bounds.height - ISLAND_SIZE.compact.height : bounds.y
  return { centerX, top }
}

export function clampAnchor(anchor: IslandAnchor, work: Rect): IslandAnchor {
  const half = ISLAND_SIZE.compact.width / 2
  const centerX = Math.min(Math.max(anchor.centerX, work.x + half), work.x + work.width - half)
  const top = Math.min(Math.max(anchor.top, work.y), work.y + work.height - ISLAND_SIZE.compact.height)
  return { centerX, top }
}

export function boundsForMode(
  anchor: IslandAnchor,
  mode: IslandMode,
  work: Rect
): { bounds: Rect; direction: 'down' | 'up' } {
  const a = clampAnchor(anchor, work)
  const size = ISLAND_SIZE[mode]
  let direction: 'down' | 'up' = 'down'
  let y = a.top
  if (mode === 'expanded' && a.top + size.height > work.y + work.height) {
    direction = 'up'
    y = a.top + ISLAND_SIZE.compact.height - size.height
  }
  let x = Math.round(a.centerX - size.width / 2)
  x = Math.min(Math.max(x, work.x), work.x + work.width - size.width)
  y = Math.min(Math.max(y, work.y), work.y + work.height - size.height)
  return { bounds: { x, y: Math.round(y), width: size.width, height: size.height }, direction }
}

export function defaultAnchor(work: Rect): IslandAnchor {
  return { centerX: work.x + work.width / 2, top: work.y + 10 }
}
