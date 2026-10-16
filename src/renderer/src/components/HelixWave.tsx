/**
 * ZVYRA voice meter: a row of rounded bars whose height follows the REAL audio
 * level (microphone while listening, ZVYRA's own output while speaking).
 *
 * Replaces the old canvas "plasma helix": that ran a requestAnimationFrame loop
 * forever (even while idle), threw off sparks, cycled through rainbow tones and
 * re-seeded its phase with Math.random() every time the voice state changed,
 * which made it visibly jump on each listen → think → speak transition.
 * This version has no loop at all: it only re-renders when a new level arrives
 * (~15 Hz) and eases between values with a short CSS transition.
 */
import { memo } from 'react'

type Tone = 'listen' | 'speak' | 'think'

interface Props {
  level: number
  active: boolean
  width: number
  height: number
  tone?: Tone
  className?: string
}

// Gentle centre-weighted profile so the meter reads as a voice, not a bar chart.
const PROFILE = [0.42, 0.62, 0.82, 1, 0.9, 0.7, 0.55, 0.78, 0.95, 0.68, 0.5, 0.38]

function HelixWaveImpl({ level, active, width, height, tone = 'listen', className }: Props) {
  const bars = Math.max(4, Math.min(24, Math.round(width / 7)))
  const lvl = active ? Math.max(0, Math.min(1, level)) : 0
  const min = Math.max(2, Math.round(height * 0.12))
  return (
    <div className={`zv-meter t-${tone} ${active ? 'on' : ''} ${className ?? ''}`} style={{ width, height }} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => {
        const p = PROFILE[i % PROFILE.length]
        const h = Math.round(min + (height - min) * Math.min(1, lvl * 1.5) * p)
        return <i key={i} style={{ height: h }} />
      })}
    </div>
  )
}

export const HelixWave = memo(HelixWaveImpl)
