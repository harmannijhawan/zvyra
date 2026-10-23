import { AlarmClockOff, Bell, BellOff, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DeepPartial, NotificationCategory, NotificationPolicy, NotificationPriority } from '@shared/contract'
import { Button, Card } from '../../components/ui'
import { call, errorMessage } from '../../lib/client'
import { dateTime, humanize } from '../../lib/format'
import { setState, useStore } from '../../lib/store'
import { attempt } from '../../lib/useAction'
import { Row, SettingToggle } from './common'

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
    </div>
  )
}
