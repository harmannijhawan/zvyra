import { Bot, ExternalLink, Globe, History, X } from 'lucide-react'
import { useState } from 'react'
import { CapabilityNotice } from '../../components/CapabilityNotice'
import { Button, Card, IconButton } from '../../components/ui'
import { call } from '../../lib/client'
import { navigate } from '../../lib/store'
import { attempt, reportError, useAction } from '../../lib/useAction'
import { ClientError } from '../../lib/client'
import { normalizeUrl } from '../../lib/url'

const KEY = 'zvyra.browser.recent'

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 12) : []
  } catch {
    return []
  }
}


export function BrowserModule() {
  const [url, setUrl] = useState('')
  const [goal, setGoal] = useState('')
  const [recent, setRecent] = useState(loadRecent)
  const [run, pending] = useAction()

  const remember = (u: string) => {
    const next = [u, ...recent.filter((x) => x !== u)].slice(0, 12)
    setRecent(next)
    localStorage.setItem(KEY, JSON.stringify(next))
  }

  const open = async (target = url) => {
    const u = normalizeUrl(target)
    if (!u) return reportError(new ClientError({ code: 'INVALID_ARGS', message: 'Enter a valid http(s) address, e.g. example.com' }))
    const ok = await attempt(() => call('browser.open', { url: u }).then(() => true))
    if (ok) remember(u)
  }

  const agent = async () => {
    const u = normalizeUrl(url)
    const instruction = u ? `In the browser, open ${u} and ${goal.trim() || 'summarise the page'}` : goal.trim()
    const t = await run(() => call('tasks.create', { instruction, source: 'home' }), { success: 'Browser task started' })
    if (t) navigate(`tasks/${t.id}`)
  }

  return (
    <div className="stack">
      <CapabilityNotice cap="browser" what="Opening pages from ZVYRA" />
      <Card title="Open a page" icon={Globe}>
        <div className="row">
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void open()}
            placeholder="example.com or https://…"
            aria-label="Address"
          />
          <Button variant="primary" icon={ExternalLink} disabled={!url.trim()} onClick={() => void open()}>
            Open
          </Button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Opens in your default browser. ZVYRA doesn’t embed a browser in this window.
        </div>
      </Card>
      <Card title="Let the Browser agent do it" icon={Bot}>
        <div className="row">
          <input
            className="input"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (goal.trim() || url.trim()) && void agent()}
            placeholder="e.g. find the pricing table and compare the plans"
            aria-label="Browser goal"
          />
          <Button icon={Bot} disabled={(!goal.trim() && !url.trim()) || pending} onClick={() => void agent()}>
            Start task
          </Button>
        </div>
      </Card>
      <Card title="Recent" icon={History}>
        {recent.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>Pages you open here appear in this list (stored only on this PC).</div>
        ) : (
          <div className="list">
            {recent.map((u) => (
              <div key={u} className="list-item clickable">
                <button type="button" className="li-body" style={{ textAlign: 'left' }} onClick={() => void open(u)}>
                  <div className="li-title">{u}</div>
                </button>
                <IconButton
                  icon={X}
                  size="sm"
                  label="Remove from recent"
                  onClick={() => {
                    const next = recent.filter((x) => x !== u)
                    setRecent(next)
                    localStorage.setItem(KEY, JSON.stringify(next))
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
