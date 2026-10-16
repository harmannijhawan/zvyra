/**
 * ZVYRA brand marks (2026 identity): a glossy blue ribbon "Z" that folds
 * through itself, and the rounded lowercase "zvyra" wordmark.
 * Vector redraw of the brand artwork so it stays crisp at every size.
 * Kept in sync with src/renderer/src/components/brand.tsx in the desktop app.
 */
import { useId } from 'react'

export const Z_OUTLINE =
  'M3.6 43.6C1.1 21.3 7.4 3.2 28.7 1.1H84C95 1.1 99 10 93 19L41.5 68.1C62.8 57.4 86.2 54.3 97.2 57C100 68.1 92.6 89.4 75.5 93.6H20.2C4 94.7-1 84 6 76L58.5 19.1C35.1 19.1 11.7 27.7 3.6 43.6Z'
/** Light sliver along the underside of the top fold. */
export const Z_TOP_SHEEN = 'M3.6 43.6C11.7 27.7 35.1 19.1 58.5 19.1L63.5 13.8C36 13.6 11 23 3.6 43.6Z'
/** Light sliver along the top of the bottom fold. */
export const Z_BOTTOM_SHEEN = 'M41.5 68.1C62.8 57.4 86.2 54.3 97.2 57C84 52.6 60 55.5 47.2 62.6Z'
/** Shadow where the diagonal passes under the top fold. */
export const Z_FOLD = 'M58.5 19.1L93 19C88 27 70 31 52 26Z'

export function ZMark({ size = 28, className, glow = false }: { size?: number; className?: string; glow?: boolean }) {
  const u = useId().replace(/:/g, '')
  return (
    <svg className={className} width={size} height={size * 0.96} viewBox="-3 -3 106 102" aria-hidden="true" overflow="visible">
      <defs>
        <linearGradient id={`zf-${u}`} x1="0.05" y1="0" x2="0.95" y2="1">
          <stop offset="0" stopColor="#8fdcff" />
          <stop offset="0.32" stopColor="#3f93ff" />
          <stop offset="0.66" stopColor="#2b62f5" />
          <stop offset="1" stopColor="#b7a6ff" />
        </linearGradient>
        <radialGradient id={`zh-${u}`} cx="0.22" cy="0.12" r="0.75">
          <stop offset="0" stopColor="#fff" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`zs-${u}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#e9fbff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#bfe6ff" stopOpacity="0.15" />
        </linearGradient>
        <linearGradient id={`zr-${u}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="0.5" stopColor="#d8e8ff" stopOpacity="0.25" />
          <stop offset="1" stopColor="#e6dcff" stopOpacity="0.7" />
        </linearGradient>
        {glow && (
          <filter id={`zg-${u}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b" />
            <feFlood floodColor="#3b7bff" floodOpacity="0.75" />
            <feComposite in2="b" operator="in" result="g" />
            <feMerge>
              <feMergeNode in="g" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>
      <g filter={glow ? `url(#zg-${u})` : undefined}>
        <path d={Z_OUTLINE} fill={`url(#zf-${u})`} />
        <path d={Z_FOLD} fill="#1630b8" opacity="0.35" />
        <path d={Z_TOP_SHEEN} fill={`url(#zs-${u})`} />
        <path d={Z_BOTTOM_SHEEN} fill={`url(#zs-${u})`} opacity="0.85" />
        <path d={Z_OUTLINE} fill={`url(#zh-${u})`} />
        <path d={Z_OUTLINE} fill="none" stroke={`url(#zr-${u})`} strokeWidth="1.4" />
      </g>
    </svg>
  )
}

/** Rounded lowercase "zvyra" wordmark; uses currentColor. */
export function Wordmark({ height = 16, className }: { height?: number; className?: string }) {
  return (
    <svg className={className} height={height} viewBox="0 6 170 50" aria-label="ZVYRA" role="img">
      <g fill="none" stroke="currentColor" strokeWidth="7.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 16H29L5 41H30" />
        <path d="M40 16 53 41 66 16" />
        <path d="M76 16 89 40M102 16 85 52" />
        <path d="M113 41V16M113 28Q115 16 128 16" />
        <circle cx="148" cy="28.5" r="12.5" />
        <path d="M160.5 16V41" />
      </g>
    </svg>
  )
}

/** Mark + wordmark, no container chip. */
export function Brand({ wordHeight = 16, markSize = 30 }: { wordHeight?: number; markSize?: number }) {
  return (
    <span className="brand">
      <ZMark size={markSize} className="brand-mark" />
      <Wordmark height={wordHeight} className="brand-word" />
    </span>
  )
}
