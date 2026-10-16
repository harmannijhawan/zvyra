import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Island, MediaCard, Words } from '../components/Island'
import { CheckIcon, MicIcon } from '../components/icons'
import type { CompanionState } from '../components/Pet'
import { useInView, useReducedMotion, useReveal } from '../lib/motion'

/** The four flows from the app's own onboarding tour (Onboarding.tsx FEATURES). */
const FLOWS: {
  id: string
  name: string
  say: string
  caption: string
  state: CompanionState
  status: string
}[] = [
  {
    id: 'talk',
    name: 'Just talk',
    say: '“Hey Zvyra, play some lofi on YouTube”',
    caption: 'Natural voice conversations, music and media control. Interrupt any time.',
    state: 'speaking',
    status: 'Playing on YouTube'
  },
  {
    id: 'research',
    name: 'Research',
    say: '“Find the best budget laptops this year”',
    caption: 'Searches the live web and lays the sources out as cards in the Dynamic Island.',
    state: 'thinking',
    status: 'Researching the live web'
  },
  {
    id: 'build',
    name: 'Build',
    say: '“Build me an e-commerce site for sneakers”',
    caption: 'A builder agent plans it, writes every file, tests the page and opens it while you keep talking.',
    state: 'executing',
    status: 'Building in the background'
  },
  {
    id: 'see',
    name: 'See',
    say: '“Open my camera, what am I holding?”',
    caption: 'A live camera preview in the island, and ZVYRA describes what it sees.',
    state: 'listening',
    status: 'Camera on'
  }
]

function FlowBody({ id }: { id: string }) {
  switch (id) {
    case 'talk':
      return <MediaCard />
    case 'research':
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
    case 'build':
      return (
        <ol className="card-steps">
          {['Plan the site', 'Write every file', 'Test the page', 'Open the result'].map((s, i) => (
            <li key={s} style={{ ['--i' as string]: i }}>
              <span className="card-steps__tick"><CheckIcon size={11} /></span>
              {s}
            </li>
          ))}
        </ol>
      )
    default:
      return (
        <div className="card-cam">
          <span className="card-cam__frame"><i /><i /><i /><i /></span>
          <span className="card-cam__obj" />
          <span className="card-cam__live">LIVE</span>
        </div>
      )
  }
}

export function Experience() {
  const [active, setActive] = useState(0)
  const [touched, setTouched] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const inView = useInView(stageRef)
  const rm = useReducedMotion()
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const reveal = useReveal<HTMLDivElement>()

  useEffect(() => {
    if (rm || touched || !inView) return
    const t = window.setTimeout(() => setActive((a) => (a + 1) % FLOWS.length), 5200)
    return () => window.clearTimeout(t)
  }, [active, rm, touched, inView])

  const pick = (i: number, focus = false) => {
    setTouched(true)
    setActive(i)
    if (focus) tabs.current[i]?.focus()
  }

  const onKey = (e: KeyboardEvent) => {
    const n = FLOWS.length
    const map: Record<string, number> = { ArrowRight: (active + 1) % n, ArrowDown: (active + 1) % n, ArrowLeft: (active - 1 + n) % n, ArrowUp: (active - 1 + n) % n, Home: 0, End: n - 1 }
    if (e.key in map) {
      e.preventDefault()
      pick(map[e.key], true)
    }
  }

  const f = FLOWS[active]

  return (
    <section className="section exp" id="how" aria-labelledby="how-title">
      <div className="section__head reveal" ref={reveal}>
        <p className="eyebrow">How it works</p>
        <h2 id="how-title" className="section__title">
          Ask out loud. <span className="soft">Watch it happen.</span>
        </h2>
        <ol className="exp__steps">
          <li><span className="exp__num"><MicIcon /></span>Say “Hey Zvyra”</li>
          <li><span className="exp__num">2</span>Talk naturally</li>
          <li><span className="exp__num">3</span>Say “go to sleep” when you’re done</li>
        </ol>
      </div>

      <div className="exp__grid">
        <div className="exp__tabs" role="tablist" aria-label="ZVYRA in action" aria-orientation="vertical" onKeyDown={onKey}>
          {FLOWS.map((fl, i) => (
            <button
              key={fl.id}
              ref={(el) => {
                tabs.current[i] = el
              }}
              role="tab"
              id={`tab-${fl.id}`}
              aria-selected={i === active}
              aria-controls="exp-panel"
              tabIndex={i === active ? 0 : -1}
              className={`exp__tab${i === active ? ' is-on' : ''}${i === active && !touched && !rm ? ' is-auto' : ''}`}
              onClick={() => pick(i)}
            >
              <span className="exp__tab-name">{fl.name}</span>
              <span className="exp__tab-say">{fl.say}</span>
              <span className="exp__tab-progress" aria-hidden="true"><i key={`${active}-${inView}`} /></span>
            </button>
          ))}
        </div>

        <div className="exp__stage" ref={stageRef} id="exp-panel" role="tabpanel" aria-labelledby={`tab-${f.id}`}>
          <div className="exp__glow" aria-hidden="true" />
          <div className="exp__screen" aria-hidden="true">
            <div className="exp__desk">
              <span className="exp__dwin exp__dwin--a"><i /><i /><i /></span>
              <span className="exp__dwin exp__dwin--b"><i /><i /></span>
            </div>
            <div className="exp__island" key={f.id}>
              <Island
                state={f.state}
                title={<Words text={f.say} />}
                subtitle={
                  <span className="exp__status">
                    <span className="exp__status-a">Listening…</span>
                    <span className="exp__status-b">{f.status}</span>
                  </span>
                }
                expanded
              >
                <FlowBody id={f.id} />
              </Island>
            </div>
            <div className="exp__taskbar"><i /><i /><i /><i /></div>
          </div>
          <p className="exp__caption" key={`c-${f.id}`}>{f.caption}</p>
        </div>
      </div>
    </section>
  )
}
