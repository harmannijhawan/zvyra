/** Memory — inspectable, editable persistent memory with privacy controls. */
import { Database, Eraser, Lock, Pencil, Pin, Plus, Search, Trash2, User } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MemoryItem, MemoryKind, MemorySettings } from '@shared/contract'
import { MEMORY_KIND_LABEL, MemoryEditor } from '../components/MemoryEditor'
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Segmented, Toggle } from '../components/ui'
import { call, errorMessage } from '../lib/client'
import { timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { attempt } from '../lib/useAction'

type KindFilter = 'all' | MemoryKind

export function useMemoryList(kind?: MemoryKind, query?: string) {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    call('memory.list', { kind, query: query || undefined })
      .then((r) => {
        setItems(r)
        setError(null)
      })
      .catch((e) => {
        setItems([])
        setError(errorMessage(e))
      })
  }, [kind, query])
  useEffect(() => {
    const t = setTimeout(reload, query ? 250 : 0)
    return () => clearTimeout(t)
  }, [reload, query])
  return { items, error, reload, setItems }
}

export function Memory() {
  const projects = useStore((s) => s.projects)
  const [kind, setKind] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<MemoryItem | null | undefined>(undefined)
  const [confirmClear, setConfirmClear] = useState(false)
  const [deleting, setDeleting] = useState<MemoryItem | null>(null)
  const { items, error, reload } = useMemoryList(kind === 'all' ? undefined : kind, query)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Memory</h1>
          <p>What ZVYRA remembers between conversations. You can see, edit and delete all of it.</p>
        </div>
        <div className="page-actions">
          <Button variant="ghost" icon={Eraser} onClick={() => setConfirmClear(true)}>
            Clear {kind === 'all' ? 'all' : MEMORY_KIND_LABEL[kind].toLowerCase() + 's'}
          </Button>
          <Button variant="primary" icon={Plus} onClick={() => setEditing(null)}>
            Add memory
          </Button>
        </div>
      </header>

      <div className="detail-grid">
        <div className="stack">
          <div className="row wrap">
            <Segmented
              label="Filter by type"
              value={kind}
              onChange={setKind}
              options={[{ value: 'all', label: 'All' }, ...(Object.keys(MEMORY_KIND_LABEL) as MemoryKind[]).map((k) => ({ value: k, label: MEMORY_KIND_LABEL[k] }))]}
            />
            <div className="search" style={{ flex: 1, minWidth: 200 }}>
              <Search />
              <input className="input" placeholder="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search memory" />
            </div>
          </div>
          {error && <div className="notice warning">{error}</div>}
          {items && items.length === 0 && !error ? (
            <EmptyState icon={Database} title={query ? 'No matches' : 'Nothing saved yet'}>
              Saved preferences, facts and notes appear here. Conversations are not stored as memory unless saved.
            </EmptyState>
          ) : (
            <div className="card padded" style={{ padding: 6 }}>
              <div className="list">
                {items?.map((m) => (
                  <div key={m.id} className="list-item">
                    <span className="li-icon">{m.pinned ? <Pin /> : <Database />}</span>
                    <span className="li-body">
                      <div className="li-title selectable">{m.title}</div>
                      <div className="li-sub selectable">{m.content || '—'}</div>
                    </span>
                    <Badge>{MEMORY_KIND_LABEL[m.kind]}</Badge>
                    {m.projectId && projects[m.projectId] && <Badge tone="accent">{projects[m.projectId].name}</Badge>}
                    <Badge tone={m.source === 'agent' ? 'info' : 'neutral'} icon={m.source === 'agent' ? undefined : User}>
                      {m.source === 'agent' ? 'Saved by ZVYRA' : 'You'}
                    </Badge>
                    <span className="li-meta">{timeAgo(m.updatedAt)}</span>
                    <div className="li-actions">
                      <IconButton icon={Pencil} size="sm" label="Edit" onClick={() => setEditing(m)} />
                      <IconButton icon={Trash2} size="sm" label="Delete" onClick={() => setDeleting(m)} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <MemorySettingsCard />
      </div>

      <MemoryEditor open={editing !== undefined} item={editing} onClose={() => setEditing(undefined)} onSaved={reload} />
      <ConfirmDialog
        open={!!deleting}
        title="Delete memory?"
        body={`“${deleting?.title}” will be permanently forgotten.`}
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && void attempt(() => call('memory.delete', { id: deleting.id }), { success: 'Forgotten' }).then(reload)}
      />
      <ConfirmDialog
        open={confirmClear}
        title="Clear memory?"
        body={kind === 'all' ? 'Everything ZVYRA has saved will be permanently deleted.' : `All ${MEMORY_KIND_LABEL[kind].toLowerCase()} memories will be deleted.`}
        confirmLabel="Clear"
        danger
        onClose={() => setConfirmClear(false)}
        onConfirm={() =>
          void attempt(() => call('memory.clear', { kind: kind === 'all' ? undefined : kind })).then((r) => {
            if (r) reload()
          })
        }
      />
    </div>
  )
}

function MemorySettingsCard() {
  const [s, setS] = useState<MemorySettings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    call('memory.settings')
      .then(setS)
      .catch((e) => setErr(errorMessage(e)))
  }, [])
  const update = async (patch: Partial<MemorySettings>) => {
    if (!s) return
    const prev = s
    setS({ ...s, ...patch }) // optimistic
    const next = await attempt(() => call('memory.setSettings', patch), { errorTitle: 'Memory setting not changed' })
    setS(next ?? prev) // roll back if rejected
  }
  return (
    <Card title="Privacy" icon={Lock}>
      {err && <div className="notice warning">{err}</div>}
      {s && (
        <>
          <div className="set-row">
            <div className="set-text">
              <div className="set-label">Saved memory</div>
              <div className="set-help">Turn off to stop using and showing saved memories.</div>
            </div>
            <Toggle checked={s.enabled} onChange={(v) => void update({ enabled: v })} label="Saved memory" />
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-label">Who saves memories</div>
              <div className="set-help">{s.agentMaySave === 'never' ? 'ZVYRA never saves memories on its own — add them here or in Knowledge.' : '“Ask” shows an approval before anything is saved.'}</div>
            </div>
            {s.agentMaySave === 'never' ? (
              <span className="badge success">Only you save</span>
            ) : (
              <select className="select" style={{ width: 110 }} value={s.agentMaySave} onChange={(e) => void update({ agentMaySave: e.target.value as MemorySettings['agentMaySave'] })} aria-label="Agent may save memories">
                <option value="never">Never</option>
                <option value="ask">Ask</option>
                <option value="always">Always</option>
              </select>
            )}
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-label">Use memories in tasks</div>
              <div className="set-help">Relevant memories are added to task context.</div>
            </div>
            <Toggle checked={s.includeInContext} onChange={(v) => void update({ includeInContext: v })} label="Use memories in tasks" />
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-label">Keep memories</div>
            </div>
            <select
              className="select"
              style={{ width: 130 }}
              value={s.retentionDays ?? ''}
              onChange={(e) => void update({ retentionDays: e.target.value ? Number(e.target.value) : null })}
              aria-label="Memory retention"
            >
              <option value="">Until deleted</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>
          </div>
          <div className="notice" style={{ marginTop: 8 }}>
            <Lock />
            <span>Raw microphone audio is never saved as memory. Conversations stay in Chat unless you or an approved task saves something here.</span>
          </div>
        </>
      )}
    </Card>
  )
}
