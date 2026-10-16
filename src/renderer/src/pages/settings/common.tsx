import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings, ConfigField, DeepPartial } from '@shared/contract'
import { deepMerge } from '@shared/defaults'
import { Button, Field, Toggle } from '../../components/ui'
import { call } from '../../lib/client'
import { getState, setState, useStore } from '../../lib/store'
import { reportError } from '../../lib/useAction'
import { toAccelerator } from '../../lib/accelerator'

export function Row({ label, help, children }: { label: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">{label}</div>
        {help && <div className="set-help">{help}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

/** Optimistic settings update with rollback when the backend rejects the patch. */
export async function patchSettings(patch: DeepPartial<AppSettings>) {
  const prev = getState().settings
  if (prev) setState({ settings: deepMerge(prev, patch) })
  try {
    const next = await call('settings.update', patch)
    setState({ settings: next })
    return next
  } catch (err) {
    setState({ settings: prev })
    reportError(err, 'Setting not changed')
    return undefined
  }
}

export function useSettings() {
  return useStore((s) => s.settings)
}

export function SettingToggle({ label, help, value, onChange }: { label: string; help?: ReactNode; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} help={help}>
      <Toggle checked={value} onChange={onChange} label={label} />
    </Row>
  )
}

/** Renders backend-described config fields. Secret fields are write-only. */
export function ConfigForm({
  fields,
  onSubmit,
  submitLabel = 'Save',
  busy
}: {
  fields: ConfigField[]
  onSubmit: (values: Record<string, string | number | boolean>) => void
  submitLabel?: string
  busy?: boolean
}) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({})
  useEffect(() => {
    const init: Record<string, string | number | boolean> = {}
    for (const f of fields) init[f.key] = f.type === 'secret' ? '' : (f.value ?? (f.type === 'boolean' ? false : ''))
    setValues(init)
  }, [fields])
  if (!fields.length) return null
  const missing = fields.some((f) => f.required && f.type !== 'secret' && f.type !== 'boolean' && !String(values[f.key] ?? '').trim()) ||
    fields.some((f) => f.required && f.type === 'secret' && !f.hasValue && !String(values[f.key] ?? '').trim())
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="form-grid">
        {fields.map((f) => {
          const id = `cfg-${f.key}`
          const set = (v: string | number | boolean) => setValues((s) => ({ ...s, [f.key]: v }))
          return (
            <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} htmlFor={id} help={f.help ?? (f.type === 'secret' && f.hasValue ? 'Saved securely. Leave blank to keep it.' : undefined)}>
              {f.type === 'select' ? (
                <select id={id} className="select" value={String(values[f.key] ?? '')} onChange={(e) => set(e.target.value)}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'boolean' ? (
                <Toggle checked={!!values[f.key]} onChange={set} label={f.label} />
              ) : (
                <input
                  id={id}
                  className="input"
                  type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  autoComplete="off"
                  placeholder={f.type === 'secret' && f.hasValue ? '••••••••  (saved)' : f.placeholder}
                  value={String(values[f.key] ?? '')}
                  onChange={(e) => set(f.type === 'number' ? Number(e.target.value) : e.target.value)}
                />
              )}
            </Field>
          )
        })}
      </div>
      <div>
        <Button variant="primary" disabled={missing} loading={busy} onClick={() => onSubmit(values)}>
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

export function ShortcutInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [recording, setRecording] = useState(false)
  return (
    <div className="row">
      <button
        type="button"
        className="input mono"
        style={{ width: 220, textAlign: 'left', cursor: 'pointer', outlineColor: recording ? 'var(--accent)' : undefined }}
        aria-label={`${label} shortcut: ${value || 'none'}. Press to record.`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return
          e.preventDefault()
          if (e.key === 'Escape') return setRecording(false)
          if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey) {
            onChange('')
            return setRecording(false)
          }
          const acc = toAccelerator(e)
          if (acc) {
            onChange(acc)
            setRecording(false)
          }
        }}
      >
        {recording ? 'Press keys…' : value || 'Not set'}
      </button>
    </div>
  )
}
