/**
 * Audio waveform. When `active`, bar amplitude follows the real microphone
 * level from `voice.level`. When `ambient`, it shows a slow, low idle shimmer
 * (used for standby / speaking). Otherwise bars rest flat.
 */
import { memo } from 'react'

const PROFILE = [0.32, 0.55, 0.78, 1, 0.7, 0.92, 0.6, 0.42, 0.28]

interface Props {
  level?: number
  mode: 'off' | 'ambient' | 'active' | 'speaking'
  bars?: number
  height?: number
  className?: string
}

function WaveformImpl({ level = 0, mode, bars = 9, height = 26, className }: Props) {
  const amp = mode === 'active' ? 0.22 + Math.min(1, level * 1.6) * 0.78 : mode === 'speaking' ? 0.75 : mode === 'ambient' ? 0.45 : 0.32
  return (
    <div
      className={`waveform ${mode} ${className ?? ''}`}
      style={{ height, ['--amp' as string]: amp.toFixed(3) }}
      aria-hidden="true"
    >
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} style={{ ['--p' as string]: PROFILE[i % PROFILE.length], animationDelay: `${(i * 97) % 600}ms` }} />
      ))}
    </div>
  )
}

export const Waveform = memo(WaveformImpl)
