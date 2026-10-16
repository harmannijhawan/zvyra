/**
 * The ZVYRA companion — an original blue robot drawn in SVG and animated with
 * CSS. Its expression is driven only by the derived CompanionState; it never
 * animates "work" on its own.
 */
// Copied from the desktop app (src/renderer/src/components/Pet.tsx); CompanionState inlined.
import { memo, useId } from 'react'
import './pet.css'

export type CompanionState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'planning'
  | 'executing'
  | 'completed'
  | 'error'
  | 'offline'
  | 'dnd'
  | 'waiting_permission'

interface PetProps {
  state: CompanionState
  size?: number
  /** Microphone level 0..1, used while listening. */
  level?: number
  className?: string
  label?: string
}

function Eyes({ state }: { state: CompanionState }) {
  switch (state) {
    case 'completed':
      return (
        <g className="pet-eyes happy" fill="none" stroke="var(--pet-eye)" strokeWidth="3.4" strokeLinecap="round">
          <path d="M41 56q5-7 10 0" />
          <path d="M69 56q5-7 10 0" />
        </g>
      )
    case 'dnd':
      return (
        <g className="pet-eyes closed" fill="none" stroke="var(--pet-eye)" strokeWidth="3" strokeLinecap="round">
          <path d="M41 54q5 5 10 0" />
          <path d="M69 54q5 5 10 0" />
        </g>
      )
    case 'error':
      return (
        <g className="pet-eyes error" fill="none" stroke="var(--pet-eye)" strokeWidth="3" strokeLinecap="round">
          <path d="M42 50l8 8M50 50l-8 8" />
          <path d="M70 50l8 8M78 50l-8 8" />
        </g>
      )
    case 'offline':
      return (
        <g className="pet-eyes flat" fill="var(--pet-eye)">
          <rect x="40" y="53" width="12" height="3.4" rx="1.7" />
          <rect x="68" y="53" width="12" height="3.4" rx="1.7" />
        </g>
      )
    case 'waiting_permission':
      return (
        <g className="pet-eyes ask" fill="var(--pet-eye)">
          <rect className="pet-eye l" x="41.5" y="48" width="9" height="13" rx="4.5" />
          <rect className="pet-eye r" x="69.5" y="50" width="9" height="10" rx="4.5" />
          <path d="M66 43.5q6-3.5 13 0" fill="none" stroke="var(--pet-eye)" strokeWidth="2.4" strokeLinecap="round" />
        </g>
      )
    default:
      return (
        <g className="pet-eyes open" fill="var(--pet-eye)">
          <rect className="pet-eye l" x="41.5" y="47.5" width="9" height="14" rx="4.5" />
          <rect className="pet-eye r" x="69.5" y="47.5" width="9" height="14" rx="4.5" />
        </g>
      )
  }
}

function PetImpl({ state, size = 56, level = 0, className, label }: PetProps) {
  const uid = useId().replace(/:/g, '')
  const g = (n: string) => `${n}-${uid}`
  return (
    <div
      className={`pet ${className ?? ''}`}
      data-state={state}
      style={{ width: size, height: size, ['--lvl' as string]: Math.min(1, level).toFixed(3) }}
      role="img"
      aria-label={label ?? `ZVYRA companion: ${state.replace('_', ' ')}`}
    >
      <svg viewBox="0 0 120 120" width={size} height={size} overflow="visible">
        <defs>
          <linearGradient id={g('head')} x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0" stopColor="#7dbcff" />
            <stop offset="0.45" stopColor="#3a86ff" />
            <stop offset="1" stopColor="#1748d6" />
          </linearGradient>
          <linearGradient id={g('body')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3f8cff" />
            <stop offset="1" stopColor="#1a46c9" />
          </linearGradient>
          <linearGradient id={g('visor')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0b1a45" />
            <stop offset="1" stopColor="#050c26" />
          </linearGradient>
          <radialGradient id={g('aura')} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="var(--pet-aura)" stopOpacity="0.55" />
            <stop offset="1" stopColor="var(--pet-aura)" stopOpacity="0" />
          </radialGradient>
          <filter id={g('glow')} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle className="pet-aura" cx="60" cy="62" r="56" fill={`url(#${g('aura')})`} />
        <ellipse className="pet-shadow" cx="60" cy="114" rx="22" ry="3.5" fill="#000" opacity="0.35" />

        <g className="pet-float">
          {/* body */}
          <g className="pet-body">
            <rect x="41" y="84" width="38" height="24" rx="12" fill={`url(#${g('body')})`} />
            <rect x="47" y="85" width="26" height="6" rx="3" fill="#fff" opacity="0.14" />
            <circle className="pet-core" cx="60" cy="97" r="4" fill="var(--pet-eye)" filter={`url(#${g('glow')})`} />
          </g>

          <g className="pet-head">
            {/* antenna */}
            <path d="M60 24V12" stroke="#8fc2ff" strokeWidth="3" strokeLinecap="round" />
            <circle className="pet-antenna" cx="60" cy="10" r="4.6" fill="var(--pet-antenna)" filter={`url(#${g('glow')})`} />
            {/* ears */}
            <rect x="9.5" y="45" width="11" height="22" rx="5.5" fill="#2a63e8" />
            <rect x="99.5" y="45" width="11" height="22" rx="5.5" fill="#2a63e8" />
            {/* head */}
            <rect x="17" y="22" width="86" height="66" rx="31" fill={`url(#${g('head')})`} />
            <path d="M33 31c8-5 20-6 30-5" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.35" fill="none" />
            {/* visor */}
            <rect x="28" y="36" width="64" height="40" rx="19" fill={`url(#${g('visor')})`} />
            <rect x="28.5" y="36.5" width="63" height="39" rx="18.5" fill="none" stroke="#6fb0ff" strokeOpacity="0.25" />
            <g filter={`url(#${g('glow')})`}>
              <Eyes state={state} />
              {state === 'speaking' && <rect className="pet-mouth" x="54" y="65" width="12" height="4" rx="2" fill="var(--pet-eye)" />}
              {(state === 'idle' || state === 'listening') && (
                <path className="pet-smile" d="M55 66q5 3.5 10 0" fill="none" stroke="var(--pet-eye)" strokeWidth="2.2" strokeLinecap="round" />
              )}
            </g>
          </g>
        </g>

        {/* state accents */}
        {state === 'thinking' && (
          <g className="pet-thought" fill="var(--pet-eye)">
            <circle cx="98" cy="22" r="2.4" />
            <circle cx="105" cy="14" r="3" />
            <circle cx="113" cy="5" r="3.6" />
          </g>
        )}
        {state === 'planning' && (
          <g className="pet-plan" fill="none" stroke="var(--pet-eye)" strokeWidth="2.4" strokeLinecap="round">
            <path d="M98 14h12M98 21h8M98 28h11" />
          </g>
        )}
        {state === 'listening' && (
          <g className="pet-ears-wave" fill="none" stroke="var(--pet-eye)" strokeWidth="2.4" strokeLinecap="round">
            <path className="w1" d="M4 50q-4 6 0 12" />
            <path className="w2" d="M-2 46q-6 10 0 20" />
            <path className="w1" d="M116 50q4 6 0 12" />
            <path className="w2" d="M122 46q6 10 0 20" />
          </g>
        )}
        {state === 'completed' && (
          <g className="pet-sparkle" fill="#bfefff">
            <path d="M100 18l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
            <path d="M18 14l1.4 3.4 3.4 1.4-3.4 1.4L18 23.6l-1.4-3.4-3.4-1.4 3.4-1.4z" />
          </g>
        )}
        {state === 'dnd' && (
          <text className="pet-z" x="98" y="20" fill="#a9c4ff" fontSize="14" fontWeight="700" fontFamily="var(--font)">
            z
          </text>
        )}
        {state === 'waiting_permission' && (
          <text className="pet-q" x="99" y="22" fill="#ffd896" fontSize="18" fontWeight="800" fontFamily="var(--font)">
            ?
          </text>
        )}
      </svg>
    </div>
  )
}

export const Pet = memo(PetImpl)
