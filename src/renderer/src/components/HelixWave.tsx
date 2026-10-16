/**
 * ZVYRA “Plasma Helix” — the assistant's own voice visual.
 *
 * Two strands of light twist around a glowing energy core in pseudo-3D:
 * depth drives each bead's size and brightness, the voice level widens the
 * helix and speeds up the twist (no spark particles). Beads are pre-rendered
 * glow sprites blended additively, so it stays smooth at 60 fps.
 * Idle: a slow, small helix at 30 fps. Reduced motion: one still frame.
 */
import { useEffect, useRef } from 'react'

type Tone = 'listen' | 'speak' | 'think'

interface Props {
  level: number
  active: boolean
  width: number
  height: number
  tone?: Tone
  className?: string
}

type RGB = [number, number, number]

const TONES: Record<Tone, { a: RGB; b: RGB; spark: RGB; speed: number; turns: number }> = {
  listen: { a: [64, 214, 255], b: [96, 112, 255], spark: [200, 244, 255], speed: 2.4, turns: 1.7 },
  speak: { a: [0, 255, 196], b: [182, 92, 255], spark: [255, 222, 140], speed: 3.7, turns: 2.1 },
  think: { a: [146, 120, 255], b: [255, 104, 200], spark: [228, 206, 255], speed: 1.4, turns: 2.7 }
}

const rgb = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

function glowSprite(c: RGB, size = 64) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')!
  const r = size / 2
  const grd = g.createRadialGradient(r, r, 0, r, r, r)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.16, rgb(c, 0.95))
  grd.addColorStop(0.42, rgb(c, 0.3))
  grd.addColorStop(1, rgb(c, 0))
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  return cv
}


export function HelixWave({ level, active, width, height, tone = 'listen', className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const levelRef = useRef(level)
  levelRef.current = level
  const phase = useRef(0)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    const T = TONES[tone]
    const spA = glowSprite(T.a)
    const spB = glowSprite(T.b)
    const pad = Math.max(3, height * 0.14)
    const usable = width - pad * 2
    const mid = height / 2
    const n = Math.max(9, Math.round(width / 6.5))
    const base = Math.max(2.2, height * 0.15)
    const beam = ctx.createLinearGradient(pad, 0, width - pad, 0)
    beam.addColorStop(0, rgb(T.a, 0))
    beam.addColorStop(0.3, rgb(T.a, 1))
    beam.addColorStop(0.7, rgb(T.b, 1))
    beam.addColorStop(1, rgb(T.b, 0))

    let amp = active ? 0.5 : 0.22
    let energy = 0
    // Continue from the previous phase: a fresh random phase on every voice-state change made the helix jump.
    let t = phase.current
    let raf = 0
    let last = performance.now() - 34

    const paint = (dt: number) => {
      const lvl = levelRef.current
      const target = active ? Math.min(1.2, 0.34 + lvl * 1.7) : 0.22
      amp += (target - amp) * Math.min(1, dt * 7)
      energy += ((active ? lvl : 0) - energy) * Math.min(1, dt * 10)
      t += dt * T.speed * (active ? 0.75 + amp * 0.55 : 0.35)

      ctx.globalCompositeOperation = 'source-over'
      ctx.clearRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'lighter'

      // energy core
      const coreH = Math.max(1, height * (0.03 + energy * 0.05))
      ctx.globalAlpha = 0.12 + energy * 0.22
      ctx.fillStyle = beam
      ctx.fillRect(pad, mid - coreH / 2, usable, coreH)

      const R = (height / 2 - pad * 0.55) * Math.min(1, amp)
      const rungW = Math.max(0.6, height * 0.018)
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1)
        const env = Math.pow(Math.sin(Math.PI * k), 0.85)
        const breathe = 1 + 0.2 * Math.sin(t * 0.9 + k * 6.2)
        const ph = k * Math.PI * 2 * T.turns - t
        const x = pad + k * usable
        const ya = mid + Math.sin(ph) * R * env * breathe
        const yb = mid - Math.sin(ph) * R * env * breathe
        // rungs between the strands
        if (i % 3 === 0 && env > 0.2) {
          ctx.globalAlpha = (0.05 + energy * 0.15) * env
          ctx.strokeStyle = 'rgba(255,255,255,1)'
          ctx.lineWidth = rungW
          ctx.beginPath()
          ctx.moveTo(x, ya)
          ctx.lineTo(x, yb)
          ctx.stroke()
        }
        for (let s = 0; s < 2; s++) {
          const z = (Math.cos(ph + s * Math.PI) + 1) / 2 // 0 = back, 1 = front
          const size = base * (0.45 + z * 0.75) * (0.45 + env * 0.6) * (1 + energy * 0.35)
          ctx.globalAlpha = (0.18 + z * 0.62) * (0.3 + env * 0.7)
          ctx.drawImage(s ? spB : spA, x - size, (s ? yb : ya) - size, size * 2, size * 2)
        }
      }

      phase.current = t
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    const reduced = () => document.body.classList.contains('reduce-motion')
    const frame = (now: number) => {
      if (reduced()) {
        paint(0.016)
        return
      }
      raf = requestAnimationFrame(frame)
      if (!active && now - last < 33) return // idle: ~30 fps is plenty
      const dt = Math.min(64, now - last) / 1000
      last = now
      paint(dt)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [active, width, height, tone])

  return <canvas ref={ref} className={className} style={{ width, height, display: 'block' }} aria-hidden="true" />
}
