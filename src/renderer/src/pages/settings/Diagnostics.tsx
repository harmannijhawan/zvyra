import { CheckCircle2, CircleHelp, FileText, FolderOpen, RefreshCw, Stethoscope, TriangleAlert, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DiagnosticCheck, LogEntry, LogLevel } from '@shared/contract'
import { Badge, Button, Card, KeyValue, Spinner } from '../../components/ui'
import { call, errorMessage } from '../../lib/client'
import { navigate, useStore } from '../../lib/store'
import { attempt } from '../../lib/useAction'
import { patchSettings, Row, useSettings } from './common'
import { CONTRACT_VERSION } from '@shared/contract'

const CHECK_ICON = { ok: CheckCircle2, warning: TriangleAlert, error: XCircle, unknown: CircleHelp }
const CHECK_CLASS = { ok: 'success', warning: 'warning', error: 'danger', unknown: '' }

export function DiagnosticsSettings() {
  const system = useStore((s) => s.system)
  const mode = useStore((s) => s.backendMode)
  const settings = useSettings()
  const [checks, setChecks] = useState<DiagnosticCheck[] | null>(null)
  const [checkErr, setCheckErr] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [logErr, setLogErr] = useState<string | null>(null)
  const [level, setLevel] = useState<LogLevel | ''>('')
  const [query, setQuery] = useState('')

  const runChecks = useCallback(() => {
    setChecks(null)
    call('system.diagnostics')
      .then((c) => {
        setChecks(c)
        setCheckErr(null)
      })
      .catch((e) => {
        setChecks([])
        setCheckErr(errorMessage(e))
      })
  }, [])
  const loadLogs = useCallback(() => {
    call('system.logs', { limit: 300, level: level || undefined, query: query || undefined })
      .then((l) => {
        setLogs(l)
        setLogErr(null)
      })
      .catch((e) => {
        setLogs([])
        setLogErr(errorMessage(e))
      })
  }, [level, query])

  useEffect(runChecks, [runChecks])
  useEffect(() => {
    const t = setTimeout(loadLogs, 250)
    return () => clearTimeout(t)
  }, [loadLogs])

  return (
    <div className="stack">
      <Card title="Health checks" icon={Stethoscope} actions={<Button size="sm" variant="ghost" icon={RefreshCw} onClick={runChecks}>Run again</Button>}>
        {checkErr && <div className="notice warning">{checkErr}</div>}
        {!checks ? (
          <Spinner />
        ) : (
          <div className="list">
            {checks.map((c) => {
              const Icon = CHECK_ICON[c.status]
              return (
                <div key={c.id} className="list-item">
                  <span className={`li-icon ${CHECK_CLASS[c.status]}`}>
                    <Icon />
                  </span>
                  <span className="li-body">
                    <div className="li-title">{c.label}</div>
                    {c.detail && <div className="li-sub selectable" style={{ whiteSpace: 'normal' }}>{c.detail}</div>}
                  </span>
                  {c.fixRoute && (
                    <Button size="sm" onClick={() => navigate(c.fixRoute!)}>
                      Fix
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card
        title="Logs"
        icon={FileText}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void attempt(() => call('system.openLogsFolder'))}>
              Open folder
            </Button>
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={loadLogs} aria-label="Refresh logs" />
          </>
        }
      >
        <div className="row" style={{ marginBottom: 10 }}>
          <select className="select" style={{ width: 140 }} value={level} onChange={(e) => setLevel(e.target.value as LogLevel | '')} aria-label="Log level filter">
            <option value="">All levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
          <input className="input" placeholder="Filter logs" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter logs" />
        </div>
        {logErr && <div className="notice warning">{logErr}</div>}
        <pre className="terminal" style={{ minHeight: 200 }}>
          {logs?.length
            ? logs.map((l) => `${new Date(l.ts).toLocaleTimeString()}  ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.message}`).join('\n')
            : logs
              ? 'No log entries.'
              : 'Loading…'}
        </pre>
        {settings && (
          <Row label="Log detail" help="More detail helps troubleshooting. Secrets are always redacted.">
            <select className="select" value={settings.diagnostics.logLevel} onChange={(e) => void patchSettings({ diagnostics: { logLevel: e.target.value as LogLevel } })} aria-label="Log level">
              <option value="error">Errors only</option>
              <option value="warn">Warnings</option>
              <option value="info">Normal</option>
              <option value="debug">Verbose</option>
            </select>
          </Row>
        )}
      </Card>

      <Card title="About">
        <KeyValue
          items={[
            { label: 'App version', value: system?.appVersion ?? '—' },
            { label: 'Backend', value: <>{system?.backend ?? 'unknown'} {mode?.mode === 'mock' && <Badge tone="warning">Preview</Badge>}</> },
            { label: 'Backend version', value: system?.backendVersion ?? '—' },
            { label: 'Contract', value: `UI ${CONTRACT_VERSION} · backend ${system?.contractVersion ?? '—'}` },
            { label: 'Platform', value: system?.platform ?? '—' },
            { label: 'Data folder', value: system?.dataPath ?? '—' }
          ]}
        />
        {system && system.contractVersion !== CONTRACT_VERSION && (
          <div className="notice warning" style={{ marginTop: 10 }}>
            <TriangleAlert /> Contract versions differ. Some screens may show “not available” until both sides are updated.
          </div>
        )}
      </Card>
    </div>
  )
}
