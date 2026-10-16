import { BookMarked, Search, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { TaskStatusBadge } from '../../components/TaskBits'
import { Button, Card } from '../../components/ui'
import { call } from '../../lib/client'
import { timeAgo } from '../../lib/format'
import { navigate, sortedTasks, useStore } from '../../lib/store'
import { useAction } from '../../lib/useAction'

const PREFIX = 'Research: '

export function ResearchModule() {
  const tasks = useStore((s) => s.tasks)
  const [q, setQ] = useState('')
  const [run, pending] = useAction()
  const research = useMemo(() => sortedTasks(tasks).filter((t) => t.agentId === 'research' || t.instruction.startsWith(PREFIX)), [tasks])

  const start = async () => {
    const t = await run(
      () => call('tasks.create', { instruction: `${PREFIX}${q.trim()}\nCite every source you used.`, source: 'home' }),
      { success: 'Research started' }
    )
    if (t) {
      setQ('')
      navigate(`tasks/${t.id}`)
    }
  }

  return (
    <div className="stack">
      <Card title="Ask a research question" icon={Search}>
        <textarea
          className="textarea"
          rows={3}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && q.trim() && void start()}
          placeholder="e.g. What are the main differences between the top three note-taking apps for teams?"
          aria-label="Research question"
        />
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>The Research agent reads real pages and must cite them. Ctrl+Enter to start.</span>
          <span className="spacer" />
          <Button variant="primary" icon={Sparkles} disabled={!q.trim() || pending} onClick={() => void start()}>
            Start research
          </Button>
        </div>
      </Card>
      <Card title="Research history" icon={BookMarked}>
        {research.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No research yet.</div>
        ) : (
          <div className="list">
            {research.map((t) => (
              <button key={t.id} type="button" className="list-item" onClick={() => navigate(`tasks/${t.id}`)}>
                <span className="li-body">
                  <div className="li-title">{t.instruction.replace(PREFIX, '').split('\n')[0]}</div>
                  <div className="li-sub">{t.summary ?? t.currentAction ?? timeAgo(t.createdAt)}</div>
                </span>
                <TaskStatusBadge status={t.status} />
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
