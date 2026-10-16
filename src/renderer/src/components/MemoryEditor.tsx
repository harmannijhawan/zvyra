import { Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MemoryItem, MemoryKind } from '@shared/contract'
import { call } from '../lib/client'
import { useStore } from '../lib/store'
import { useAction } from '../lib/useAction'
import { Button, Field, Modal, Toggle } from './ui'

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  preference: 'Preference',
  fact: 'Fact',
  note: 'Note',
  task_context: 'Task context',
  project: 'Project'
}

export function MemoryEditor({
  open,
  item,
  defaultKind = 'note',
  kinds,
  onClose,
  onSaved
}: {
  open: boolean
  item?: MemoryItem | null
  defaultKind?: MemoryKind
  kinds?: MemoryKind[]
  onClose: () => void
  onSaved: (m: MemoryItem) => void
}) {
  const projects = useStore((s) => s.projects)
  const [kind, setKind] = useState<MemoryKind>(defaultKind)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [projectId, setProjectId] = useState('')
  const [pinned, setPinned] = useState(false)
  const [run, pending] = useAction()

  useEffect(() => {
    if (!open) return
    setKind(item?.kind ?? defaultKind)
    setTitle(item?.title ?? '')
    setContent(item?.content ?? '')
    setTags(item?.tags.join(', ') ?? '')
    setProjectId(item?.projectId ?? '')
    setPinned(!!item?.pinned)
  }, [open, item, defaultKind])

  const save = async () => {
    const payload = {
      kind,
      title: title.trim(),
      content: content.trim(),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      projectId: projectId || undefined,
      pinned
    }
    const m = await run(() => (item ? call('memory.update', { id: item.id, ...payload }) : call('memory.create', payload)), { success: item ? 'Saved' : 'Saved to memory' })
    if (m) {
      onSaved(m)
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      title={item ? 'Edit memory' : 'New memory'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Save} disabled={!title.trim()} loading={pending} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Type" htmlFor="mem-kind">
          <select id="mem-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
            {(kinds ?? (Object.keys(MEMORY_KIND_LABEL) as MemoryKind[])).map((k) => (
              <option key={k} value={k}>
                {MEMORY_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project" htmlFor="mem-project">
          <select id="mem-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">None</option>
            {Object.values(projects).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="full">
          <Field label="Title" htmlFor="mem-title">
            <input id="mem-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Prefers concise answers" />
          </Field>
        </div>
        <div className="full">
          <Field label="Details" htmlFor="mem-content">
            <textarea id="mem-content" className="textarea" rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
          </Field>
        </div>
        <Field label="Tags" htmlFor="mem-tags" help="Comma separated">
          <input id="mem-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label">Pinned</span>
          <div className="row" style={{ height: 36 }}>
            <Toggle checked={pinned} onChange={setPinned} label="Pin memory" />
            <span className="muted" style={{ fontSize: 12.5 }}>Always shown first</span>
          </div>
        </div>
      </div>
    </Modal>
  )
}
