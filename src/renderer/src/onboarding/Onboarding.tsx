/**
 * OWNER: Kiro. First-run setup: welcome → connect AI providers (each key is
 * tested with a tiny real request) → teach the wake word your voice → a short
 * tour with a live Dynamic Island demo.
 */
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, ExternalLink, Hammer, KeyRound, Mic, Minus, MonitorSmartphone, Radar, Camera as CameraIcon, Sparkles, Square, X, AudioLines, LoaderCircle, TriangleAlert, WandSparkles as Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { KeyTestResult, SetupProvider } from '@shared/contract'
import { ZMark, Wordmark } from '../components/brand'
import { HelixWave } from '../components/HelixWave'
import { call, errorMessage, shellCall } from '../lib/client'
import { setWakeWord } from '../lib/hooks'
import { getState, setState, useStore } from '../lib/store'
import './onboarding.css'

type Step = 'welcome' | 'connect' | 'voice' | 'tour'
const STEPS: { id: Step; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'connect', label: 'Connect AI' },
  { id: 'voice', label: 'Your voice' },
  { id: 'tour', label: 'Quick tour' }
]

export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome')
  const [name, setName] = useState(() => getState().settings?.profile.name ?? '')
  const [finishing, setFinishing] = useState(false)
  const idx = STEPS.findIndex((s) => s.id === step)
  const go = (d: 1 | -1) => setStep(STEPS[Math.max(0, Math.min(STEPS.length - 1, idx + d))].id)

  const finish = async () => {
    setFinishing(true)
    try {
      const s = await call('setup.complete', { name })
      setState({ setup: s, route: 'home' })
    } catch (err) {
      setFinishing(false)
      alert(errorMessage(err))
    }
  }

  return (
    <div className="ob">
      <Backdrop />
      <div className="ob-drag">
        <div className="ob-win no-drag-zone">
          <button type="button" onClick={() => void shellCall('main.minimize')} aria-label="Minimize">
            <Minus />
          </button>
          <button type="button" onClick={() => void shellCall('main.toggleMaximize')} aria-label="Maximize">
            <Square />
          </button>
          <button type="button" className="close" onClick={() => void shellCall('main.close')} aria-label="Close">
            <X />
          </button>
        </div>
      </div>

      {step !== 'welcome' && (
        <nav className="ob-rail" aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <div key={s.id} className={`ob-rail-step ${i < idx ? 'done' : i === idx ? 'now' : ''}`}>
              <span className="ob-rail-dot">{i < idx ? <Check /> : i + 1}</span>
              <span>{s.label}</span>
              {i < STEPS.length - 1 && <span className="ob-rail-line" />}
            </div>
          ))}
        </nav>
      )}

      <main className={`ob-stage s-${step}`} key={step}>
        {step === 'welcome' && <Welcome name={name} setName={setName} onNext={() => go(1)} />}
        {step === 'connect' && <Connect onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'voice' && <VoiceStep onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'tour' && <Tour name={name} onBack={() => go(-1)} onFinish={() => void finish()} finishing={finishing} />}
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ backdrop */

function Backdrop() {
  const stars = useMemo(() => Array.from({ length: 46 }, (_, i) => ({ x: (i * 73.3) % 100, y: (i * 41.7) % 100, d: (i % 7) * 0.9, s: 1 + (i % 3) })), [])
  return (
    <div className="ob-bg" aria-hidden="true">
      <span className="ob-blob a" />
      <span className="ob-blob b" />
      <span className="ob-blob c" />
      <span className="ob-grid" />
      {stars.map((p, i) => (
        <i key={i} className="ob-star" style={{ left: `${p.x}%`, top: `${p.y}%`, animationDelay: `${p.d}s`, width: p.s, height: p.s } as CSSProperties} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ 1. welcome */

function Welcome({ name, setName, onNext }: { name: string; setName: (s: string) => void; onNext: () => void }) {
  return (
    <section className="ob-welcome">
      <div className="ob-logo">
        <span className="ob-ring r1" />
        <span className="ob-ring r2" />
        <span className="ob-ring r3" />
        <span className="ob-logo-glow" />
        <ZMark size={150} className="ob-z" glow />
      </div>
      <Wordmark height={30} className="ob-word" />
      <div className="ob-tag">YOUR AI OPERATING SYSTEM</div>
      <div className="ob-wave">
        <HelixWave level={0.35} active width={340} height={42} tone="speak" />
      </div>
      <p className="ob-lede">An assistant that lives on your PC: talk to it, let it research, build whole websites, see through your camera and run your desktop. Setup takes about two minutes.</p>
      <form
        className="ob-name"
        onSubmit={(e) => {
          e.preventDefault()
          onNext()
        }}
      >
        <input className="ob-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="What should ZVYRA call you?" aria-label="Your name" maxLength={60} autoFocus />
        <button type="submit" className="ob-btn primary lg">
          Get started <ArrowRight />
        </button>
      </form>
    </section>
  )
}

/* ------------------------------------------------------------------ 2. connect */

type RowState = { status: 'idle' | 'testing' | 'ok' | 'error'; result?: KeyTestResult }

function Connect({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const setup = useStore((s) => s.setup)
  const providers = setup?.providers ?? []
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const geminiReady = rows['gemini']?.status === 'ok' || !!providers.find((p) => p.id === 'gemini')?.configured
  const connected = providers.filter((p) => rows[p.id]?.status === 'ok' || p.configured).length

  const refresh = async () => setState({ setup: (await call('setup.state').catch(() => null)) ?? setup })

  return (
    <section className="ob-panel wide">
      <header className="ob-head">
        <span className="ob-head-icon">
          <KeyRound />
        </span>
        <div>
          <h1>Connect your AI</h1>
          <p>Paste a key and press Test — ZVYRA sends one tiny request to check it works. Keys are encrypted with Windows data protection and never leave this PC except to their own provider.</p>
        </div>
      </header>

      <div className="ob-providers">
        {providers.map((p, i) => (
          <ProviderRow key={p.id} p={p} index={i} state={rows[p.id] ?? { status: p.configured ? 'ok' : 'idle' }} onState={(st) => setRows((r) => ({ ...r, [p.id]: st }))} onSaved={() => void refresh()} />
        ))}
      </div>

      <footer className="ob-foot">
        <button type="button" className="ob-btn ghost" onClick={onBack}>
          <ArrowLeft /> Back
        </button>
        <span className="ob-foot-note">{connected ? `${connected} provider${connected === 1 ? '' : 's'} connected` : 'Gemini is free to start — get a key in under a minute.'}</span>
        {geminiReady ? (
          <button type="button" className="ob-btn primary" onClick={onNext}>
            Continue <ArrowRight />
          </button>
        ) : (
          <button type="button" className="ob-btn ghost" onClick={onNext} title="Voice, research and the builder need a Gemini key">
            Set up later
          </button>
        )}
      </footer>
    </section>
  )
}

function ProviderRow({ p, index, state, onState, onSaved }: { p: SetupProvider; index: number; state: RowState; onState: (s: RowState) => void; onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const test = async () => {
    if (!key.trim()) return
    onState({ status: 'testing' })
    try {
      const result = await call('setup.testKey', { provider: p.id, key })
      onState({ status: result.ok ? 'ok' : 'error', result })
      if (result.ok) {
        setKey('')
        onSaved()
      }
    } catch (err) {
      onState({ status: 'error', result: { ok: false, message: errorMessage(err) } })
    }
  }
  return (
    <div className={`ob-prov st-${state.status} ${p.required ? 'req' : ''}`} style={{ '--i': index } as CSSProperties}>
      <div className="ob-prov-top">
        <span className="ob-prov-badge">{p.name.charAt(0)}</span>
        <div className="ob-prov-text">
          <div className="ob-prov-name">
            {p.name}
            {p.required ? <span className="ob-pill req">Required</span> : <span className="ob-pill">Optional</span>}
            {state.status === 'ok' && (
              <span className="ob-pill ok">
                <Check /> Connected
              </span>
            )}
          </div>
          <div className="ob-prov-purpose">{p.purpose}</div>
        </div>
        <a className="ob-link" href={p.keyUrl} target="_blank" rel="noreferrer">
          Get a key <ExternalLink />
        </a>
      </div>
      <div className="ob-prov-row">
        <div className="ob-key">
          <input
            className="ob-input"
            type={show ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void test()}
            placeholder={state.status === 'ok' && !key ? 'Saved — paste a new key to replace it' : p.keyHint}
            aria-label={`${p.name} API key`}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" className="ob-eye" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide key' : 'Show key'}>
            {show ? <EyeOff /> : <Eye />}
          </button>
        </div>
        <button type="button" className="ob-btn primary sm" disabled={!key.trim() || state.status === 'testing'} onClick={() => void test()}>
          {state.status === 'testing' ? <LoaderCircle className="spin" /> : <Wand2 />} {state.status === 'testing' ? 'Testing' : 'Test'}
        </button>
      </div>
      {state.status === 'testing' && <div className="ob-scan" aria-hidden="true" />}
      {state.result && (
        <div className={`ob-prov-msg ${state.result.ok ? 'ok' : 'bad'}`} role="status">
          {state.result.ok ? <Check /> : <TriangleAlert />} {state.result.message}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ 3. voice */

function VoiceStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const training = useStore((s) => s.wakeTraining)
  const samples = useStore((s) => s.setup?.wakeSamples ?? 0)
  const [phase, setPhase] = useState<'ready' | 'recording' | 'trained' | 'heard'>('ready')
  const [err, setErr] = useState<string | null>(null)
  const startedTest = useRef(false)

  useEffect(() => {
    if (voice && !voice.wakeWordEnabled) void setWakeWord(true)
  }, [voice?.wakeWordEnabled])

  useEffect(() => {
    if (phase === 'recording' && training && training.recording === 0 && training.templates > 0) setPhase('trained')
  }, [phase, training])

  // After training, listen for a real wake to prove it works.
  useEffect(() => {
    if (phase !== 'trained') return
    startedTest.current = true
    const st = voice?.state
    if (st === 'wake_detected' || st === 'listening') {
      setPhase('heard')
      setTimeout(() => void call('voice.cancel').catch(() => undefined), 900)
    }
  }, [phase, voice?.state])

  const record = async () => {
    setErr(null)
    try {
      await call('voice.trainWake', { action: 'start' })
      setPhase('recording')
    } catch (e) {
      setErr(errorMessage(e))
    }
  }

  const done = training ? 5 - training.recording : 0
  const micError = voice?.error && /micro/i.test(voice.error) ? voice.error : null
  const bars = 28

  return (
    <section className="ob-panel">
      <header className="ob-head">
        <span className="ob-head-icon">
          <Mic />
        </span>
        <div>
          <h1>Teach ZVYRA your voice</h1>
          <p>Say “Hey Zvyra” five times, the way you naturally say it. ZVYRA learns your voice and accent so it wakes for you. Samples stay on this PC.</p>
        </div>
      </header>

      <div className={`ob-voice ph-${phase}`}>
        <div className="ob-orb" style={{ '--lvl': Math.min(1, level * 1.4) } as CSSProperties}>
          <span className="ob-orb-ring" />
          <span className="ob-orb-ring two" />
          <span className="ob-orb-core">{phase === 'heard' || phase === 'trained' ? <Check /> : <AudioLines />}</span>
        </div>

        <div className="ob-meter" aria-hidden="true">
          {Array.from({ length: bars }, (_, i) => {
            const center = 1 - Math.abs(i - bars / 2) / (bars / 2)
            return <i key={i} style={{ height: `${10 + Math.min(1, level * 1.6) * 90 * (0.35 + center * 0.65) * (0.7 + ((i * 37) % 10) / 33)}%` }} />
          })}
        </div>

        <div className="ob-samples" aria-label={`${done} of 5 samples recorded`}>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={`ob-sample ${i < done ? 'got' : i === done && phase === 'recording' ? 'now' : ''}`}>
              {i < done ? <Check /> : i + 1}
            </span>
          ))}
        </div>

        <div className="ob-voice-say" aria-live="polite">
          {micError ??
            err ??
            (phase === 'ready'
              ? samples
                ? `${samples} voice samples already saved. Record again to improve it, or continue.`
                : 'Press Record, then say “Hey Zvyra” — pause after each one.'
              : phase === 'recording'
                ? done < 5
                  ? `Say “Hey Zvyra”  ·  ${5 - done} to go`
                  : 'Saving…'
                : phase === 'trained'
                  ? 'Learned! Now try it: say “Hey Zvyra” once more.'
                  : 'It heard you. Your wake word is ready.')}
        </div>
      </div>

      <footer className="ob-foot">
        <button type="button" className="ob-btn ghost" onClick={onBack}>
          <ArrowLeft /> Back
        </button>
        <span className="ob-grow" />
        {phase === 'ready' && (
          <button type="button" className="ob-btn primary" onClick={() => void record()} disabled={!!micError}>
            <Mic /> Record
          </button>
        )}
        {phase === 'recording' && (
          <button type="button" className="ob-btn ghost" onClick={() => setPhase('ready')}>
            Start over
          </button>
        )}
        <button type="button" className={`ob-btn ${phase === 'trained' || phase === 'heard' || samples ? 'primary' : 'ghost'}`} onClick={onNext}>
          {phase === 'trained' || phase === 'heard' || samples ? 'Continue' : 'Skip'} <ArrowRight />
        </button>
      </footer>
    </section>
  )
}


/* ------------------------------------------------------------------ 5. tour */

const FEATURES = [
  { icon: AudioLines, title: 'Just talk', say: '“Hey Zvyra, play some lofi on YouTube”', body: 'Natural voice conversations, music and media control. Interrupt any time; say “go to sleep” to finish.' },
  { icon: Radar, title: 'Research', say: '“Find the best budget laptops this year”', body: 'Searches the live web and shows sources as cards in the Dynamic Island.' },
  { icon: Hammer, title: 'Build', say: '“Build me an e-commerce site for sneakers”', body: 'The builder agent writes every file, tests the page and opens it for you.' },
  { icon: CameraIcon, title: 'See', say: '“Open my camera — what am I holding?”', body: 'A live camera preview in the island; ZVYRA describes what it sees.' },
  { icon: MonitorSmartphone, title: 'Show me how', say: '“How do I turn on dark mode here?”', body: 'ZVYRA looks at your screen and draws circles and arrows: click here, then here, done.' }
]

const PLACES = [
  { name: 'Dynamic Island', where: 'Top of your screen', what: 'Always there. Click it to type, watch live tool cards and approvals.' },
  { name: 'Home', where: 'Main window', what: 'Talk, see what ZVYRA is doing and recent results.' },
  { name: 'Tasks & Projects', where: 'Sidebar', what: 'Long jobs, their plans, files and progress.' },
  { name: 'Settings → Voice', where: 'Sidebar', what: 'Voice, wake sensitivity and “Teach my voice” any time.' }
]

function Tour({ name, onBack, onFinish, finishing }: { name: string; onBack: () => void; onFinish: () => void; finishing: boolean }) {
  const [demoed, setDemoed] = useState(false)
  return (
    <section className="ob-panel wide">
      <header className="ob-head">
        <span className="ob-head-icon">
          <Sparkles />
        </span>
        <div>
          <h1>{name.trim() ? `You’re all set, ${name.trim().split(' ')[0]}` : 'You’re all set'}</h1>
          <p>Here’s what ZVYRA can do. Try any of these by voice or by typing into the Dynamic Island.</p>
        </div>
      </header>

      <div className="ob-features">
        {FEATURES.map((f, i) => (
          <div key={f.title} className="ob-feature" style={{ '--i': i } as CSSProperties}>
            <span className="ob-feature-icon">
              <f.icon />
            </span>
            <div className="ob-feature-title">{f.title}</div>
            <div className="ob-feature-say">{f.say}</div>
            <div className="ob-feature-body">{f.body}</div>
          </div>
        ))}
      </div>

      <div className="ob-demo">
        <div className="ob-demo-text">
          <b>Watch the Dynamic Island</b>
          <span>Plays a sample research and build card at the top of your screen.</span>
        </div>
        <button
          type="button"
          className="ob-btn primary sm"
          onClick={() => {
            setDemoed(true)
            void call('setup.demo').catch(() => undefined)
          }}
        >
          <Sparkles /> {demoed ? 'Play again' : 'Show me'}
        </button>
      </div>

      <div className="ob-places">
        {PLACES.map((p, i) => (
          <div key={p.name} className="ob-place" style={{ '--i': i } as CSSProperties}>
            <span className="ob-place-n">{i + 1}</span>
            <div>
              <div className="ob-place-name">
                {p.name} <span>{p.where}</span>
              </div>
              <div className="ob-place-what">{p.what}</div>
            </div>
          </div>
        ))}
      </div>

      <footer className="ob-foot">
        <button type="button" className="ob-btn ghost" onClick={onBack}>
          <ArrowLeft /> Back
        </button>
        <span className="ob-grow" />
        <button type="button" className="ob-btn primary lg" onClick={onFinish} disabled={finishing}>
          {finishing ? <LoaderCircle className="spin" /> : <Check />} Start using ZVYRA
        </button>
      </footer>
    </section>
  )
}
