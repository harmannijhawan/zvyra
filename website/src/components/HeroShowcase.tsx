import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { prefersReducedMotion, useReducedMotion } from '../lib/motion'
import { ZMark } from './brand'
import { MediaCard, Wave, Words } from './Island'
import { Pet, type CompanionState } from './Pet'
import { CheckIcon, WindowsIcon } from './icons'

/* ─────────────────────────────────────────────────────────────────────────
   Hero product stage: a PC desktop (sky wallpaper, drifting clouds, glass
   taskbar) with the ZVYRA Dynamic Island at the top. The island runs real
   features one after another: live transcript → answer card, and a matching
   window animates onto the desktop. The screen tilts back and flattens as
   you scroll.
   ───────────────────────────────────────────────────────────────────────── */

type Scene = 'media' | 'browser' | 'code' | 'none' | 'terminal'
type Feature = {
  ask: string
  done: string
  sub: string
  state: CompanionState
  scene: Scene
  app: number
  body: () => ReactNode
}

function Sources() {
  return (
    <div className="card-sources">
      {[0, 1, 2].map((i) => (
        <span className="card-sources__item" key={i} style={{ ['--i' as string]: i }}>
          <i className="fav" />
          <i style={{ width: '86%' }} />
          <i style={{ width: '62%' }} />
        </span>
      ))}
    </div>
  )
}
function Steps() {
  return (
    <ol className="card-steps card-steps--live">
      {['Plan the site', 'Write every file', 'Test the page', 'Open the result'].map((s, i) => (
        <li key={s} style={{ ['--i' as string]: i }}>
          <span className="card-steps__tick"><CheckIcon size={11} /></span>
          {s}
        </li>
      ))}
    </ol>
  )
}
function Timer() {
  return (
    <div className="card-timer">
      <svg viewBox="0 0 44 44" className="card-timer__ring" aria-hidden="true">
        <circle cx="22" cy="22" r="19" />
        <circle cx="22" cy="22" r="19" className="run" pathLength={1} />
      </svg>
      <span className="card-timer__txt">
        <b>10:00</b>
        <span>Timer started</span>
      </span>
    </div>
  )
}
function SystemCard() {
  return (
    <div className="card-sys">
      {([['CPU', 0.34], ['Memory', 0.58], ['Battery', 0.86], ['Disk', 0.47]] as const).map(([k, v], i) => (
        <span key={k} style={{ ['--v' as string]: v, ['--i' as string]: i }}>
          <em>{k}</em>
          <i />
        </span>
      ))}
    </div>
  )
}
function Permission() {
  return (
    <div className="card-perm">
      <code>Get-ChildItem ~\Downloads -Filter *.zip</code>
      <span className="card-perm__btns">
        <span>Deny</span>
        <span className="ok">Allow</span>
      </span>
    </div>
  )
}

/** Each maps to a real tool in the desktop app. `app` = taskbar slot that lights up. */
const FEATURES: Feature[] = [
  { ask: '“Hey Zvyra, play some lofi on YouTube”', done: 'Playing lofi on YouTube', sub: 'Talk any time to interrupt', state: 'speaking', scene: 'media', app: 2, body: () => <MediaCard /> },
  { ask: '“Find the best budget laptops this year”', done: 'Researching the live web', sub: 'Sources appear as cards', state: 'thinking', scene: 'browser', app: 3, body: Sources },
  { ask: '“Build me an e-commerce site for sneakers”', done: 'Builder agent at work', sub: 'Keeps going while you talk', state: 'executing', scene: 'code', app: 4, body: Steps },
  { ask: '“Set a timer for ten minutes”', done: 'Timer set', sub: 'I’ll let you know', state: 'completed', scene: 'none', app: 1, body: Timer },
  { ask: '“How’s my PC doing?”', done: 'System status', sub: 'CPU, memory, battery, disk', state: 'speaking', scene: 'none', app: 1, body: SystemCard },
  { ask: '“Find the zip files in my Downloads”', done: 'Run this command?', sub: 'Commands always ask first', state: 'waiting_permission', scene: 'terminal', app: 5, body: Permission }
]

/** Deterministic cloud + mote layout (no Math.random → stable renders). */
const CLOUDS = [
  { l: -8, t: 52, w: 46, d: 90, o: 0.9 },
  { l: 30, t: 62, w: 58, d: 120, o: 0.75 },
  { l: 64, t: 46, w: 40, d: 100, o: 0.85 },
  { l: 8, t: 74, w: 70, d: 140, o: 0.6 }
]
const MOTES = Array.from({ length: 12 }, (_, i) => ({
  l: (i * 53 + 7) % 100,
  t: 18 + ((i * 29) % 60),
  s: 2 + ((i * 7) % 4),
  dl: -((i * 1.9) % 12),
  du: 12 + ((i * 5) % 9)
}))

function useScrollFlatten(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) {
      el.style.setProperty('--p', '1')
      return
    }
    let raf = 0
    const update = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      const p = Math.min(1, Math.max(0, (innerHeight * 0.85 - r.top) / (innerHeight * 0.65)))
      el.style.setProperty('--p', p.toFixed(4))
    }
    const on = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    addEventListener('scroll', on, { passive: true })
    addEventListener('resize', on)
    return () => {
      removeEventListener('scroll', on)
      removeEventListener('resize', on)
      cancelAnimationFrame(raf)
    }
  }, [ref])
}

/** A window that animates onto the desktop for the current feature. */
function DesktopWindow({ scene }: { scene: Scene }) {
  if (scene === 'none') return null
  return (
    <div className={`dwin dwin--${scene}`} key={scene}>
      <div className="dwin__bar">
        <span className="dwin__dots"><i /><i /><i /></span>
        <span className="dwin__title">
          {scene === 'media' && 'YouTube'}
          {scene === 'browser' && 'Browser'}
          {scene === 'code' && 'sneaker-store'}
          {scene === 'terminal' && 'PowerShell'}
        </span>
      </div>
      <div className="dwin__body">
        {scene === 'media' && (
          <>
            <span className="dwin__video"><b /></span>
            <span className="dwin__line" style={{ width: '70%' }} />
            <span className="dwin__line" style={{ width: '45%' }} />
          </>
        )}
        {scene === 'browser' && (
          <>
            <span className="dwin__url" />
            {[0, 1, 2, 3].map((i) => (
              <span className="dwin__result" key={i} style={{ ['--i' as string]: i }}>
                <i /><i /><i />
              </span>
            ))}
          </>
        )}
        {scene === 'code' && (
          <div className="dwin__split">
            <div className="dwin__code">
              {[78, 54, 66, 40, 72, 48, 60, 36].map((w, i) => (
                <i key={i} style={{ width: `${w}%`, ['--i' as string]: i }} />
              ))}
            </div>
            <div className="dwin__site">
              <span className="dwin__hero" />
              <span className="dwin__grid"><i /><i /><i /></span>
            </div>
          </div>
        )}
        {scene === 'terminal' && (
          <div className="dwin__term">
            <span>PS C:\Users\you&gt; <em>Get-ChildItem ~\Downloads -Filter *.zip</em></span>
            <span className="dwin__wait">Waiting for your approval…</span>
          </div>
        )}
      </div>
    </div>
  )
}

export function HeroShowcase() {
  const ref = useRef<HTMLDivElement>(null)
  useScrollFlatten(ref)
  const rm = useReducedMotion()
  const [i, setI] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'listen' | 'open'>(rm ? 'open' : 'idle')

  // idle (wake word standby, first loop only) → listen (live transcript) → open (answer + window) → next
  useEffect(() => {
    if (rm) {
      setPhase('open')
      return
    }
    const hold = phase === 'idle' ? 2200 : phase === 'listen' ? 2400 : 4000
    const t = window.setTimeout(() => {
      if (phase === 'idle') setPhase('listen')
      else if (phase === 'listen') setPhase('open')
      else {
        setI((n) => (n + 1) % FEATURES.length)
        setPhase('listen')
      }
    }, hold)
    return () => window.clearTimeout(t)
  }, [phase, rm])

  const f = FEATURES[i]
  const open = phase === 'open'
  const pet: CompanionState = phase === 'idle' ? 'idle' : open ? f.state : 'listening'

  return (
    <div className="stage" ref={ref} aria-hidden="true">
      <div className="stage__glow" />
      <div className="screen">
        <div className="screen__wall">
          <span className="screen__sun" />
          {CLOUDS.map((c, n) => (
            <span
              key={n}
              className="cloud"
              style={{ left: `${c.l}%`, top: `${c.t}%`, width: `${c.w}%`, opacity: c.o, animationDuration: `${c.d}s`, animationDelay: `${-n * 17}s` }}
            />
          ))}
          {MOTES.map((m, n) => (
            <i
              key={n}
              className="mote"
              style={{ left: `${m.l}%`, top: `${m.t}%`, width: m.s, height: m.s, animationDelay: `${m.dl}s`, animationDuration: `${m.du}s` }}
            />
          ))}
        </div>

        {/* desktop windows for the active feature */}
        <div className="screen__desk">{open && <DesktopWindow scene={f.scene} />}</div>

        {/* Dynamic Island */}
        <div className="hisland" data-open={open} data-phase={phase}>
          <div className="hisland__row">
            <span className="island__mark"><ZMark size={20} /></span>
            <Pet state={pet} size={34} label="" />
            <span className="island__copy" key={`${i}-${phase}`}>
              {phase === 'idle' && (
                <>
                  <span className="island__title swap">How can I help?</span>
                  <span className="island__sub swap">Listening for “Hey Zvyra”</span>
                </>
              )}
              {phase === 'listen' && (
                <>
                  <span className="island__title"><Words text={f.ask} delay={0.15} /></span>
                  <span className="island__sub swap">Listening…</span>
                </>
              )}
              {open && (
                <>
                  <span className="island__title swap">{f.done}</span>
                  <span className="island__sub swap">{f.sub}</span>
                </>
              )}
            </span>
            {phase === 'idle' ? <span className="island__chip">“Hey Zvyra” on</span> : <Wave bars={12} live />}
          </div>
          <div className="hisland__body">
            <div className="hisland__inner" key={i}>{f.body()}</div>
          </div>
        </div>

        {/* Windows taskbar */}
        <div className="taskbar">
          <span className="taskbar__start"><WindowsIcon size={14} /></span>
          <span className={`taskbar__app taskbar__app--z${phase !== 'idle' ? ' is-on' : ''}`}><ZMark size={16} /></span>
          {[2, 3, 4, 5].map((slot) => (
            <span key={slot} className={`taskbar__app${open && f.app === slot ? ' is-on' : ''}`} />
          ))}
        </div>
      </div>
    </div>
  )
}
