/**
 * OWNER: Kiro. Dynamic Island live surfaces:
 *  - ToolCard: animated cards for research, media, builds, weather, PC status…
 *  - CameraContent: the webcam preview (iris-open reveal, HUD, scan, capture flash)
 *    which also answers main's capture requests with a still frame.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Aperture, Camera, Check, CloudSun, Cpu, Globe, Hammer, Music, Radar, Sparkles, Timer, TriangleAlert, X } from 'lucide-react'
import type { ToolActivity, ToolKind } from '@shared/contract'
import { call, errorMessage } from '../lib/client'
import { useStore } from '../lib/store'
import { HelixWave } from '../components/HelixWave'

/* ------------------------------------------------------------------ freshness */

const FRESH_MS = 14_000

/** Cards worth showing now: anything running, plus results from the last few seconds. */
export function useFreshTools(now: number, dismissed: Set<string>, opts: { skipCamera?: boolean } = {}) {
  const tools = useStore((s) => s.tools)
  return useMemo(
    () =>
      tools
        .filter((t) => !dismissed.has(t.id) && (t.status === 'running' || now - Date.parse(t.updatedAt) < (t.kind === 'build' ? FRESH_MS * 3 : FRESH_MS)))
        .filter((t) => !(opts.skipCamera && t.kind === 'camera'))
        .slice(0, 3),
    [tools, now, dismissed, opts.skipCamera]
  )
}

/* ------------------------------------------------------------------ tool cards */

const ICON: Record<ToolKind, typeof Globe> = {
  research: Radar,
  web: Globe,
  media: Music,
  camera: Camera,
  build: Hammer,
  weather: CloudSun,
  system: Cpu,
  timer: Timer,
  other: Sparkles
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

function ToolOrb({ kind, status }: { kind: ToolKind; status: ToolActivity['status'] }) {
  const Icon = status === 'error' ? TriangleAlert : status === 'done' && kind !== 'media' ? Check : ICON[kind]
  return (
    <span className={`tc-orb k-${kind} s-${status}`} aria-hidden="true">
      <span className="tc-orb-ring" />
      <span className="tc-orb-ping" />
      <span className="tc-orb-ping two" />
      <Icon className="tc-orb-icon" key={status} />
      {status === 'done' && (
        <span className="tc-burst">
          {Array.from({ length: 6 }, (_, i) => (
            <i key={i} style={{ '--a': `${i * 60}deg` } as CSSProperties} />
          ))}
        </span>
      )}
    </span>
  )
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000))
  return <span className="tc-time">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>
}

function Equalizer() {
  return (
    <span className="tc-eq" aria-hidden="true">
      {Array.from({ length: 14 }, (_, i) => (
        <i key={i} style={{ '--i': i } as CSSProperties} />
      ))}
    </span>
  )
}

export function ToolCard({ a, index = 0, onDismiss }: { a: ToolActivity; index?: number; onDismiss?: (id: string) => void }) {
  const running = a.status === 'running'
  const sources = a.sources ?? []
  return (
    <div className={`tc k-${a.kind} s-${a.status}`} style={{ '--i': index } as CSSProperties} role="status" aria-live="polite">
      <div className="tc-head">
        <ToolOrb kind={a.kind} status={a.status} />
        <div className="tc-text">
          <div className="tc-label">
            {a.label}
            {running && (
              <span className="tc-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
          {a.subject && <div className={`tc-subject ${running ? 'shimmer' : ''}`}>{a.subject}</div>}
        </div>
        {running ? <Elapsed since={a.startedAt} /> : onDismiss && (
          <button type="button" className="di-icon sm no-drag" onClick={() => onDismiss(a.id)} aria-label="Dismiss" title="Dismiss">
            <X />
          </button>
        )}
      </div>

      {running && (
        <div className="tc-beam" aria-hidden="true">
          <span />
        </div>
      )}

      {a.kind === 'build' && !!a.steps?.length && (
        <ol className="tc-steps">
          {a.steps.slice(-4).map((s, i, arr) => (
            <li key={`${s}-${a.steps!.length - arr.length + i}`} className={i === arr.length - 1 && running ? 'now' : 'ok'}>
              <span className="tc-step-dot" />
              {s}
            </li>
          ))}
        </ol>
      )}

      {a.kind === 'media' && a.status === 'done' && a.tool === 'play_media' && <Equalizer />}

      {a.summary && (!running || a.kind === 'build') && (
        <div className={`tc-summary selectable ${a.status === 'error' ? 'error' : ''} ${running ? 'meta' : 'reveal'}`} key={a.status}>
          {a.summary}
        </div>
      )}

      {!!sources.length && (
        <div className="tc-sources no-drag">
          {sources.slice(0, 6).map((s, i) => {
            const h = hostOf(s.url)
            const name = s.title && s.title.length < 40 ? s.title : h
            return (
              <a key={s.url} className="tc-src" href={s.url} target="_blank" rel="noreferrer" title={s.url} style={{ '--i': i, '--h': hueOf(name) } as CSSProperties}>
                <span className="tc-fav">{name.replace(/^www\./, '').charAt(0).toUpperCase()}</span>
                <span className="tc-src-name">{name}</span>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function ToolStack({ items, onDismiss }: { items: ToolActivity[]; onDismiss?: (id: string) => void }) {
  if (!items.length) return null
  return (
    <div className="tc-stack">
      {items.map((a, i) => (
        <ToolCard key={a.id} a={a} index={i} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ camera */

function cameraError(err: unknown) {
  const name = (err as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access is blocked. Turn on Settings → Privacy & security → Camera → “Let desktop apps access your camera”.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No webcam found. Plug one in and try again.'
  if (name === 'NotReadableError') return 'The webcam is busy in another app. Close that app and try again.'
  return errorMessage(err)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function CameraContent({ inVoice }: { inVoice: boolean }) {
  const cam = useStore((s) => s.camera)
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const tools = useStore((s) => s.tools)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const readyAt = useRef(0)
  const errorRef = useRef<string | null>(null)
  const handled = useRef<string | null>(null)
  const [phase, setPhase] = useState<'starting' | 'live' | 'error'>('starting')
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState(0)
  const [res, setRes] = useState('')

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        streamRef.current = stream
        const v = videoRef.current
        if (v) {
          v.srcObject = stream
          void v.play().catch(() => undefined)
        }
      })
      .catch((err) => {
        if (cancelled) return
        errorRef.current = cameraError(err)
        setError(errorRef.current)
        setPhase('error')
      })
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  // Main asked for a still: wait for a warmed-up frame, flash, send it back.
  useEffect(() => {
    const id = cam.captureId
    if (!id || handled.current === id) return
    handled.current = id
    void (async () => {
      try {
        const deadline = Date.now() + 15_000
        let v = videoRef.current
        while (!(v && v.readyState >= 2 && v.videoWidth > 0)) {
          if (errorRef.current) throw new Error(errorRef.current)
          if (Date.now() > deadline) throw new Error('The webcam didn’t start in time.')
          await sleep(100)
          v = videoRef.current
        }
        const warm = 1200 - (performance.now() - readyAt.current) // first frames are often dark
        if (warm > 0) await sleep(warm)
        const scale = Math.min(1, 1280 / v.videoWidth, 720 / v.videoHeight)
        const c = document.createElement('canvas')
        c.width = Math.round(v.videoWidth * scale)
        c.height = Math.round(v.videoHeight * scale)
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
        setFlash((f) => f + 1)
        await call('camera.frame', { captureId: id, dataUrl: c.toDataURL('image/jpeg', 0.82) })
      } catch (err) {
        await call('camera.frame', { captureId: id, error: errorMessage(err) }).catch(() => undefined)
      }
    })()
  }, [cam.captureId])

  const look = tools.find((t) => t.kind === 'camera')
  const looking = look?.status === 'running'
  const vs = voice?.state
  const title = inVoice ? (vs === 'speaking' ? 'Speaking' : vs === 'transcribing' ? 'Thinking…' : 'Listening') : 'Camera'
  const sub = phase === 'error' ? 'Camera unavailable' : phase === 'starting' ? 'Opening the lens…' : looking ? 'Looking…' : `Live${res ? ` · ${res}` : ''}`

  return (
    <div className={`di-cam ph-${phase} ${looking ? 'looking' : ''}`}>
      <div className="di-row">
        <span className={`cam-rec ${phase === 'live' ? 'on' : ''}`} aria-hidden="true">
          <i />
        </span>
        <div className="di-text">
          <div className="di-title">{title}</div>
          <div className="di-sub" aria-live="polite">
            {sub}
          </div>
        </div>
        {inVoice && (
          <HelixWave level={vs === 'speaking' ? Math.max(level, 0.25) : level} active width={86} height={30} tone={vs === 'speaking' ? 'speak' : vs === 'transcribing' ? 'think' : 'listen'} />
        )}
        <button type="button" className="di-icon stop no-drag" onClick={() => void call('camera.close').catch(() => undefined)} aria-label="Turn camera off" title="Turn camera off">
          <X />
        </button>
      </div>

      <div className="cam-stage">
        <video
          ref={videoRef}
          className="cam-video"
          muted
          playsInline
          autoPlay
          onLoadedData={(e) => {
            readyAt.current = performance.now()
            setRes(`${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`)
            setPhase('live')
          }}
        />
        <span className="cam-aperture" aria-hidden="true" />
        <span className="cam-grid" aria-hidden="true" />
        <span className="cam-scan" aria-hidden="true" />
        <span className="cam-corner tl" aria-hidden="true" />
        <span className="cam-corner tr" aria-hidden="true" />
        <span className="cam-corner bl" aria-hidden="true" />
        <span className="cam-corner br" aria-hidden="true" />
        {phase === 'live' && (
          <span className="cam-live">
            <i />
            LIVE
          </span>
        )}
        {phase === 'starting' && (
          <span className="cam-boot" aria-hidden="true">
            <Aperture />
          </span>
        )}
        {looking && (
          <span className="cam-analyze" aria-hidden="true">
            <span className="cam-reticle" />
            <span className="cam-sweep" />
          </span>
        )}
        {flash > 0 && <span key={flash} className="cam-flash" aria-hidden="true" />}
        {phase === 'error' && <div className="cam-error">{error}</div>}
      </div>

      {look && look.status !== 'running' && look.summary && (
        <div className={`cam-caption selectable reveal ${look.status === 'error' ? 'error' : ''}`} key={look.updatedAt}>
          {look.summary}
        </div>
      )}
    </div>
  )
}
