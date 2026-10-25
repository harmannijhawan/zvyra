/** Settings → Voice: Gemini Live conversation + on-device "Hey Zvyra" wake word. */
import { CheckCircle2, Cloud, HardDrive, KeyRound, Mic, MicOff, Play, RefreshCw, ShieldCheck, Sparkles, Volume2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MicDevice, VoiceEngineOption } from '@shared/contract'
import { Badge, Button, Card, Toggle } from '../../components/ui'
import { Waveform } from '../../components/Waveform'
import { call, errorMessage } from '../../lib/client'
import { setWakeWord, toggleListening } from '../../lib/hooks'
import { setState, useStore } from '../../lib/store'
import { toast } from '../../lib/toast'
import { attempt, useAction } from '../../lib/useAction'
import { patchSettings, Row, useSettings } from './common'

const VOICE_STYLES: Record<string, string> = {
  Charon: 'Informative', Puck: 'Upbeat', Kore: 'Firm', Fenrir: 'Excitable', Aoede: 'Breezy', Zephyr: 'Bright', Leda: 'Youthful', Orus: 'Firm',
  Callirrhoe: 'Easy-going', Autonoe: 'Bright', Enceladus: 'Breathy', Iapetus: 'Clear', Umbriel: 'Easy-going', Algieba: 'Smooth', Despina: 'Smooth',
  Erinome: 'Clear', Algenib: 'Gravelly', Rasalgethi: 'Informative', Laomedeia: 'Upbeat', Achernar: 'Soft', Alnilam: 'Firm', Schedar: 'Even',
  Gacrux: 'Mature', Pulcherrima: 'Forward', Achird: 'Friendly', Zubenelgenubi: 'Casual', Vindemiatrix: 'Gentle', Sadachbia: 'Lively',
  Sadaltager: 'Knowledgeable', Sulafat: 'Warm'
}

export function VoiceSettings() {
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const transcript = useStore((s) => s.liveTranscript)
  const settings = useSettings()
  const [engines, setEngines] = useState<VoiceEngineOption[] | null>(null)
  const [engErr, setEngErr] = useState<string | null>(null)
  const [devices, setDevices] = useState<MicDevice[] | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [run, busy] = useAction()
  const [testing, setTesting] = useState(false)

  const loadEngines = useCallback(
    () =>
      call('voice.engines')
        .then((e) => {
          setEngines(e)
          setEngErr(null)
        })
        .catch((e) => setEngErr(errorMessage(e))),
    []
  )
  const loadDevices = () =>
    call('voice.devices')
      .then(setDevices)
      .catch(() => setDevices([]))

  useEffect(() => {
    void loadEngines()
    void loadDevices()
    const t = setTimeout(() => void loadDevices(), 1500) // device labels arrive once the mic opens
    return () => clearTimeout(t)
  }, [loadEngines])

  if (!settings) return null
  const v = settings.voice
  const live = engines?.find((e) => e.id === 'gemini-live')
  const hasKey = !!live?.fields.find((f) => f.key === 'apiKey')?.hasValue
  const models = live?.fields.find((f) => f.key === 'model')?.options ?? []
  const listening = voice?.state === 'listening' || voice?.state === 'wake_detected'
  const active = listening || voice?.state === 'speaking' || voice?.state === 'transcribing'

  const configure = async (values: Record<string, string | number | boolean>, success?: string) => {
    const r = await run(() => call('voice.configureEngine', { engineId: 'gemini-live', values }), { success })
    if (r) setEngines(r)
    return r
  }

  const saveKey = async () => {
    if (await configure({ apiKey: apiKey.trim() }, 'Gemini key saved')) setApiKey('')
  }

  const test = async () => {
    setTesting(true)
    const r = await attempt(() => call('voice.testEngine', { engineId: 'gemini-live' }))
    setTesting(false)
    if (r) toast({ tone: r.ok ? 'success' : 'danger', title: r.ok ? 'Voice is working' : 'Voice test failed', message: r.message })
  }

  const preview = async (name: string) => {
    if (name !== v.ttsVoice) await configure({ voice: name })
    await attempt(() => call('voice.speak', { text: `Hi, I'm ZVYRA. This is the ${name} voice.` }))
  }

  return (
    <div className="stack">
      <Card title="Talk to ZVYRA" icon={Mic}>
        <div className="voice-hero">
          <div className={`voice-orb ${active ? 'live' : ''}`} style={{ ['--lvl' as string]: level.toFixed(3) }}>
            <Waveform mode={listening ? 'active' : voice?.state === 'speaking' ? 'speaking' : voice?.state === 'standby' ? 'ambient' : 'off'} level={level} bars={13} height={30} />
          </div>
          <div className="voice-hero-text">
            <div className="voice-hero-title">
              {voice?.state === 'standby'
                ? 'Listening for “Hey Zvyra”'
                : voice?.state === 'wake_detected'
                  ? 'Connecting…'
                  : listening
                    ? 'Listening — go ahead'
                    : voice?.state === 'speaking'
                      ? 'Speaking'
                      : voice?.state === 'transcribing'
                        ? 'Thinking…'
                        : voice?.state === 'error'
                          ? 'Voice needs attention'
                          : 'Voice is off'}
            </div>
            <div className="voice-hero-sub selectable">
              {voice?.error ?? (active && transcript ? `“${transcript}”` : voice?.micLabel ? `Microphone: ${voice.micLabel}` : 'Say “Hey Zvyra” or press Talk now.')}
            </div>
          </div>
          <Button variant={active ? 'danger' : 'primary'} icon={active ? MicOff : Mic} disabled={!hasKey && !active} onClick={() => void toggleListening('api')}>
            {active ? 'End conversation' : 'Talk now'}
          </Button>
        </div>
        <Row label="Wake word" help="“Hey Zvyra” is detected on this PC by a small neural keyword spotter. Nothing is sent anywhere until it hears you.">
          <Toggle checked={!!voice?.wakeWordEnabled} onChange={(e) => void setWakeWord(e)} label="Listen for Hey Zvyra" />
        </Row>
        <Row label="Wake sensitivity" help={`${Math.round(v.sensitivity * 100)}% — higher wakes more easily; lower avoids false wakes in noisy rooms.`}>
          <input
            type="range"
            min={0.3}
            max={0.95}
            step={0.05}
            value={v.sensitivity}
            onChange={(e) => void call('voice.configureEngine', { engineId: 'zvyra-kws', values: { sensitivity: Number(e.target.value) } }).then(() => patchSettings({ voice: { sensitivity: Number(e.target.value) } }))}
            aria-label="Wake sensitivity"
          />
        </Row>
        <Row label="Teach my voice" help="Press Record, then say “Hey Zvyra” five times with a short pause between each — you’ll hear a chime after each one. ZVYRA then wakes to your own voice and accent. Samples stay on this PC.">
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="primary"
              icon={Mic}
              disabled={!voice?.wakeWordEnabled}
              onClick={() => void attempt(() => call('voice.trainWake', { action: 'start' }), { success: 'Say “Hey Zvyra” five times' })}
            >
              Record
            </Button>
            <Button variant="ghost" onClick={() => void attempt(() => call('voice.trainWake', { action: 'clear' }), { success: 'Voice samples removed' })}>
              Forget samples
            </Button>
          </div>
        </Row>
        <Row label="Microphone" help="Echo cancellation and noise suppression are always on.">
          <select
            className="select"
            value={voice?.micDeviceId ?? ''}
            onChange={(e) => void attempt(() => call('voice.selectDevice', { deviceId: e.target.value || null })).then((s) => s && setState({ voice: s }))}
            aria-label="Microphone"
          >
            {(devices ?? []).map((d) => (
              <option key={d.id || 'default'} value={d.id}>
                {d.isDefault ? `Default — ${d.label.replace(/^Default - /, '')}` : d.label}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void loadDevices()} aria-label="Refresh microphones" />
        </Row>
      </Card>

      <Card
        title="Gemini Live"
        icon={Sparkles}
        actions={
          <Button size="sm" icon={Play} loading={testing} disabled={!hasKey} onClick={() => void test()}>
            Test voice
          </Button>
        }
      >
        <div className="row" style={{ marginBottom: 6 }}>
          {hasKey ? <CheckCircle2 style={{ color: 'var(--success)', width: 18 }} /> : <XCircle style={{ color: 'var(--warning)', width: 18 }} />}
          <span style={{ fontSize: 13 }}>{hasKey ? 'API key saved (encrypted on this PC)' : 'Add your Gemini API key to talk with ZVYRA'}</span>
          <span className="spacer" />
          <Badge tone="warning" icon={Cloud}>
            Audio goes to Google only during a conversation
          </Badge>
        </div>
        <Row label="API key" help={<>Get one free at aistudio.google.com/apikey. {hasKey && 'Leave blank to keep the saved key.'}</>}>
          <input className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasKey ? '••••••••  (saved)' : 'AIza…'} aria-label="Gemini API key" />
          <Button size="sm" icon={KeyRound} disabled={!apiKey.trim()} loading={busy} onClick={() => void saveKey()}>
            Save
          </Button>
        </Row>
        <Row label="Live model" help="Models your key can use for real-time voice, discovered from Google.">
          <select className="select" value={v.sttProvider} onChange={(e) => void configure({ model: e.target.value }, 'Model updated')} aria-label="Live model" disabled={!models.length}>
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void loadEngines()} aria-label="Refresh models" />
        </Row>
        {engErr && <div className="notice warning">{engErr}</div>}
      </Card>

      <Card title="Voice" icon={Volume2} actions={<span className="muted" style={{ fontSize: 12 }}>Click to choose · ▶ to preview</span>}>
        <div className="voice-grid">
          {Object.entries(VOICE_STYLES).map(([name, style]) => (
            <div key={name} className={`voice-chip ${v.ttsVoice === name ? 'on' : ''}`}>
              <button type="button" className="voice-chip-main" onClick={() => void configure({ voice: name }, `Voice set to ${name}`)} aria-pressed={v.ttsVoice === name}>
                <span className="voice-chip-name">{name}</span>
                <span className="voice-chip-style">{style}</span>
              </button>
              <button type="button" className="voice-chip-play" disabled={!hasKey || busy} onClick={() => void preview(name)} aria-label={`Preview ${name}`} title={`Preview ${name}`}>
                <Play />
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Conversation" icon={Mic}>
        <Row label="Stay awake for" help="After you stop talking, ZVYRA keeps listening this long before going back to sleep.">
          <select className="select" value={v.listenTimeoutSec} onChange={(e) => void patchSettings({ voice: { listenTimeoutSec: Number(e.target.value) } })} aria-label="Stay awake for">
            {[8, 15, 30, 60, 120].map((n) => (
              <option key={n} value={n}>
                {n < 60 ? `${n} seconds` : `${n / 60} minute${n > 60 ? 's' : ''}`}
              </option>
            ))}
          </select>
        </Row>
        <Row label="End-of-speech pause" help="Shorter pauses reply sooner. Your microphone keeps listening if you continue; choose a longer pause if you need more thinking time.">
          <select className="select" value={v.silenceTimeoutMs} onChange={(e) => void patchSettings({ voice: { silenceTimeoutMs: Number(e.target.value) } })} aria-label="End-of-speech pause">
            {[500, 750, 1200, 1800, 2400, 3000].map((n) => (
              <option key={n} value={n}>
                {n / 1000} s{n === 750 ? ' (recommended)' : ''}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Speaking pace">
          <select className="select" value={v.ttsRate <= 0.8 ? 0.75 : v.ttsRate >= 1.25 ? 1.3 : 1} onChange={(e) => void patchSettings({ voice: { ttsRate: Number(e.target.value) } })} aria-label="Speaking pace">
            <option value={0.75}>Relaxed</option>
            <option value={1}>Natural</option>
            <option value={1.3}>Brisk</option>
          </select>
        </Row>
        <div className="notice" style={{ marginTop: 8 }}>
          <ShieldCheck />
          <span>
            You can interrupt ZVYRA any time by talking. Say “that’s all” or “go to sleep” to end a conversation. ZVYRA can start tasks, check their status and open sites or apps while you talk.
          </span>
        </div>
      </Card>

      <div className="notice">
        <HardDrive />
        <span>Wake word: on-device · Conversation: Gemini Live (Google) · Raw audio is never saved.</span>
      </div>
    </div>
  )
}
