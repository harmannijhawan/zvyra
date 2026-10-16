import type { MouseEvent, PointerEvent, ReactNode } from 'react'
import { DOWNLOADS, formatBytes, isDownloadable, type PlatformDownload, type PlatformId } from '../config/downloads'
import { AppleIcon, PhoneIcon, WindowsIcon } from './icons'

const ICONS: Record<PlatformId, (p: { size?: number }) => ReactNode> = {
  windows: WindowsIcon,
  macos: AppleIcon,
  ios: PhoneIcon
}

interface Props {
  platform: PlatformId
  /** Makes ids unique when the same platform appears several times. */
  context: string
  /** glass = clear Liquid Glass pill, dark = solid ink pill, quiet = inline text. */
  variant?: 'glass' | 'dark' | 'quiet'
  size?: 'sm' | 'lg'
  /** Override the visible label (e.g. "Download" in the nav). */
  label?: string
  showMeta?: boolean
  recommended?: boolean
}

/** Specular highlight follows the pointer across the glass. */
function track(e: PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--mx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`)
  e.currentTarget.style.setProperty('--my', `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`)
}

/**
 * Every download CTA on the site. Reads only from src/config/downloads.ts:
 * a real <a download> when the platform is downloadable, otherwise a focusable,
 * aria-disabled button that explains the status and never navigates.
 */
export function DownloadButton({ platform, context, variant = 'glass', size = 'lg', label, showMeta, recommended }: Props) {
  const p = DOWNLOADS[platform] as PlatformDownload
  const Icon = ICONS[platform]
  const text = label ?? p.ctaLabel
  const noteId = `${context}-${platform}-note`
  const iconSize = size === 'sm' ? 15 : 18

  if (isDownloadable(p)) {
    const self = p.url.startsWith('/')
    const meta = [p.format, p.sizeBytes ? formatBytes(p.sizeBytes) : null].filter(Boolean).join(' · ')
    const aria = `${p.ctaLabel}${recommended ? ' (recommended for this PC)' : ''}${meta ? `, ${meta.replace(' · ', ', ')}` : ''}`
    return (
      <a
        className={`dl dl--${variant} dl--${size} dl--live`}
        href={p.url}
        download={self ? (p.fileName ?? true) : undefined}
        rel={self ? undefined : 'noopener'}
        aria-label={aria}
        data-platform={platform}
        onPointerMove={variant === 'glass' ? track : undefined}
      >
        <span className="dl__icon"><Icon size={iconSize} /></span>
        <span className="dl__text">
          <span className="dl__label">{text}</span>
          {showMeta && meta && (
            <span className="dl__meta">
              {meta}
              {recommended && <span className="dl__rec"> · For this PC</span>}
            </span>
          )}
        </span>
      </a>
    )
  }

  const block = (e: MouseEvent) => e.preventDefault()
  return (
    <button
      type="button"
      className={`dl dl--${variant} dl--${size} dl--soon`}
      aria-disabled="true"
      aria-label={`${variant === 'quiet' ? p.name : text}${p.statusLabel ? `, ${p.statusLabel.toLowerCase()}` : ''}`}
      aria-describedby={noteId}
      onClick={block}
      onPointerMove={variant === 'glass' ? track : undefined}
      data-platform={platform}
    >
      <span className="dl__icon"><Icon size={iconSize} /></span>
      <span className="dl__text">
        <span className="dl__label">{variant === 'quiet' ? p.name : text}</span>
        {variant !== 'quiet' && size === 'lg' && p.statusLabel && <span className="dl__meta dl__meta--soon">{p.statusLabel}</span>}
      </span>
      {(variant === 'quiet' || size === 'sm') && p.statusLabel && <span className="dl__chip">{p.statusLabel}</span>}
      <span id={noteId} className="sr-only">{p.statusNote}</span>
    </button>
  )
}
