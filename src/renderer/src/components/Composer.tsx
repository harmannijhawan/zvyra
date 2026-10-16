/** Text + voice command input used by Home and Chat. */
import { Mic, Paperclip, Send, Square } from 'lucide-react'
import { forwardRef, type KeyboardEvent, type ReactNode } from 'react'
import { useStore } from '../lib/store'
import { toggleListening } from '../lib/hooks'
import { useModels } from '../lib/models'
import type { InteractionSource } from '@shared/contract'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder?: string
  source: InteractionSource
  busy?: boolean
  onStop?: () => void
  model?: string
  onModel?: (m: string | undefined) => void
  onAttach?: () => void
  attachDisabledReason?: string
  extra?: ReactNode
}

export function ModelSelect({ value, onChange, className }: { value?: string; onChange: (m: string | undefined) => void; className?: string }) {
  const { models, loading, error } = useModels()
  const usable = models.filter((m) => m.available)
  const title = error ? `Models unavailable: ${error}` : usable.length ? 'Model (Auto picks the best one)' : 'No models discovered — connect an AI provider in Settings'
  return (
    <select
      className={`select ${className ?? ''}`}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      aria-label="Model"
      title={title}
    >
      <option value="">{loading ? 'Loading models…' : 'Auto'}</option>
      {usable.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
        </option>
      ))}
      {value && !usable.some((m) => m.id === value) && <option value={value}>{value} (unavailable)</option>}
    </select>
  )
}

export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(
  { value, onChange, onSubmit, placeholder, source, busy, onStop, model, onModel, onAttach, attachDisabledReason, extra },
  ref
) {
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const listening = voice?.state === 'listening' || voice?.state === 'wake_detected'
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (value.trim() && !busy) onSubmit()
    }
  }
  return (
    <div className="composer">
      {onAttach !== undefined || attachDisabledReason ? (
        <button
          type="button"
          className="icon-btn"
          onClick={onAttach}
          disabled={!onAttach}
          aria-label="Attach files"
          title={attachDisabledReason ?? 'Attach files'}
        >
          <Paperclip />
        </button>
      ) : null}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={placeholder ?? 'Tell ZVYRA what to do…'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        aria-label="Message"
      />
      {extra}
      {onModel && <ModelSelect value={model} onChange={onModel} className="composer-model" />}
      <button
        type="button"
        className={`mic-btn ${listening ? 'live' : ''}`}
        style={{ ['--lvl' as string]: level.toFixed(3) }}
        onClick={() => void toggleListening(source)}
        aria-label={listening ? 'Stop listening' : 'Speak'}
        title={listening ? 'Stop listening' : 'Speak to ZVYRA'}
      >
        {listening ? <Square /> : <Mic />}
      </button>
      {busy && onStop ? (
        <button type="button" className="send-btn" onClick={onStop} aria-label="Stop generating" title="Stop generating">
          <Square style={{ fill: 'currentColor', width: 13 }} />
        </button>
      ) : (
        <button type="button" className="send-btn" onClick={onSubmit} disabled={!value.trim() || busy} aria-label="Send" title="Send (Enter)">
          <Send />
        </button>
      )}
    </div>
  )
})
