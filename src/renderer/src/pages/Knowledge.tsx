/** Knowledge — notes and project facts ZVYRA can draw on. */
import { BookOpen, FolderKanban, Pencil, Pin, Plus, Search, StickyNote, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { MemoryItem } from '@shared/contract'
import { MemoryEditor } from '../components/MemoryEditor'
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Segmented } from '../components/ui'
import { call } from '../lib/client'
import { timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { attempt } from '../lib/useAction'
import { useMemoryList } from './Memory'

export function Knowledge() {
  const projects = useStore((s) => s.projects)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'notes' | 'projects'>('all')
  const [editing, setEditing] = useState<MemoryItem | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<MemoryItem | null>(null)
  const { items, error, reload } = useMemoryList(undefined, query)
  const knowledge = useMemo(
    () =>
      (items ?? []).filter((m) =>
        scope === 'notes' ? m.kind === 'note' : scope === 'projects' ? m.kind === 'project' || (m.kind === 'fact' && !!m.projectId) : m.kind === 'note' || m.kind === 'project' || m.kind === 'fact'
      ),
    [items, scope]
  )

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Knowledge</h1>
          <p>Notes and project facts you want ZVYRA to know and use.</p>
        </div>
        <div className="page-actions">
          <Segmented
            label="Scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'All' },
              { value: 'notes', label: 'Notes' },
              { value: 'projects', label: 'Project facts' }
            ]}
          />
          <div className="search" style={{ width: 240 }}>
            <Search />
            <input className="input" placeholder="Search knowledge" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search knowledge" />
          </div>
          <Button variant="primary" icon={Plus} onClick={() => setEditing(null)}>
            New note
          </Button>
        </div>
      </header>
      {error && <div className="notice warning" style={{ marginBottom: 12 }}>{error}</div>}
      {knowledge.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={query ? 'No matches' : 'No knowledge yet'}
          action={
            <Button variant="primary" icon={Plus} onClick={() => setEditing(null)}>
              Write a note
            </Button>
          }
        >
          Add meeting notes, how-tos, or facts about a project. ZVYRA can use them when memory is enabled.
        </EmptyState>
      ) : (
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {knowledge.map((m) => (
            <div key={m.id} className="tile" style={{ cursor: 'default' }}>
              <div className="row">
                <span className="tile-icon" style={{ width: 34, height: 34 }}>
                  {m.kind === 'note' ? <StickyNote /> : <FolderKanban />}
                </span>
                <span className="tile-title truncate" style={{ flex: 1 }}>
                  {m.title}
                </span>
                {m.pinned && <Pin style={{ width: 14, height: 14, color: 'var(--accent-2)' }} />}
              </div>
              <div className="tile-desc selectable" style={{ whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'hidden' }}>
                {m.content || '—'}
              </div>
              <div className="tile-foot">
                {m.projectId && projects[m.projectId] && <Badge tone="accent">{projects[m.projectId].name}</Badge>}
                {m.tags.slice(0, 3).map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 11.5 }}>{timeAgo(m.updatedAt)}</span>
                <IconButton icon={Pencil} size="sm" label="Edit" onClick={() => setEditing(m)} />
                <IconButton icon={Trash2} size="sm" label="Delete" onClick={() => setDeleting(m)} />
              </div>
            </div>
          ))}
        </div>
      )}
      <MemoryEditor
        open={editing !== undefined}
        item={editing}
        defaultKind="note"
        kinds={['note', 'fact', 'project']}
        onClose={() => setEditing(undefined)}
        onSaved={reload}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete note?"
        body={`“${deleting?.title}” will be permanently deleted.`}
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && void attempt(() => call('memory.delete', { id: deleting.id }), { success: 'Deleted' }).then(reload)}
      />
    </div>
  )
}
