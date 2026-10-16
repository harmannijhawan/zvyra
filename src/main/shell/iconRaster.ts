/**
 * Pure rasteriser for the ZVYRA ribbon "Z" mark, used for the tray and window
 * icons (nativeImage cannot load SVG). The outline is sampled from Z_OUTLINE in
 * src/renderer/src/components/brand.tsx (normalized to a 0..1 square).
 * Fill: cyan → blue → lavender diagonal with a soft top-left highlight.
 * Returns premultiplied BGRA pixels for nativeImage.createFromBitmap.
 */

type Pt = [number, number]
type RGB = [number, number, number]

// prettier-ignore
const Z: Pt[] = [[0.047,0.463],[0.042,0.391],[0.045,0.318],[0.057,0.247],[0.084,0.18],[0.127,0.121],[0.186,0.08],[0.255,0.056],[0.327,0.051],[0.399,0.051],[0.472,0.051],[0.545,0.051],[0.617,0.051],[0.69,0.051],[0.762,0.051],[0.835,0.051],[0.904,0.072],[0.94,0.133],[0.926,0.203],[0.879,0.257],[0.827,0.308],[0.774,0.358],[0.722,0.408],[0.669,0.458],[0.617,0.508],[0.564,0.558],[0.511,0.608],[0.459,0.658],[0.424,0.696],[0.49,0.666],[0.558,0.641],[0.628,0.62],[0.698,0.603],[0.77,0.591],[0.842,0.585],[0.915,0.587],[0.959,0.625],[0.955,0.697],[0.935,0.767],[0.901,0.831],[0.855,0.887],[0.796,0.929],[0.727,0.948],[0.654,0.948],[0.581,0.948],[0.509,0.948],[0.436,0.948],[0.364,0.948],[0.291,0.948],[0.218,0.948],[0.146,0.946],[0.079,0.92],[0.041,0.861],[0.059,0.792],[0.107,0.738],[0.156,0.684],[0.205,0.631],[0.254,0.578],[0.304,0.524],[0.353,0.471],[0.402,0.418],[0.451,0.364],[0.5,0.311],[0.55,0.257],[0.55,0.226],[0.477,0.231],[0.406,0.242],[0.335,0.259],[0.266,0.283],[0.201,0.314],[0.14,0.354],[0.087,0.403]]

const STOPS: [number, RGB][] = [
  [0, [143, 220, 255]],
  [0.32, [63, 147, 255]],
  [0.66, [43, 98, 245]],
  [1, [183, 166, 255]]
]

function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function gradient(t: number): RGB {
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i]
    const [t0, c0] = STOPS[i - 1]
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0)
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
    }
  }
  return STOPS[STOPS.length - 1][1]
}

/** @param size pixel size (square). @param samples supersampling per axis. */
export function renderZIcon(size: number, samples = 4): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const n = samples * samples
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const p: Pt = [(x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size]
          if (!inside(p, Z)) continue
          const c = gradient(Math.min(1, Math.max(0, (p[0] + p[1]) / 2)))
          // soft white highlight toward the top-left
          const h = Math.max(0, 0.45 - Math.hypot(p[0] - 0.22, p[1] - 0.12)) * 0.9
          r += c[0] + (255 - c[0]) * h
          g += c[1] + (255 - c[1]) * h
          b += c[2] + (255 - c[2]) * h
          a += 1
        }
      }
      const i = (y * size + x) * 4
      // Premultiplied BGRA: average of covered samples × coverage.
      buf[i] = Math.round(b / n)
      buf[i + 1] = Math.round(g / n)
      buf[i + 2] = Math.round(r / n)
      buf[i + 3] = Math.round((a / n) * 255)
    }
  }
  return buf
}
