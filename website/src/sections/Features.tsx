import type { ReactNode } from 'react'
import { Wave } from '../components/Island'
import { ZMark } from '../components/brand'
import { CheckIcon, MicIcon } from '../components/icons'
import { useReveal } from '../lib/motion'

/**
 * Everything ZVYRA can do, each with its own small looping animation.
 * Every tile maps to a real capability in the desktop app (see
 * website/.agents/tasks/investigation.md §3 for sources).
 */
type Tile = { id: string; title: string; body: string; span?: 'wide' | 'tall' | 'big'; art: ReactNode }

const TILES: Tile[] = [
  {
    id: 'wake',
    span: 'big',
    title: 'Just say “Hey Zvyra”',
    body: 'The wake word is spotted on your PC, so it’s ready the moment you call. Teach it your voice in onboarding; the samples stay on your PC.',
    art: (
      <div className="a-wake">
        <span className="a-wake__ring" />
        <span className="a-wake__ring" style={{ animationDelay: '-1s' }} />
        <span className="a-wake__ring" style={{ animationDelay: '-2s' }} />
        <span className="a-wake__core"><MicIcon size={26} /></span>
        <span className="a-wake__bubble">“Hey Zvyra”</span>
        <span className="a-wake__wave"><Wave bars={22} /></span>
      </div>
    )
  },
  {
    id: 'talk',
    span: 'wide',
    title: 'Talks back, naturally',
    body: 'Real two-way voice conversations powered by Gemini Live, with 30 voices to choose from. Interrupt any time; say “go to sleep” when you’re done.',
    art: (
      <div className="a-talk">
        <span className="a-talk__b a-talk__b--me">Make it shorter</span>
        <span className="a-talk__b a-talk__b--z">Sure, here’s the short version…</span>
        <span className="a-talk__b a-talk__b--me">Actually, wait—</span>
      </div>
    )
  },
  {
    id: 'island',
    title: 'Dynamic Island',
    body: 'A floating pill at the top of your screen with live cards, approvals and an animated companion.',
    art: (
      <div className="a-island">
        <span className="a-island__pill"><ZMark size={14} /><i /><i /></span>
      </div>
    )
  },
  {
    id: 'research',
    title: 'Research the live web',
    body: 'Search, news, prices and comparisons, with sources laid out as cards.',
    art: (
      <div className="a-research">
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ ['--i' as string]: i }}><i className="fav" /><i /><i /></span>
        ))}
      </div>
    )
  },
  {
    id: 'build',
    span: 'tall',
    title: 'Builds whole websites',
    body: 'A background builder agent plans it, writes every file, tests the page and opens the result while you keep talking.',
    art: (
      <div className="a-build">
        <div className="a-build__code">
          {[78, 54, 66, 40, 72, 48, 60].map((w, i) => (
            <i key={i} style={{ width: `${w}%`, ['--i' as string]: i }} />
          ))}
        </div>
        <div className="a-build__page">
          <span className="a-build__bar"><i /><i /><i /></span>
          <span className="a-build__hero" />
          <span className="a-build__grid"><i /><i /><i /></span>
        </div>
      </div>
    )
  },
  {
    id: 'see',
    title: 'Sees through your camera',
    body: 'Live camera preview in the island. Ask what you’re holding.',
    art: (
      <div className="a-see">
        <span className="a-see__frame"><i /><i /><i /><i /></span>
        <span className="a-see__obj" />
        <span className="a-see__scan" />
      </div>
    )
  },
  {
    id: 'media',
    title: 'Plays and controls media',
    body: 'YouTube and Spotify, plus play, pause, next and volume by voice.',
    art: (
      <div className="a-media">
        <span className="a-media__eq">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ animationDelay: `${-i * 0.13}s` }} />)}</span>
        <span className="a-media__ctl"><i /><b /><i /></span>
      </div>
    )
  },
  {
    id: 'apps',
    span: 'wide',
    title: 'Opens apps, files and sites',
    body: 'Launch apps, open files, folders and URLs (even in a specific browser or VS Code), list folders, read files and create new ones.',
    art: (
      <div className="a-apps">
        {['App', 'File', 'Folder', 'Site', 'Code'].map((t, i) => (
          <span key={t} style={{ ['--i' as string]: i }}><i />{t}</span>
        ))}
      </div>
    )
  },
  {
    id: 'everyday',
    title: 'Everyday helpers',
    body: 'Weather, timers, clipboard and your PC’s CPU, memory, battery and disk.',
    art: (
      <div className="a-every">
        <span className="a-every__sun" />
        <span className="a-every__timer" />
        <span className="a-every__bars"><i /><i /><i /></span>
      </div>
    )
  },
  {
    id: 'ask',
    title: 'Asks before it acts',
    body: 'PowerShell commands and risky actions always wait for your OK.',
    art: (
      <div className="a-ask">
        <span className="a-ask__card">
          <i />
          <span className="a-ask__btns"><b>Deny</b><b className="ok">Allow</b></span>
        </span>
        <span className="a-ask__cursor" />
      </div>
    )
  },
  {
    id: 'agents',
    span: 'wide',
    title: 'Agents, tasks and automations',
    body: 'Multi-step agent runs with real progress, approvals and history, plus a local scheduler for recurring automations.',
    art: (
      <div className="a-agents">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="a-agents__node" style={{ ['--i' as string]: i }}><CheckIcon size={10} /></span>
        ))}
      </div>
    )
  },
  {
    id: 'memory',
    title: 'Memory and knowledge',
    body: 'A full desktop app with chat, projects, memory and a knowledge base.',
    art: (
      <div className="a-mem">
        {Array.from({ length: 7 }, (_, i) => <i key={i} style={{ ['--i' as string]: i }} />)}
      </div>
    )
  },
  {
    id: 'keys',
    title: 'Your keys stay yours',
    body: 'API keys are encrypted on your PC with Windows DPAPI and never shown again.',
    art: (
      <div className="a-keys">
        <span className="a-keys__lock" />
        <span className="a-keys__dots">{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ ['--i' as string]: i }} />)}</span>
      </div>
    )
  },
  {
    id: 'keys2',
    span: 'wide',
    title: 'Shortcuts for everything',
    body: 'Push-to-talk, toggle the island, open ZVYRA, or stop everything at once.',
    art: (
      <div className="a-keyc">
        {[['Ctrl', 'Alt', 'Space'], ['Ctrl', 'Alt', 'Z']].map((combo, r) => (
          <span key={r} className="a-keyc__row" style={{ ['--r' as string]: r }}>
            {combo.map((k, i) => (
              <kbd key={k} style={{ ['--i' as string]: i }}>{k}</kbd>
            ))}
          </span>
        ))}
      </div>
    )
  }
]

function TileView({ t, n }: { t: Tile; n: number }) {
  const ref = useReveal<HTMLLIElement>()
  return (
    <li className={`ft reveal ft--${t.id}${t.span ? ` ft--${t.span}` : ''}`} ref={ref} style={{ ['--n' as string]: n % 4 }}>
      <div className="ft__art" aria-hidden="true">{t.art}</div>
      <div className="ft__text">
        <h3 className="ft__title">{t.title}</h3>
        <p className="ft__body">{t.body}</p>
      </div>
    </li>
  )
}

export function Features() {
  const head = useReveal<HTMLDivElement>()
  return (
    <section className="section feats" id="features" aria-labelledby="features-title">
      <div className="section__head reveal" ref={head}>
        <p className="eyebrow">Features</p>
        <h2 id="features-title" className="section__title">
          One voice. <span className="soft">Everything on your PC.</span>
        </h2>
        <p className="section__sub">An assistant that lives on your desktop and actually gets things done.</p>
      </div>
      <ul className="feats__grid">
        {TILES.map((t, n) => (
          <TileView key={t.id} t={t} n={n} />
        ))}
      </ul>
    </section>
  )
}
