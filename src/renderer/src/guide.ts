/**
 * ZVYRA pen overlay. Draws "go here → then here → done" on top of the screen
 * like someone with a marker: a wobbly circle around each target, a numbered
 * badge, a handwritten label, a curved arrow to the next step, and a final
 * check mark. Each stroke is drawn progressively with a glowing pen tip.
 * Steps come from the URL hash (DIP boxes relative to this display).
 */
import { shellCall } from './lib/client'
import './styles/guide.css'

interface Box {
  x: number
  y: number
  w: number
  h: number
}
interface Data {
  w: number
  h: number
  title?: string
  next?: string
  steps: { label: string; box: Box }[]
}

const NS = 'http://www.w3.org/2000/svg'
const COLORS = ['#ff4d6d', '#ffb020', '#3ddc97', '#4da3ff', '#c77dff', '#ff7ae0']
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const wait = (ms: number) => new Promise((r) => setTimeout(r, reduce ? 0 : ms))

let data: Data
try {
  data = JSON.parse(decodeURIComponent(location.hash.slice(1))) as Data
} catch {
  data = { w: innerWidth, h: innerHeight, steps: [] }
}

/* -------------------------------------------------------------- geometry */

// Deterministic wobble so the same plan always looks the same (and no Math.random jumps).
let seed = 7
const rnd = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

type Pt = [number, number]

/** Catmull-Rom → cubic Bézier path through points. */
function smooth(points: Pt[]): string {
  if (points.length < 2) return ''
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return d
}

interface Ring {
  cx: number
  cy: number
  rx: number
  ry: number
}

function ringFor(b: Box): Ring {
  const rx = Math.max(26, b.w / 2 + 16)
  const ry = Math.max(22, b.h / 2 + 13)
  // Keep the whole loop on screen (targets at the edge, like the Start button, would be cut off).
  const m = 6
  const cx = Math.max(rx + m, Math.min(data.w - rx - m, b.x + b.w / 2))
  const cy = Math.max(ry + m, Math.min(data.h - ry - m, b.y + b.h / 2))
  return { cx, cy, rx, ry }
}

/** Fades/wipes an element in with the frame loop (CSS animations stall in background windows). */
function reveal(e: SVGElement, ms: number, kind: 'write' | 'pop') {
  if (reduce) return
  const t0 = performance.now()
  e.style.opacity = '0'
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms)
    const k = ease(t)
    e.style.opacity = String(k)
    if (kind === 'write') e.style.clipPath = `inset(-20px ${((1 - k) * 100).toFixed(1)}% -20px -20px)`
    else e.style.scale = (0.4 + 0.6 * k + 0.15 * Math.sin(k * Math.PI)).toFixed(3) // small overshoot pop
    if (t < 1) nextFrame(step)
    else {
      e.style.clipPath = ''
      e.style.scale = ''
    }
  }
  nextFrame(step)
}

/** A hand-drawn loop: a bit more than one turn, slightly uneven, ends overlapping the start. */
function ringPath(r: Ring): string {
  const start = -Math.PI * (0.62 + rnd() * 0.2)
  const turn = Math.PI * 2 * (1.07 + rnd() * 0.06)
  const n = 26
  const k1 = rnd() * 6
  const k2 = rnd() * 6
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = start + turn * t
    const wob = 1 + 0.045 * Math.sin(a * 2 + k1) + 0.03 * Math.sin(a * 3 + k2) + (t > 0.9 ? (t - 0.9) * 0.6 : 0)
    pts.push([r.cx + Math.cos(a) * r.rx * wob, r.cy + Math.sin(a) * r.ry * wob])
  }
  return smooth(pts)
}

/** Where the line from the ring centre toward (tx, ty) leaves the ring. */
function edge(r: Ring, tx: number, ty: number, pad = 8): Pt {
  const a = Math.atan2(ty - r.cy, tx - r.cx)
  return [r.cx + Math.cos(a) * (r.rx + pad), r.cy + Math.sin(a) * (r.ry + pad)]
}

function arrowPaths(from: Ring, to: Ring, side: number): { body: string; head: string } {
  const a = edge(from, to.cx, to.cy, 6)
  const b = edge(to, from.cx, from.cy, 10)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const bend = Math.min(140, len * 0.28) * side
  const c: Pt = [(a[0] + b[0]) / 2 - (dy / len) * bend, (a[1] + b[1]) / 2 + (dx / len) * bend]
  const pts: Pt[] = []
  for (let i = 0; i <= 18; i++) {
    const t = i / 18
    const u = 1 - t
    const jitter = Math.sin(t * Math.PI) * (rnd() - 0.5) * 2.2
    pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0] + jitter, u * u * a[1] + 2 * u * t * c[1] + t * t * b[1] + jitter])
  }
  // Arrow head along the final tangent.
  const ang = Math.atan2(b[1] - c[1], b[0] - c[0])
  const hl = 17
  const l: Pt = [b[0] - hl * Math.cos(ang - 0.48), b[1] - hl * Math.sin(ang - 0.48)]
  const r: Pt = [b[0] - hl * Math.cos(ang + 0.5), b[1] - hl * Math.sin(ang + 0.5)]
  return { body: smooth(pts), head: `M${l[0].toFixed(1)},${l[1].toFixed(1)} L${b[0].toFixed(1)},${b[1].toFixed(1)} L${r[0].toFixed(1)},${r[1].toFixed(1)}` }
}

/* -------------------------------------------------------------- drawing */

const svg = document.createElementNS(NS, 'svg')
svg.setAttribute('class', 'guide')
svg.setAttribute('width', String(data.w))
svg.setAttribute('height', String(data.h))
svg.setAttribute('viewBox', `0 0 ${data.w} ${data.h}`)
document.getElementById('root')!.appendChild(svg)

const tip = document.createElementNS(NS, 'circle')
tip.setAttribute('class', 'pen-tip')
tip.setAttribute('r', '5')
tip.style.opacity = '0'
svg.appendChild(tip)

/**
 * Next animation frame, with a timer fallback: Chromium pauses
 * requestAnimationFrame for windows it thinks aren't visible, which would
 * freeze the drawing halfway. Time-based progress keeps the speed the same.
 */
function nextFrame(f: (now: number) => void) {
  let done = false
  requestAnimationFrame((t) => {
    if (done) return
    done = true
    f(t)
  })
  setTimeout(() => {
    if (done) return
    done = true
    f(performance.now())
  }, 34)
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element = svg): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  // Top-level marks go under the pen tip; children of a group just append.
  if (parent === svg) svg.insertBefore(e, tip)
  else parent.appendChild(e)
  return e
}

/** Draws a path like a pen stroke, with the glowing tip following it. */
function draw(d: string, color: string, width = 4.5): Promise<void> {
  const p = el('path', { d, class: 'stroke', stroke: color, 'stroke-width': width })
  p.style.setProperty('--c', color)
  const len = p.getTotalLength()
  if (reduce) return Promise.resolve()
  p.style.strokeDasharray = `${len}`
  p.style.strokeDashoffset = `${len}`
  tip.setAttribute('fill', color)
  tip.style.setProperty('--c', color)
  tip.style.opacity = '1'
  const dur = Math.max(320, Math.min(950, len * 1.15))
  const t0 = performance.now()
  return new Promise((resolve) => {
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / dur)
      const k = ease(t)
      p.style.strokeDashoffset = `${len * (1 - k)}`
      const at = p.getPointAtLength(len * k)
      tip.setAttribute('cx', at.x.toFixed(1))
      tip.setAttribute('cy', at.y.toFixed(1))
      if (t < 1) nextFrame(frame)
      else {
        p.style.strokeDasharray = 'none'
        resolve()
      }
    }
    nextFrame(frame)
  })
}

function badge(r: Ring, n: number, color: string) {
  const x = r.cx - r.rx * 0.72
  const y = r.cy - r.ry * 0.72
  const g = el('g', { class: 'badge', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` })
  el('circle', { r: 14, fill: color }, g)
  const t = el('text', { 'text-anchor': 'middle', dy: '0.36em' }, g)
  t.textContent = String(n)
  reveal(g, 260, 'pop')
}

function label(r: Ring, text: string, color: string) {
  const below = r.cy + r.ry + 46 < data.h
  const y = below ? r.cy + r.ry + 30 : r.cy - r.ry - 18
  const x = Math.max(80, Math.min(data.w - 80, r.cx))
  const t = el('text', { x: x.toFixed(1), y: y.toFixed(1), class: 'note', 'text-anchor': 'middle', fill: color })
  t.textContent = text
  reveal(t, 450, 'write')
  return { x, y }
}

async function play() {
  const rings = data.steps.map((s) => ringFor(s.box))
  if (data.title) {
    const t = el('text', { x: data.w / 2, y: 84, class: 'title', 'text-anchor': 'middle' })
    t.textContent = data.title
    reveal(t, 450, 'write')
  }
  for (let i = 0; i < rings.length; i++) {
    const color = COLORS[i % COLORS.length]
    if (i > 0) {
      const a = arrowPaths(rings[i - 1], rings[i], i % 2 ? 1 : -1)
      await draw(a.body, color, 4)
      await draw(a.head, color, 4)
    }
    await draw(ringPath(rings[i]), color, 5)
    badge(rings[i], i + 1, color)
    label(rings[i], data.steps[i].label, color)
    await wait(260)
  }
  const last = rings[rings.length - 1]
  if (last) {
    // A quick check mark and "Done!" next to the final step.
    const x = Math.min(data.w - 120, last.cx + last.rx + 22)
    const y = Math.max(40, last.cy - last.ry - 6)
    await draw(`M${x},${y + 14} Q${x + 7},${y + 20} ${x + 12},${y + 28} Q${x + 22},${y + 6} ${x + 42},${y - 10}`, '#3ddc97', 5.5)
    const t = el('text', { x: x + 50, y: y + 18, class: 'note done', fill: '#3ddc97' })
    t.textContent = 'Done!'
    reveal(t, 400, 'write')
  }
  if (data.next) {
    const t = el('text', { x: data.w / 2, y: data.h - 70, class: 'next', 'text-anchor': 'middle' })
    t.textContent = `Then: ${data.next}`
    reveal(t, 500, 'write')
  }
  tip.style.opacity = '0'
}

/* -------------------------------------------------------------- "Got it" */

const btn = document.createElement('button')
btn.type = 'button'
btn.className = 'got-it'
btn.textContent = 'Got it ✕'
btn.setAttribute('aria-label', 'Close the drawing')
btn.addEventListener('click', () => void shellCall('guide.close').catch(() => window.close()))
document.body.appendChild(btn)
let inside = false
window.addEventListener('mousemove', (e) => {
  const over = (e.target as Element | null)?.closest?.('.got-it') != null
  if (over === inside) return
  inside = over
  void shellCall('guide.setInteractive', { interactive: over }).catch(() => undefined)
})

void play()
