/** Agents — the orchestration layer as it really runs. */
import { Bot, Cpu, Square, Wrench } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import type { AgentInfo } from '@shared/contract'
import { ModelSelect } from '../components/Composer'
import { Badge, Button, Card, EmptyState, Toggle } from '../components/ui'
import { call } from '../lib/client'
import { humanize } from '../lib/format'
import { navigate, setState, useStore } from '../lib/store'
import { attempt } from '../lib/useAction'

const STATE_TONE = { idle: 'neutral', running: 'info', waiting: 'warning', error: 'danger', disabled: 'neutral' } as const

export function Agents() {
  const agents = useStore((s) => s.agents)
  const runtime = useStore((s) => s.runtime)
  const tasks = useStore((s) => s.tasks)
  const list = useMemo(() => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)), [agents])

  useEffect(() => {
    Promise.all([call('agents.list'), call('agents.runtime')])
      .then(([a, r]) => setState({ agents: Object.fromEntries(a.map((x) => [x.id, x])), runtime: r }))
      .catch(() => undefined)
  }, [])

  const upsert = (a?: AgentInfo) => a && setState((s) => ({ agents: { ...s.agents, [a.id]: a } }))

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p>Specialists ZVYRA delegates to. States here come from the orchestrator, not animations.</p>
        </div>
      </header>

      <Card title="Runtime" icon={Cpu} className="" padded>
        {runtime ? (
          <div className="row wrap" style={{ gap: 18 }}>
            <Badge tone={runtime.mode === 'parallel' ? 'accent' : 'neutral'}>{runtime.mode === 'parallel' ? 'Parallel execution' : 'Sequential execution'}</Badge>
            <span>
              <b>{runtime.runningTasks}</b> <span className="muted">running</span>
            </span>
            <span>
              <b>{runtime.queuedTasks}</b> <span className="muted">queued</span>
            </span>
            <span>
              <span className="muted">up to</span> <b>{runtime.maxConcurrentTasks}</b> <span className="muted">at once</span>
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {runtime.mode === 'sequential' ? 'Work runs one step at a time, even when several agents are assigned.' : 'Independent work can run at the same time.'}
            </span>
          </div>
        ) : (
          <div className="muted">Runtime info unavailable.</div>
        )}
      </Card>

      <div style={{ height: 16 }} />
      {list.length === 0 ? (
        <EmptyState icon={Bot} title="No agents reported">
          The backend hasn’t registered any agents.
        </EmptyState>
      ) : (
        <div className="grid-2">
          {list.map((a) => (
            <Card
              key={a.id}
              title={
                <span className="row">
                  <Bot /> {a.name}
                </span>
              }
              actions={<Badge tone={STATE_TONE[a.state]}>{humanize(a.state)}</Badge>}
            >
              <div className="stack" style={{ gap: 12 }}>
                <div className="muted" style={{ fontSize: 13 }}>
                  {a.description}
                </div>
                {a.tools.length > 0 && (
                  <div className="row wrap" style={{ gap: 6 }}>
                    <Wrench style={{ width: 14, height: 14, color: 'var(--text-3)' }} />
                    {a.tools.map((t) => (
                      <span key={t} className="kbd">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {a.activeTaskIds.length > 0 && (
                  <div className="list">
                    {a.activeTaskIds.map((id) => (
                      <button key={id} type="button" className="list-item" onClick={() => navigate(`tasks/${id}`)}>
                        <span className="li-body">
                          <div className="li-title">{tasks[id]?.title ?? 'Task'}</div>
                          <div className="li-sub">{tasks[id]?.currentAction ?? humanize(tasks[id]?.status ?? 'running')}</div>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {a.lastError && <div className="notice danger">{a.lastError}</div>}
                <div className="row">
                  <Toggle
                    checked={a.enabled}
                    label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
                    onChange={(v) => void attempt(() => call('agents.setEnabled', { id: a.id, enabled: v })).then(upsert)}
                  />
                  <span className="muted" style={{ fontSize: 12.5 }}>{a.enabled ? 'Enabled' : 'Disabled'}</span>
                  <span className="spacer" />
                  <ModelSelect value={a.model} onChange={(m) => void attempt(() => call('agents.setModel', { id: a.id, model: m ?? null })).then(upsert)} className="composer-model" />
                  {a.activeTaskIds.length > 0 && (
                    <Button size="sm" variant="danger" icon={Square} onClick={() => void attempt(() => call('agents.stop', { id: a.id }), { success: `${a.name} stopped` }).then(upsert)}>
                      Stop
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
