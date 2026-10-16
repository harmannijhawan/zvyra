import type { ReactNode } from 'react'
import { ZMark } from './brand'
import { Pet, type CompanionState } from './Pet'

/** Animated bar waveform (CSS only). */
export function Wave({ bars = 18, live = true }: { bars?: number; live?: boolean }) {
  return (
    <span className={`wave${live ? ' wave--live' : ''}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} style={{ animationDelay: `${(i * 97) % 900}ms`, ['--h' as string]: `${30 + ((i * 37) % 70)}%` }} />
      ))}
    </span>
  )
}

/** Transcript that appears word by word, like live speech-to-text. */
export function Words({ text, delay = 0.35 }: { text: string; delay?: number }) {
  return (
    <span className="words">
      {text.split(' ').map((w, i) => (
        <span key={i} style={{ ['--w' as string]: i, ['--wd' as string]: `${delay}s` }}>
          {w}{' '}
        </span>
      ))}
    </span>
  )
}

/** Media card shown inside the island (play_media / media_control tools). */
export function MediaCard() {
  return (
    <div className="card-media">
      <span className="card-media__art" />
      <span className="card-media__txt">
        <b>lofi on YouTube</b>
        <span>Now playing</span>
        <span className="card-media__bar"><i /></span>
      </span>
      <span className="card-media__ctl" aria-hidden="true"><i /><i className="pause" /><i /></span>
    </div>
  )
}

/**
 * Mock of the ZVYRA Dynamic Island: one dark translucent pill that morphs
 * between compact and expanded content (mirrors the app's island.css).
 */
export function Island({
  state = 'listening',
  title,
  subtitle,
  chip,
  expanded,
  children
}: {
  state?: CompanionState
  title: ReactNode
  subtitle?: ReactNode
  chip?: ReactNode
  expanded?: boolean
  children?: ReactNode
}) {
  return (
    <div className={`island${expanded ? ' island--expanded' : ''}`}>
      <div className="island__row">
        <span className="island__mark"><ZMark size={20} /></span>
        <Pet state={state} size={34} label="" />
        <span className="island__copy">
          <span className="island__title">{title}</span>
          {subtitle && <span className="island__sub">{subtitle}</span>}
        </span>
        {chip ?? <Wave bars={12} live={state === 'listening' || state === 'speaking'} />}
      </div>
      {children && <div className="island__body">{children}</div>}
    </div>
  )
}
