import { AlarmClockOff, Bell, BellOff, Phone, PhoneCall, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CallProviderStatus, DeepPartial, NotificationCategory, NotificationPolicy, NotificationPriority } from '@shared/contract'
import { Badge, Button, Card, ConfirmDialog, Toggle } from '../../components/ui'
import { call, errorMessage } from '../../lib/client'
import { dateTime, humanize } from '../../lib/format'
import { setState, useStore } from '../../lib/store'
import { attempt, useAction } from '../../lib/useAction'
import { ConfigForm, Row, SettingToggle } from './common'

const PRIORITIES: NotificationPriority[] = ['low', 'normal', 'high', 'critical']
const CATEGORIES: { id: NotificationCategory; label: string }[] = [
  { id: 'task_completed', label: 'Important task completed' },
  { id: 'task_blocked', label: 'Task blocked / needs a decision' },
  { id: 'error', label: 'Critical errors' },
  { id: 'discovery', label: 'Important discoveries' },
  { id: 'long_running', label: 'Long-running job updates' },
  { id: 'custom', label: 'Your own triggers' }
]

export function NotificationSettings() {
  const policy = useStore((s) => s.notificationPolicy)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    call('notifications.policy')
      .then((p) => setState({ notificationPolicy: p }))
      .catch((e) => setErr(errorMessage(e)))
  }, [])

  const update = async (patch: DeepPartial<NotificationPolicy>) => {
    const prev = policy
    const next = await attempt(() => call('notifications.setPolicy', patch), { errorTitle: 'Notification setting not changed' })
    setState({ notificationPolicy: next ?? prev })
  }

  if (!policy) return err ? <div className="notice warning">{err}</div> : null
  const snoozed = policy.snoozedUntil && Date.parse(policy.snoozedUntil) > Date.now()

  return (
    <div className="stack">
      <Card title="Notifications" icon={Bell} actions={<Button size="sm" icon={Send} onClick={() => void attempt(() => call('notifications.test'), { success: 'Test sent' })}>Send test</Button>}>
        <SettingToggle label="Proactive notifications" help="Master switch for everything ZVYRA tells you on its own." value={policy.enabled} onChange={(v) => void update({ enabled: v })} />
        <SettingToggle label="Desktop notifications" value={policy.desktop} onChange={(v) => void update({ desktop: v })} />
        <SettingToggle label="Spoken announcements" help="ZVYRA says important updates out loud." value={policy.spoken} onChange={(v) => void update({ spoken: v })} />
        <Row label="Speak when priority is at least">
          <select className="select" value={policy.spokenMinPriority} onChange={(e) => void update({ spokenMinPriority: e.target.value as NotificationPriority })} aria-label="Spoken minimum priority" disabled={!policy.spoken}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {humanize(p)}
              </option>
            ))}
          </select>
        </Row>
        {CATEGORIES.map((c) => (
          <SettingToggle key={c.id} label={c.label} value={policy.categories[c.id]} onChange={(v) => void update({ categories: { [c.id]: v } })} />
        ))}
      </Card>

      <Card title="Focus & quiet hours" icon={BellOff}>
        <SettingToggle label="Do not disturb" help="Pauses all proactive communication until turned off." value={policy.doNotDisturb} onChange={(v) => void update({ doNotDisturb: v })} />
        <Row label="Snooze" help={snoozed ? `Snoozed until ${dateTime(policy.snoozedUntil!)}` : 'Pause notifications for a while.'}>
          {snoozed ? (
            <Button size="sm" icon={AlarmClockOff} onClick={() => void attempt(() => call('notifications.snooze', { minutes: null })).then((p) => p && setState({ notificationPolicy: p }))}>
              End snooze
            </Button>
          ) : (
            [30, 60, 240].map((m) => (
              <Button key={m} size="sm" onClick={() => void attempt(() => call('notifications.snooze', { minutes: m })).then((p) => p && setState({ notificationPolicy: p }))}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </Button>
            ))
          )}
        </Row>
        <SettingToggle label="Quiet hours" value={policy.quietHours.enabled} onChange={(v) => void update({ quietHours: { ...policy.quietHours, enabled: v } })} />
        <Row label="From – to">
          <input type="time" className="input" style={{ width: 120 }} value={policy.quietHours.start} onChange={(e) => void update({ quietHours: { ...policy.quietHours, start: e.target.value } })} aria-label="Quiet hours start" />
          <span className="muted">to</span>
          <input type="time" className="input" style={{ width: 120 }} value={policy.quietHours.end} onChange={(e) => void update({ quietHours: { ...policy.quietHours, end: e.target.value } })} aria-label="Quiet hours end" />
        </Row>
        <SettingToggle label="Let critical alerts through" value={policy.quietHours.allowCritical} onChange={(v) => void update({ quietHours: { ...policy.quietHours, allowCritical: v } })} />
      </Card>

      <CallSettings />
    </div>
  )
}

function CallSettings() {
  const [s, setS] = useState<CallProviderStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [provider, setProvider] = useState('')
  const [confirmTest, setConfirmTest] = useState(false)
  const [run, busy] = useAction()
  useEffect(() => {
    call('calls.status')
      .then((r) => {
        setS(r)
        setProvider(r.provider ?? r.providers[0]?.id ?? '')
      })
      .catch((e) => setErr(errorMessage(e)))
  }, [])
  return (
    <Card title="Work calls" icon={Phone}>
      <div className="notice" style={{ marginBottom: 12 }}>
        <PhoneCall />
        <span>ZVYRA only places a phone call after you configure a supported provider and enable calls. It never shows a pretend call.</span>
      </div>
      {err && <div className="notice warning">{err}</div>}
      {s && (
        <>
          <Row label="Status">
            <Badge tone={s.configured ? 'success' : 'warning'}>{s.configured ? 'Provider configured' : 'Not configured'}</Badge>
            {s.destinationMasked && <span className="mono">{s.destinationMasked}</span>}
          </Row>
          {s.providers.length === 0 ? (
            <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>The connected backend doesn’t offer a calling provider yet.</div>
          ) : (
            <>
              <Row label="Provider">
                <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Call provider">
                  {s.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Row>
              <div style={{ padding: '6px 0 12px' }}>
                <ConfigForm
                  fields={s.fields}
                  busy={busy}
                  submitLabel="Save provider"
                  onSubmit={(values) => void run(() => call('calls.configure', { provider, values }), { success: 'Call provider saved' }).then((r) => r && setS(r))}
                />
              </div>
            </>
          )}
          <Row label="Call me for urgent alerts" help="Blocked or critical work, by the priority below.">
            <Toggle
              checked={s.enabled}
              disabled={!s.configured}
              label="Allow calls"
              onChange={(v) => void run(() => call('calls.setEnabled', { enabled: v })).then((r) => r && setS(r))}
            />
          </Row>
          <Row label="Call me when a task finishes while I’m away" help="Away = no keyboard or mouse for the time below, or the PC is locked. You can always say “call me”.">
            <Toggle
              checked={s.callWhenAway ?? true}
              disabled={!s.configured}
              label="Call when away"
              onChange={(v) => void run(() => call('calls.setEnabled', { enabled: s.enabled, callWhenAway: v })).then((r) => r && setS(r))}
            />
          </Row>
          <Row label="Away after">
            <select
              className="select"
              value={String(s.awayMinutes ?? 5)}
              disabled={!s.configured || s.callWhenAway === false}
              onChange={(e) => void run(() => call('calls.setEnabled', { enabled: s.enabled, awayMinutes: Number(e.target.value) })).then((r) => r && setS(r))}
              aria-label="Minutes before you count as away"
            >
              {[2, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </Row>
          <Row label="Only call for priority">
            <select
              className="select"
              value={s.minPriority}
              disabled={!s.configured}
              onChange={(e) => void run(() => call('calls.setEnabled', { enabled: s.enabled, minPriority: e.target.value as NotificationPriority })).then((r) => r && setS(r))}
              aria-label="Minimum priority for calls"
            >
              <option value="high">High and critical</option>
              <option value="critical">Critical only</option>
            </select>
          </Row>
          <Row label="Test call" help={s.lastCall ? `Last: ${s.lastCall.status}${s.lastCall.reference ? ` (${s.lastCall.reference})` : ''}${s.lastCall.error ? ` — ${s.lastCall.error}` : ''} · ${dateTime(s.lastCall.ts)}` : undefined}>
            <Button size="sm" icon={PhoneCall} disabled={!s.configured} onClick={() => setConfirmTest(true)}>
              Place test call
            </Button>
          </Row>
        </>
      )}
      <ConfirmDialog
        open={confirmTest}
        title="Place a real test call?"
        body="Your provider will call the configured number. Standard provider charges apply."
        confirmLabel="Call now"
        onClose={() => setConfirmTest(false)}
        onConfirm={() => void run(() => call('calls.test'), { success: 'Call placed by provider' }).then((r) => r && setS(r))}
      />
    </Card>
  )
}
