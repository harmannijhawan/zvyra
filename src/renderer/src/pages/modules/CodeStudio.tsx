import { Bot, Code2, ExternalLink, FolderPlus, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { CapabilityNotice } from '../../components/CapabilityNotice'
import { FileBrowser } from '../../components/FileBrowser'
import { Button, Card, EmptyState } from '../../components/ui'
import { call } from '../../lib/client'
import { navigate, useStore } from '../../lib/store'
import { attempt, useAction } from '../../lib/useAction'

export function CodeStudio() {
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeProjectId)
  const list = useMemo(() => Object.values(projects).filter((p) => p.status === 'open'), [projects])
  const [projectId, setProjectId] = useState<string>(activeId ?? list[0]?.id ?? '')
  const [ask, setAsk] = useState('')
  const [run, pending] = useAction()
  const project = projects[projectId]

  useEffect(() => {
    if (!projectId && list[0]) setProjectId(list[0].id)
  }, [list, projectId])

  const startTask = async () => {
    const t = await run(() => call('tasks.create', { instruction: ask.trim(), source: 'home', projectId }), { success: 'Code task started' })
    if (t) {
      setAsk('')
      navigate(`tasks/${t.id}`)
    }
  }

  if (!list.length) {
    return (
      <EmptyState
        icon={Code2}
        title="No open projects"
        action={
          <Button variant="primary" icon={FolderPlus} onClick={() => navigate('projects')}>
            Add a project
          </Button>
        }
      >
        Code Studio works inside a project folder. Add one in Projects first.
      </EmptyState>
    )
  }

  return (
    <div className="stack">
      <CapabilityNotice cap="files" what="Browsing and editing files" />
      <div className="row wrap">
        <select className="select" style={{ width: 260 }} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="muted mono truncate" style={{ flex: 1 }}>
          {project?.path}
        </span>
        <Button icon={ExternalLink} onClick={() => void attempt(() => call('code.openInEditor', { projectId }), { success: 'Opening in your editor' })}>
          Open in editor
        </Button>
      </div>
      <Card title="Ask the Code agent" icon={Bot}>
        <div className="row">
          <input
            className="input"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask.trim() && void startTask()}
            placeholder="e.g. Add input validation to the signup form and run the tests"
            aria-label="Instruction for the Code agent"
          />
          <Button variant="primary" icon={Play} disabled={!ask.trim() || pending} onClick={() => void startTask()}>
            Start
          </Button>
        </div>
      </Card>
      {project && <FileBrowser root={project.path} editable />}
    </div>
  )
}
