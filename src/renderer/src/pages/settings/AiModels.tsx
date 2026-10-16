import { ArrowDown, ArrowUp, CheckCircle2, KeyRound, Plug, Plus, RefreshCw, Route, Server, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RoutingConfig, RoutingRole } from '@shared/contract'
import { ModelSelect } from '../../components/Composer'
import { Badge, Button, Card, Field, IconButton, KeyValue, Segmented } from '../../components/ui'
import { call, errorMessage } from '../../lib/client'
import { timeAgo } from '../../lib/format'
import { loadModels, useModels } from '../../lib/models'
import { setState, useStore } from '../../lib/store'
import { attempt, useAction } from '../../lib/useAction'
import { Row } from './common'

const ROLES: { id: RoutingRole; label: string; help: string }[] = [
  { id: 'general', label: 'General', help: 'Default for tasks and planning' },
  { id: 'conversation', label: 'Conversation', help: 'Chat and quick replies' },
  { id: 'coding', label: 'Coding', help: 'Code Studio and the Code agent' },
  { id: 'research', label: 'Research', help: 'Reading and summarising sources' },
  { id: 'computer', label: 'Computer', help: 'Screen understanding' },
  { id: 'voice', label: 'Voice', help: 'Spoken requests' }
]

export function AiSettings() {
  const conn = useStore((s) => s.swarm)
  const { models, loading, error: modelsError } = useModels()
  const [endpoint, setEndpoint] = useState(conn?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [routing, setRouting] = useState<RoutingConfig | null>(null)
  const [routingErr, setRoutingErr] = useState<string | null>(null)
  const [run, busy] = useAction()
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    setEndpoint(conn?.baseUrl ?? '')
  }, [conn?.baseUrl])
  useEffect(() => {
    call('swarm.connection').then((c) => setState({ swarm: c })).catch(() => undefined)
    call('routing.get')
      .then(setRouting)
      .catch((e) => setRoutingErr(errorMessage(e)))
  }, [])

  const save = async () => {
    const c = await run(() => call('swarm.configure', { baseUrl: endpoint.trim(), apiKey: apiKey ? apiKey : undefined }), { success: 'Connection saved' })
    if (c) {
      setState({ swarm: c })
      setApiKey('')
    }
  }
  const test = async () => {
    setTesting(true)
    const c = await attempt(() => call('swarm.test'))
    setTesting(false)
    if (c) {
      setState({ swarm: c })
      if (c.status === 'connected') void loadModels(true)
    }
  }
  const clearKey = async () => {
    const c = await run(() => call('swarm.configure', { baseUrl: endpoint.trim() || conn?.baseUrl || '', apiKey: '' }), { success: 'API key removed' })
    if (c) setState({ swarm: c })
  }
  const setRoute = async (patch: Partial<RoutingConfig>) => {
    if (!routing) return
    const prev = routing
    setRouting({ ...routing, ...patch, roles: { ...routing.roles, ...(patch.roles ?? {}) } })
    const next = await attempt(() => call('routing.set', patch), { errorTitle: 'Routing not changed' })
    setRouting(next ?? prev)
  }

  const presets = conn?.endpointPresets
  const status = conn?.status ?? 'disconnected'
  const usable = models.filter((m) => m.available)

  return (
    <div className="stack">
      <Card title="AI provider" icon={Plug}>
        <div className="row" style={{ marginBottom: 12 }}>
          {status === 'connected' ? <CheckCircle2 style={{ color: 'var(--success)' }} /> : <XCircle style={{ color: status === 'error' ? 'var(--danger)' : 'var(--text-3)' }} />}
          <div className="li-body">
            <div className="li-title">{status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Connection failed' : 'Not connected'}</div>
            <div className="li-sub" style={{ whiteSpace: 'normal' }}>
              {conn?.error ?? (conn?.lastCheckedAt ? `Checked ${timeAgo(conn.lastCheckedAt)}${conn.latencyMs ? ` · ${conn.latencyMs} ms` : ''}` : 'Not tested yet')}
            </div>
          </div>
          <Button icon={RefreshCw} loading={testing} onClick={() => void test()}>
            Test connection
          </Button>
        </div>
        <div className="form-grid">
          <Field label="Provider" htmlFor="ai-provider" help="Which AI service ZVYRA uses. ✓ means a key is saved.">
            {presets?.length ? (
              <select id="ai-provider" className="select" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
                {!presets.some((p) => p.value === endpoint) && endpoint && <option value={endpoint}>{endpoint}</option>}
                {presets.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                    {p.configured ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input id="ai-provider" className="input mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="Provider endpoint" />
            )}
          </Field>
          <Field
            label="API key"
            htmlFor="ai-key"
            help={conn?.hasApiKey ? 'A key is stored in the Windows credential store. Leave blank to keep it.' : 'Stored encrypted on this PC; never shown again.'}
          >
            <div className="row">
              <input
                id="ai-key"
                className="input"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={conn?.hasApiKey ? '••••••••  (saved)' : 'Paste your key'}
              />
              {conn?.hasApiKey && <IconButton icon={Trash2} label="Remove stored key" onClick={() => void clearKey()} />}
            </div>
          </Field>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Button variant="primary" icon={KeyRound} loading={busy} disabled={!endpoint.trim()} onClick={() => void save()}>
            Save connection
          </Button>
          <span className="muted" style={{ fontSize: 12 }}>Then press Test connection. ZVYRA also reconnects automatically when it starts.</span>
        </div>
        {conn?.account && conn.account.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <KeyValue items={conn.account.map((a) => ({ label: a.label, value: a.value }))} />
          </div>
        )}
      </Card>

      <Card
        title="Models"
        icon={Server}
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={() => void loadModels(true)}>
            Discover
          </Button>
        }
      >
        {modelsError && <div className="notice warning">{modelsError}</div>}
        {!modelsError && models.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No models discovered. Connect an AI provider, then press Discover.</div>}
        {models.length > 0 && (
          <div className="list" style={{ maxHeight: 280, overflow: 'auto' }}>
            {models.map((m) => (
              <div key={m.id} className="list-item" style={{ padding: '7px 6px' }}>
                <span className="li-body">
                  <div className="li-title mono">{m.id}</div>
                  <div className="li-sub">
                    {[m.ownedBy, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : null, m.pricing?.inputPerMillion !== undefined ? `$${m.pricing.inputPerMillion}/M in` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </span>
                {m.supportsVision && <Badge tone="info">Vision</Badge>}
                <Badge tone={m.available ? 'success' : 'neutral'}>{m.available ? 'Available' : 'Unavailable'}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Routing" icon={Route}>
        {routingErr && <div className="notice warning">{routingErr}</div>}
        {routing && (
          <>
            <Row label="Mode" help="Automatic picks the best available model for each job; Manual pins the models below (ZVYRA may still fall back if a model fails).">
              <Segmented
                label="Routing mode"
                value={routing.mode}
                onChange={(mode) => void setRoute({ mode })}
                options={[
                  { value: 'auto', label: 'Automatic' },
                  { value: 'manual', label: 'Manual' }
                ]}
              />
            </Row>
            {ROLES.map((r) => (
              <Row key={r.id} label={r.label} help={r.help}>
                <ModelSelect value={routing.roles[r.id] ?? undefined} onChange={(m) => void setRoute({ roles: { ...routing.roles, [r.id]: m ?? null } })} />
              </Row>
            ))}
            <Row label="Request timeout">
              <select className="select" value={routing.timeoutMs} onChange={(e) => void setRoute({ timeoutMs: Number(e.target.value) })} aria-label="Timeout">
                {[15000, 30000, 60000, 120000, 300000].map((n) => (
                  <option key={n} value={n}>
                    {n / 1000} seconds
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Fallback attempts" help="How many alternative models to try after a failure.">
              <select className="select" value={routing.maxRetries} onChange={(e) => void setRoute({ maxRetries: Number(e.target.value) })} aria-label="Fallback attempts">
                {[0, 1, 2, 3, 5].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'None' : n}
                  </option>
                ))}
              </select>
            </Row>
            <FallbackList value={routing.fallbacks} options={usable.map((m) => m.id)} onChange={(fallbacks) => void setRoute({ fallbacks })} />
          </>
        )}
      </Card>
    </div>
  )
}

function FallbackList({ value, options, onChange }: { value: string[]; options: string[]; onChange: (v: string[]) => void }) {
  const [pick, setPick] = useState('')
  const move = (i: number, d: number) => {
    const next = [...value]
    const [x] = next.splice(i, 1)
    next.splice(i + d, 0, x)
    onChange(next)
  }
  return (
    <div className="set-row" style={{ alignItems: 'flex-start' }}>
      <div className="set-text">
        <div className="set-label">Fallback order</div>
        <div className="set-help">Tried in order when the chosen model fails.</div>
      </div>
      <div className="stack" style={{ gap: 6, width: 320 }}>
        {value.map((m, i) => (
          <div key={m} className="row" style={{ gap: 4 }}>
            <span className="kbd">{i + 1}</span>
            <span className="mono truncate" style={{ flex: 1 }}>
              {m}
            </span>
            <IconButton icon={ArrowUp} size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
            <IconButton icon={ArrowDown} size="sm" label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)} />
            <IconButton icon={Trash2} size="sm" label="Remove" onClick={() => onChange(value.filter((x) => x !== m))} />
          </div>
        ))}
        <div className="row">
          <select className="select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add fallback model" disabled={!options.length}>
            <option value="">{options.length ? 'Add a model…' : 'No models discovered'}</option>
            {options
              .filter((o) => !value.includes(o))
              .map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            icon={Plus}
            disabled={!pick}
            onClick={() => {
              onChange([...value, pick])
              setPick('')
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}
