import { ExternalLink, Play, ShieldAlert, Square, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileRoot } from '@shared/contract'
import { CapabilityNotice } from '../../components/CapabilityNotice'
import { Badge, Button, Card } from '../../components/ui'
import { call } from '../../lib/client'
import { humanize, timeAgo } from '../../lib/format'
import { setState, useStore } from '../../lib/store'
import { attempt, useAction } from '../../lib/useAction'

export function TerminalModule() {
  const runs = useStore((s) => s.terminalRuns)
  const output = useStore((s) => s.terminalOutput)
  const [roots, setRoots] = useState<FileRoot[]>([])
  const [cwd, setCwd] = useState('')
  const [command, setCommand] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [hIdx, setHIdx] = useState(-1)
  const [run, pending] = useAction()
  const outRef = useRef<HTMLPreElement>(null)
  const list = useMemo(() => Object.values(runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [runs])
  const current = selected ? runs[selected] : list[0]

  useEffect(() => {
    call('files.roots')
      .then((r) => {
        setRoots(r)
        setCwd((c) => c || r[0]?.path || '')
      })
      .catch(() => undefined)
    call('terminal.runs', { limit: 30 })
      .then((r) => setState((s) => ({ terminalRuns: { ...Object.fromEntries(r.map((x) => [x.id, x])), ...s.terminalRuns } })))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight
  }, [current && output[current.id]])

  const exec = async () => {
    const cmd = command.trim()
    if (!cmd) return
    const r = await run(() => call('terminal.run', { command: cmd, cwd: cwd || undefined }))
    if (r) {
      setState((s) => ({ terminalRuns: { ...s.terminalRuns, [r.id]: r } }))
      setSelected(r.id)
      setHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 50))
      setHIdx(-1)
      setCommand('')
    }
  }

  return (
    <div className="stack">
      <CapabilityNotice cap="terminal" what="Running commands" />
      <div className="notice">
        <ShieldAlert />
        <span>Every command goes through ZVYRA’s “Run commands” permission. The backend asks for approval before running anything when that permission is set to Ask.</span>
      </div>
      <Card
        title="Run a command"
        icon={SquareTerminal}
        actions={
          <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void attempt(() => call('terminal.openExternal', { cwd: cwd || undefined }))}>
            Open Windows Terminal here
          </Button>
        }
      >
        <div className="row">
          <select className="select" style={{ width: 240 }} value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="Working folder">
            {roots.length === 0 && <option value="">Default folder</option>}
            {roots.map((r) => (
              <option key={r.path} value={r.path}>
                {r.label}
              </option>
            ))}
          </select>
          <input
            className="input mono"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void exec()
              if (e.key === 'ArrowUp' && history.length) {
                e.preventDefault()
                const i = Math.min(history.length - 1, hIdx + 1)
                setHIdx(i)
                setCommand(history[i])
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                const i = hIdx - 1
                setHIdx(Math.max(-1, i))
                setCommand(i >= 0 ? history[i] : '')
              }
            }}
            placeholder="npm test"
            aria-label="Command"
            spellCheck={false}
          />
          <Button variant="primary" icon={Play} disabled={!command.trim() || pending} onClick={() => void exec()}>
            Run
          </Button>
        </div>
      </Card>

      <div className="grid-2" style={{ gridTemplateColumns: '280px minmax(0,1fr)' }}>
        <Card title="Runs">
          {list.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No commands yet.</div>
          ) : (
            <div className="list">
              {list.map((r) => (
                <button key={r.id} type="button" className={`list-item ${current?.id === r.id ? 'selected' : ''}`} onClick={() => setSelected(r.id)}>
                  <span className="li-body">
                    <div className="li-title mono">{r.command}</div>
                    <div className="li-sub">{timeAgo(r.startedAt)}</div>
                  </span>
                  <Badge tone={r.status === 'running' ? 'info' : r.status === 'exited' && r.exitCode === 0 ? 'success' : r.status === 'awaiting_approval' ? 'warning' : 'danger'}>
                    {r.status === 'exited' ? `exit ${r.exitCode}` : humanize(r.status)}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card
          title={current ? <span className="mono">{current.command}</span> : 'Output'}
          actions={
            current?.status === 'running' && (
              <Button size="sm" variant="danger" icon={Square} onClick={() => void attempt(() => call('terminal.kill', { id: current.id }), { success: 'Stopped' })}>
                Stop
              </Button>
            )
          }
        >
          {current && <div className="muted mono" style={{ fontSize: 11.5, marginBottom: 6 }}>{current.cwd}</div>}
          <pre className="terminal" ref={outRef}>
            {current ? output[current.id] ?? (current.status === 'awaiting_approval' ? 'Waiting for your approval…' : '') : 'Run a command to see its output.'}
          </pre>
        </Card>
      </div>
    </div>
  )
}
