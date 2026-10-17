/** Settings — every preference persists through settings.update or its domain method. */
import {
  Bell,
  Database,
  Keyboard,
  Mic,
  Monitor,
  Palette,
  Plug,
  Power,
  ShieldCheck,
  Smartphone,
  Stethoscope,
  TerminalSquare,
  User,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CommandRule, PermissionCategory, PermissionPolicy, PermissionPolicyEntry } from '@shared/contract'
import { Button, Card, ConfirmDialog, Segmented } from '../components/ui'
import { call, errorMessage, shellCall } from '../lib/client'
import { humanize } from '../lib/format'
import { navigate, useStore } from '../lib/store'
import { attempt } from '../lib/useAction'
import { toast } from '../lib/toast'
import { patchSettings, Row, SettingToggle, ShortcutInput, useSettings } from './settings/common'
import { DiagnosticsSettings } from './settings/Diagnostics'
import { NotificationSettings } from './settings/Notifications'
import { AiSettings } from './settings/AiModels'
import { VoiceSettings } from './settings/Voice'

const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'island', label: 'Dynamic Island', icon: Smartphone },
  { id: 'voice', label: 'Voice & microphone', icon: Mic },
  { id: 'ai', label: 'AI & models', icon: Plug },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'notifications', label: 'Notifications & calls', icon: Bell },
  { id: 'startup', label: 'Startup & background', icon: Power },
  { id: 'data', label: 'Data & privacy', icon: Database },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'diagnostics', label: 'Logs & diagnostics', icon: Stethoscope }
]

export function Settings({ section = 'profile' }: { section?: string }) {
  const id = section === 'swarm' ? 'ai' : section // old deep links
  const current = SECTIONS.find((s) => s.id === id) ?? SECTIONS[0]
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>{current.label}</p>
        </div>
      </header>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" aria-current={s.id === current.id} onClick={() => navigate(`settings/${s.id}`)}>
              <s.icon /> {s.label}
            </button>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <Section id={current.id} />
        </div>
      </div>
    </div>
  )
}

function Section({ id }: { id: string }) {
  switch (id) {
    case 'appearance':
      return <Appearance />
    case 'island':
      return <IslandSettings />
    case 'voice':
      return <VoiceSettings />
    case 'ai':
      return <AiSettings />
    case 'permissions':
      return (
        <div className="stack">
          <AutonomousMode />
          <Permissions />
          <CommandRules />
        </div>
      )
    case 'notifications':
      return <NotificationSettings />
    case 'startup':
      return <Startup />
    case 'data':
      return <DataPrivacy />
    case 'shortcuts':
      return <Shortcuts />
    case 'diagnostics':
      return <DiagnosticsSettings />
    default:
      return <Profile />
  }
}

function Profile() {
  const s = useSettings()
  const [name, setName] = useState(s?.profile.name ?? '')
  useEffect(() => setName(s?.profile.name ?? ''), [s?.profile.name])
  if (!s) return null
  return (
    <Card title="Profile" icon={User}>
      <Row label="Your name" help="Used in greetings. Stored locally.">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== s.profile.name && void patchSettings({ profile: { name: name.trim() } })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Your name" />
      </Row>
    </Card>
  )
}

function Appearance() {
  const s = useSettings()
  if (!s) return null
  return (
    <Card title="Appearance" icon={Palette}>
      <Row label="Theme">
        <Segmented
          label="Theme"
          value={s.appearance.theme}
          onChange={(theme) => void patchSettings({ appearance: { theme } })}
          options={[
            { value: 'midnight', label: 'Midnight' },
            { value: 'deep', label: 'Deep navy' }
          ]}
        />
      </Row>
      <SettingToggle label="Reduce motion" help="Calmer companion and fewer animations." value={s.appearance.reduceMotion} onChange={(v) => void patchSettings({ appearance: { reduceMotion: v } })} />
      <Row label="Interface size">
        <select className="select" value={s.appearance.uiScale} onChange={(e) => void patchSettings({ appearance: { uiScale: Number(e.target.value) } })} aria-label="Interface size">
          {[0.9, 1, 1.1, 1.25].map((n) => (
            <option key={n} value={n}>
              {Math.round(n * 100)}%
            </option>
          ))}
        </select>
      </Row>
    </Card>
  )
}

function IslandSettings() {
  const s = useSettings()
  const island = useStore((st) => st.island)
  if (!s) return null
  return (
    <Card title="Dynamic Island" icon={Smartphone}>
      <SettingToggle label="Show the Dynamic Island" help="The floating companion stays available over other apps." value={s.island.enabled} onChange={(v) => void patchSettings({ island: { enabled: v } })} />
      <SettingToggle
        label="Keep above other windows"
        value={s.island.alwaysOnTop}
        onChange={(v) => void attempt(() => shellCall('island.setAlwaysOnTop', { value: v })).then(() => patchSettings({ island: { alwaysOnTop: v } }))}
      />
      <Row label="Close button" help="What × on the island does. ZVYRA keeps running in the tray either way.">
        <select className="select" value={s.island.closeBehavior} onChange={(e) => void patchSettings({ island: { closeBehavior: e.target.value as 'hide' | 'minimize' } })} aria-label="Close behaviour">
          <option value="hide">Hide the island</option>
          <option value="minimize">Shrink to mini island</option>
        </select>
      </Row>
      <SettingToggle label="Show waveform" value={s.island.showWaveform} onChange={(v) => void patchSettings({ island: { showWaveform: v } })} />
      <SettingToggle label="Expand when I say the wake word" value={s.island.expandOnWake} onChange={(v) => void patchSettings({ island: { expandOnWake: v } })} />
      <SettingToggle
        label="Stay awake"
        help="After the wake word, ZVYRA keeps the conversation and the island active until you say “go to sleep” or press stop. Turn off to fall asleep after a short silence. Audio is sent to Gemini while a conversation is active."
        value={s.assistant?.stayAwake ?? true}
        onChange={(v) => void patchSettings({ assistant: { stayAwake: v } })}
      />
      <Row label="Position" help="Move the island back to the top centre of your main display.">
        <Button size="sm" onClick={() => void attempt(() => shellCall('island.resetPosition'), { success: 'Island moved' })}>
          Reset position
        </Button>
        <Button size="sm" icon={Monitor} onClick={() => void attempt(() => shellCall(island?.visible ? 'island.hide' : 'island.show'))}>
          {island?.visible ? 'Hide now' : 'Show now'}
        </Button>
      </Row>
    </Card>
  )
}

const PERM_HELP: Record<PermissionCategory, string> = {
  read_files: 'Read files in authorised folders',
  write_files: 'Create or change files',
  delete_files: 'Delete files or folders',
  run_commands: 'Run terminal commands',
  open_apps: 'Launch applications',
  browser: 'Open and use web pages',
  network: 'Fetch data from the internet',
  computer_input: 'Control mouse and keyboard',
  screen_capture: 'Look at your screen',
  memory_write: 'Save things to memory',
  external_communication: 'Send emails, messages or posts',
  system_settings: 'Change Windows settings'
}

function Permissions() {
  const [entries, setEntries] = useState<PermissionPolicyEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pendingAllow, setPendingAllow] = useState<PermissionCategory | null>(null)
  useEffect(() => {
    call('permissions.policies')
      .then(setEntries)
      .catch((e) => setErr(errorMessage(e)))
  }, [])
  const set = async (category: PermissionCategory, policy: PermissionPolicy) => {
    const next = await attempt(() => call('permissions.setPolicy', { category, policy }), { errorTitle: 'Permission not changed' })
    if (next) setEntries(next)
  }
  const risky: PermissionCategory[] = ['run_commands', 'computer_input', 'write_files', 'system_settings', 'screen_capture']
  return (
    <Card title="What ZVYRA may do" icon={ShieldCheck}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <ShieldCheck />
        <span>
          “Ask” pauses the task and shows an approval card on the Dynamic Island and in Tasks. Commands ZVYRA wants to run are checked first: read-only ones run, installs, scripts and changes ask, and dangerous system commands are blocked. Commands you type in Terminal only ask when they are high risk.
        </span>
      </div>
      {err && <div className="notice warning">{err}</div>}
      {entries?.map((e) => {
        // An empty allowedPolicies list means the engine locks this category.
        const options = (['allow', 'ask', 'deny'] as const).filter((p) => e.allowedPolicies.includes(p))
        return (
          <Row key={e.category} label={humanize(e.category)} help={PERM_HELP[e.category]}>
            {options.length > 1 ? (
              <Segmented
                label={humanize(e.category)}
                value={e.policy}
                onChange={(p) => (p === 'allow' && risky.includes(e.category) ? setPendingAllow(e.category) : void set(e.category, p))}
                options={options.map((p) => ({ value: p, label: humanize(p) }))}
              />
            ) : (
              <span className={`badge ${e.policy === 'allow' ? 'success' : e.policy === 'deny' ? 'danger' : 'warning'}`} title="Locked by ZVYRA’s safety rules">
                {e.policy === 'ask' ? 'Always asks' : humanize(e.policy)}
              </span>
            )}
          </Row>
        )
      })}
      <ConfirmDialog
        open={!!pendingAllow}
        title="Allow without asking?"
        body={`ZVYRA will be able to ${pendingAllow ? PERM_HELP[pendingAllow].toLowerCase() : ''} without asking you first. You can stop any task at any time.`}
        confirmLabel="Allow"
        danger
        onClose={() => setPendingAllow(null)}
        onConfirm={() => pendingAllow && void set(pendingAllow, 'allow')}
      />
    </Card>
  )
}

/** Autonomous mode: ZVYRA runs commands and continues tasks without approval popups. */
function AutonomousMode() {
  const s = useSettings()
  const [confirm, setConfirm] = useState(false)
  if (!s) return null
  const on = !!s.assistant?.autonomous
  return (
    <Card title="Autonomous mode" icon={ShieldCheck}>
      <SettingToggle
        label="Don’t ask for permission"
        help="ZVYRA runs installs, scripts, file changes and other commands, and lets tasks continue, without approval popups. Every action is still risk-checked and logged in Activity. Dangerous system commands (formatting disks, turning off security, admin elevation) stay blocked."
        value={on}
        onChange={(v) => (v ? setConfirm(true) : void patchSettings({ assistant: { autonomous: false } }))}
      />
      <ConfirmDialog
        open={confirm}
        title="Turn on autonomous mode?"
        body="ZVYRA will run commands, including deleting files and changing settings, without asking you first. You can stop everything at any time with the stop shortcut or turn this off here."
        confirmLabel="Turn on"
        danger
        onClose={() => setConfirm(false)}
        onConfirm={() => void patchSettings({ assistant: { autonomous: true } })}
      />
    </Card>
  )
}

/** Review and revoke "Always allow" command rules. */
function CommandRules() {
  const [rules, setRules] = useState<CommandRule[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    call('permissions.rules')
      .then(setRules)
      .catch((e) => setErr(errorMessage(e)))
  }, [])
  const revoke = async (id: string) => {
    const next = await attempt(() => call('permissions.revokeRule', { id }), { success: 'Rule removed', errorTitle: 'Rule not removed' })
    if (next) setRules(next)
  }
  return (
    <Card title="Always-allowed commands" icon={TerminalSquare}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <ShieldCheck />
        <span>
          Each rule allows one exact command, in one shell, in one folder — nothing else. High-risk commands are never saved, and blocked commands (security, disk and system changes) can’t be allowed at all.
        </span>
      </div>
      {err && <div className="notice warning">{err}</div>}
      {rules && !rules.length && <div className="muted" style={{ padding: '6px 2px' }}>No saved rules. Choose “Always Allow” on an approval to add one.</div>}
      {rules?.map((r) => (
        <Row
          key={r.id}
          label={<code className="rule-cmd selectable">{r.command}</code>}
          help={`${r.shell === 'cmd' ? 'Command Prompt' : 'PowerShell'} · ${r.cwd} · ${r.uses ? `used ${r.uses}×${r.lastUsedAt ? `, last ${new Date(r.lastUsedAt).toLocaleString()}` : ''}` : 'not used yet'}`}
        >
          <Button size="sm" variant="ghost" onClick={() => void revoke(r.id)}>
            Revoke
          </Button>
        </Row>
      ))}
    </Card>
  )
}

function Startup() {
  const s = useSettings()
  if (!s) return null
  return (
    <div className="stack">
      <Card title="Startup & tray" icon={Power}>
        <SettingToggle label="Start with Windows" value={s.startup.openAtLogin} onChange={(v) => void patchSettings({ startup: { openAtLogin: v } })} />
        <SettingToggle label="Start hidden" help="Only the Dynamic Island and tray icon appear at startup." value={s.startup.startHidden} onChange={(v) => void patchSettings({ startup: { startHidden: v } })} />
        <SettingToggle label="Closing the window keeps ZVYRA in the tray" help="Turn off to quit when the main window closes." value={s.tray.closeToTray} onChange={(v) => void patchSettings({ tray: { closeToTray: v } })} />
        <Row label="Quit ZVYRA" help="Stops the companion, wake word and background tasks.">
          <Button size="sm" variant="danger" onClick={() => void shellCall('app.quit')}>
            Quit now
          </Button>
        </Row>
      </Card>
      <Card title="Background work">
        <SettingToggle label="Keep working in the background" help="Tasks continue while windows are hidden. Nothing runs after ZVYRA quits." value={s.background.allowBackgroundTasks} onChange={(v) => void patchSettings({ background: { allowBackgroundTasks: v } })} />
        <Row label="Tasks at the same time">
          <select className="select" value={s.background.maxConcurrentTasks} onChange={(e) => void patchSettings({ background: { maxConcurrentTasks: Number(e.target.value) } })} aria-label="Concurrent tasks">
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
        <SettingToggle label="Resume queued tasks on start" help="Tasks that never started are picked up again. Interrupted tasks wait for you." value={s.background.resumeQueuedOnStart} onChange={(v) => void patchSettings({ background: { resumeQueuedOnStart: v } })} />
      </Card>
    </div>
  )
}

function DataPrivacy() {
  const s = useSettings()
  const [confirm, setConfirm] = useState(false)
  if (!s) return null
  const days = (v: number | null) => (v === null ? '' : String(v))
  return (
    <Card title="Data & privacy" icon={Database}>
      <Row label="Keep task history">
        <select className="select" value={days(s.data.keepTaskHistoryDays)} onChange={(e) => void patchSettings({ data: { keepTaskHistoryDays: e.target.value ? Number(e.target.value) : null } })} aria-label="Task history retention">
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
          <option value="">Forever</option>
        </select>
      </Row>
      <Row label="Keep activity log">
        <select className="select" value={days(s.data.keepActivityDays)} onChange={(e) => void patchSettings({ data: { keepActivityDays: e.target.value ? Number(e.target.value) : null } })} aria-label="Activity retention">
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="">Forever</option>
        </select>
      </Row>
      <Row label="Memory" help="Review and delete what ZVYRA remembers.">
        <Button size="sm" onClick={() => navigate('memory')}>
          Manage memory
        </Button>
      </Row>
      <Row label="Clear finished tasks">
        <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
          Clear history
        </Button>
      </Row>
      <Row label="Data folder" help="Where conversations, tasks and settings are stored on this PC.">
        <Button size="sm" onClick={() => void attempt(() => call('system.openDataFolder'))}>
          Open folder
        </Button>
      </Row>
      <ConfirmDialog
        open={confirm}
        title="Clear finished tasks?"
        body="Completed, failed and cancelled tasks will be removed."
        confirmLabel="Clear"
        danger
        onClose={() => setConfirm(false)}
        onConfirm={() => void attempt(() => call('tasks.clearHistory')).then((r) => r && toast({ tone: 'success', title: `Removed ${r.removed} task(s)` }))}
      />
    </Card>
  )
}

function Shortcuts() {
  const s = useSettings()
  if (!s) return null
  const rows: { key: keyof typeof s.shortcuts; label: string; help: string }[] = [
    { key: 'pushToTalk', label: 'Push to talk', help: 'Start/stop listening from anywhere' },
    { key: 'toggleIsland', label: 'Show / hide Dynamic Island', help: 'Works from any app' },
    { key: 'showMain', label: 'Open ZVYRA', help: 'Bring the main window forward' },
    { key: 'stopAll', label: 'Emergency stop', help: 'Cancel all tasks and computer control' }
  ]
  return (
    <div className="stack">
      <Card title="Global shortcuts" icon={Keyboard}>
        {rows.map((r) => (
          <Row key={r.key} label={r.label} help={r.help}>
            <ShortcutInput label={r.label} value={s.shortcuts[r.key]} onChange={(v) => void patchSettings({ shortcuts: { [r.key]: v } })} />
          </Row>
        ))}
        <div className="muted" style={{ fontSize: 12, paddingTop: 8 }}>
          Click a shortcut and press the new combination. Backspace clears it, Esc cancels. Shortcuts already used by another app can’t be registered.
        </div>
      </Card>
      <Card title="In the app">
        <Row label="Switch sections" help="Home, Chat, Tasks…">
          <span className="kbd">Ctrl</span>+<span className="kbd">1–9</span>
        </Row>
        <Row label="Settings">
          <span className="kbd">Ctrl</span>+<span className="kbd">,</span>
        </Row>
        <Row label="Send message">
          <span className="kbd">Enter</span> <span className="muted">· new line</span> <span className="kbd">Shift</span>+<span className="kbd">Enter</span>
        </Row>
        <Row label="Collapse the island">
          <span className="kbd">Esc</span>
        </Row>
      </Card>
    </div>
  )
}
