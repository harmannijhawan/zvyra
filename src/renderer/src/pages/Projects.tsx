/** Projects — local workspaces with context, tasks and conversations. */
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Code2,
  FolderClosed,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Pencil,
  Plus,
  Save,
  Star,
  Target,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Project } from '@shared/contract'
import { TaskStatusBadge } from '../components/TaskBits'
import { Badge, Button, Card, EmptyState, Field, IconButton, Modal, Segmented } from '../components/ui'
import { call } from '../lib/client'
import { timeAgo } from '../lib/format'
import { navigate, setState, sortedTasks, useStore } from '../lib/store'
import { attempt, useAction } from '../lib/useAction'
import { NewTaskModal } from './Tasks'

type Filter = 'all' | 'favorites' | 'open' | 'closed'

export function Projects({ projectId }: { projectId?: string }) {
  const projects = useStore((s) => s.projects)
  if (projectId) {
    const p = projects[projectId]
    return p ? <ProjectDetail project={p} /> : <div className="page"><EmptyState icon={FolderKanban} title="Project not found" action={<Button onClick={() => navigate('projects')}>All projects</Button>} /></div>
  }
  return <ProjectList />
}

function ProjectList() {
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeProjectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [adding, setAdding] = useState(false)
  const list = useMemo(
    () =>
      Object.values(projects)
        .filter((p) => filter === 'all' || (filter === 'favorites' ? p.favorite : p.status === filter))
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt)),
    [projects, filter]
  )
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Folders ZVYRA works in, with their own context, tasks and conversations.</p>
        </div>
        <div className="page-actions">
          <Segmented
            label="Filter projects"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'favorites', label: 'Favorites' },
              { value: 'open', label: 'Open' },
              { value: 'closed', label: 'Closed' }
            ]}
          />
          <Button variant="primary" icon={FolderPlus} onClick={() => setAdding(true)}>
            Add project
          </Button>
        </div>
      </header>
      {list.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title={filter === 'all' ? 'No projects yet' : 'Nothing matches this filter'}
          action={
            <Button variant="primary" icon={FolderPlus} onClick={() => setAdding(true)}>
              Add project
            </Button>
          }
        >
          Add a folder as a project. Closing a project never deletes its files.
        </EmptyState>
      ) : (
        <div className="tiles">
          {list.map((p) => (
            <button key={p.id} type="button" className="tile" onClick={() => navigate(`projects/${p.id}`)}>
              <span className="row">
                <span className="tile-icon">{p.status === 'open' ? <FolderOpen /> : <FolderClosed />}</span>
                <span className="spacer" />
                {p.favorite && <Star style={{ width: 16, height: 16, color: '#ffd36b', fill: '#ffd36b' }} />}
              </span>
              <span className="tile-title truncate">{p.name}</span>
              <span className="tile-desc mono truncate" title={p.path}>
                {p.path}
              </span>
              <span className="tile-foot">
                {p.id === activeId && <Badge tone="accent">Active</Badge>}
                <Badge tone={p.status === 'open' ? 'success' : 'neutral'}>{p.status === 'open' ? 'Open' : 'Closed'}</Badge>
                {p.missing && <Badge tone="danger">Folder missing</Badge>}
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 11.5 }}>{timeAgo(p.lastOpenedAt ?? p.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <AddProjectModal open={adding} onClose={() => setAdding(false)} />
    </div>
  )
}

function AddProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [run, pending] = useAction()
  useEffect(() => {
    if (open) {
      setName('')
      setPath('')
    }
  }, [open])
  const pick = async () => {
    const p = await attempt(() => call('projects.pickFolder'))
    if (p) {
      setPath(p)
      if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }
  const create = async () => {
    const p = await run(() => call('projects.create', { name: name.trim(), path }), { success: 'Project added' })
    if (p) {
      onClose()
      navigate(`projects/${p.id}`)
    }
  }
  return (
    <Modal
      open={open}
      title="Add project"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Plus} disabled={!name.trim() || !path} loading={pending} onClick={() => void create()}>
            Add project
          </Button>
        </>
      }
    >
      <Field label="Folder" help="ZVYRA gets access to this folder for project work.">
        <div className="row">
          <input className="input mono" readOnly value={path} placeholder="No folder selected" aria-label="Selected folder" />
          <Button icon={FolderOpen} onClick={() => void pick()}>
            Choose…
          </Button>
        </div>
      </Field>
      <Field label="Name" htmlFor="project-name">
        <input id="project-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My project" />
      </Field>
    </Modal>
  )
}

function ProjectDetail({ project: p }: { project: Project }) {
  const activeId = useStore((s) => s.activeProjectId)
  const tasks = useStore((s) => s.tasks)
  const conversations = useStore((s) => s.conversations)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(p.name)
  const [context, setContext] = useState(p.context ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newTask, setNewTask] = useState(false)
  const [run, pending] = useAction()
  const projTasks = useMemo(() => sortedTasks(tasks).filter((t) => t.projectId === p.id), [tasks, p.id])
  const projConvs = useMemo(() => Object.values(conversations).filter((c) => c.projectId === p.id), [conversations, p.id])

  useEffect(() => {
    setName(p.name)
    setContext(p.context ?? '')
  }, [p.id, p.name, p.context])

  const upsert = (u: Project | undefined) => u && setState((s) => ({ projects: { ...s.projects, [u.id]: u } }))
  const rename = async () => {
    setEditing(false)
    if (name.trim() && name.trim() !== p.name) upsert(await run(() => call('projects.rename', { id: p.id, name: name.trim() })))
  }

  return (
    <div className="page">
      <header className="page-head">
        <div className="row" style={{ alignItems: 'center', minWidth: 0 }}>
          <IconButton icon={ArrowLeft} label="All projects" onClick={() => navigate('projects')} />
          <div style={{ minWidth: 0 }}>
            <div className="row">
              {editing ? (
                <input
                  className="input"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => void rename()}
                  onKeyDown={(e) => e.key === 'Enter' && void rename()}
                  aria-label="Project name"
                />
              ) : (
                <h1 className="truncate">{p.name}</h1>
              )}
              <IconButton icon={editing ? Check : Pencil} size="sm" label="Rename" onClick={() => (editing ? void rename() : setEditing(true))} />
              <IconButton
                icon={Star}
                size="sm"
                label={p.favorite ? 'Remove from favorites' : 'Add to favorites'}
                active={p.favorite}
                onClick={() => void run(() => call('projects.setFavorite', { id: p.id, favorite: !p.favorite })).then(upsert)}
              />
            </div>
            <p className="mono truncate" title={p.path}>
              {p.path}
            </p>
          </div>
        </div>
        <div className="page-actions">
          {p.id === activeId ? (
            <Button icon={Target} onClick={() => void run(() => call('projects.setActive', { id: null }))}>
              Active — clear
            </Button>
          ) : (
            <Button icon={Target} onClick={() => void run(() => call('projects.setActive', { id: p.id }), { success: 'Active project set' }).then(() => setState({ activeProjectId: p.id }))}>
              Make active
            </Button>
          )}
          {p.status === 'open' ? (
            <Button icon={FolderClosed} disabled={pending} onClick={() => void run(() => call('projects.close', { id: p.id }), { success: 'Project closed — files untouched' }).then(upsert)}>
              Close
            </Button>
          ) : (
            <Button icon={FolderOpen} disabled={pending} onClick={() => void run(() => call('projects.open', { id: p.id })).then(upsert)}>
              Reopen
            </Button>
          )}
          <Button variant="ghost" icon={Trash2} onClick={() => setConfirmDelete(true)}>
            Remove
          </Button>
        </div>
      </header>

      {p.missing && (
        <div className="notice danger" style={{ marginBottom: 16 }}>
          <AlertTriangle /> The project folder can’t be found. It may have been moved or deleted.
        </div>
      )}

      <div className="detail-grid">
        <div className="stack">
          <Card
            title="Project context"
            actions={
              <Button
                size="sm"
                icon={Save}
                disabled={context === (p.context ?? '') || pending}
                onClick={() => void run(() => call('projects.updateContext', { id: p.id, context }), { success: 'Context saved' }).then(upsert)}
              >
                Save
              </Button>
            }
          >
            <textarea
              className="textarea"
              rows={6}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Goals, conventions, people, links — anything ZVYRA should know when working on this project."
              aria-label="Project context"
            />
          </Card>
          <Card
            title="Tasks"
            actions={
              <Button size="sm" icon={Plus} onClick={() => setNewTask(true)}>
                New task
              </Button>
            }
          >
            {projTasks.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No tasks for this project yet.</div>
            ) : (
              <div className="list">
                {projTasks.slice(0, 20).map((t) => (
                  <button key={t.id} type="button" className="list-item" onClick={() => navigate(`tasks/${t.id}`)}>
                    <span className="li-body">
                      <div className="li-title">{t.title}</div>
                      <div className="li-sub">{timeAgo(t.createdAt)}</div>
                    </span>
                    <TaskStatusBadge status={t.status} />
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
        <div className="stack">
          <Button icon={Code2} onClick={() => void call('projects.setActive', { id: p.id }).catch(() => undefined).then(() => navigate('apps/code'))}>
            Open in Code Studio
          </Button>
          <Card
            title="Conversations"
            icon={MessageSquare}
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon={Plus}
                onClick={() => void run(() => call('chat.create', { projectId: p.id })).then((c) => c && navigate(`chat/${c.id}`))}
              >
                New
              </Button>
            }
          >
            {projConvs.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No conversations linked.</div>
            ) : (
              <div className="list">
                {projConvs.map((c) => (
                  <button key={c.id} type="button" className="list-item" onClick={() => navigate(`chat/${c.id}`)}>
                    <span className="li-body">
                      <div className="li-title">{c.title}</div>
                      <div className="li-sub">{timeAgo(c.updatedAt)}</div>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <DeleteProjectModal project={p} open={confirmDelete} onClose={() => setConfirmDelete(false)} />
      <NewTaskModal open={newTask} onClose={() => setNewTask(false)} />
    </div>
  )
}

function DeleteProjectModal({ project: p, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const [trash, setTrash] = useState(false)
  const [typed, setTyped] = useState('')
  const [run, pending] = useAction()
  useEffect(() => {
    if (open) {
      setTrash(false)
      setTyped('')
    }
  }, [open])
  const confirmOk = !trash || typed === p.name
  return (
    <Modal
      open={open}
      title="Remove project?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={Trash2}
            disabled={!confirmOk}
            loading={pending}
            onClick={() =>
              void run(() => call('projects.delete', { id: p.id, trashFolder: trash }), { success: trash ? 'Project removed and folder moved to Recycle Bin' : 'Project removed' }).then(
                (r) => {
                  if (r !== undefined) {
                    onClose()
                    navigate('projects')
                  }
                }
              )
            }
          >
            {trash ? 'Remove and recycle folder' : 'Remove project'}
          </Button>
        </>
      }
    >
      <div className="confirm-body">ZVYRA will forget “{p.name}” and its project context. Your files stay where they are.</div>
      <label className="row" style={{ fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} /> Also move the folder to the Recycle Bin
      </label>
      {trash && (
        <Field label={`Type “${p.name}” to confirm`} htmlFor="confirm-name">
          <input id="confirm-name" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      )}
    </Modal>
  )
}
