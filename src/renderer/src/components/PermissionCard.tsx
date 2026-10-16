/**
 * Approval request card, shared by the Dynamic Island, Home, Tasks and Computer.
 *
 * Command approvals (request.command set) show exactly what will run, why it
 * needs approval, the folder and the affected files, with Allow (this command,
 * once) and Always Allow (a saved rule for this exact command + folder; never
 * offered for high-risk commands). Decisions go only through the trusted
 * contract call `permissions.respond`; the main process does the rest.
 */
import { FolderOpen, ShieldAlert, ShieldCheck, ShieldX, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PermissionDecision, PermissionRequest } from '@shared/contract'
import { call } from '../lib/client'
import { humanize } from '../lib/format'
import { useAction } from '../lib/useAction'
import { Badge, Button } from './ui'

function useCountdown(expiresAt?: string) {
  const [left, setLeft] = useState(() => (expiresAt ? Date.parse(expiresAt) - Date.now() : null))
  useEffect(() => {
    if (!expiresAt) return
    const t = setInterval(() => setLeft(Date.parse(expiresAt) - Date.now()), 1000)
    return () => clearInterval(t)
  }, [expiresAt])
  if (left === null) return null
  const s = Math.max(0, Math.round(left / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function PermissionCard({ request, compact }: { request: PermissionRequest; compact?: boolean }) {
  const [run, pending] = useAction()
  const countdown = useCountdown(request.expiresAt)
  const cmd = request.command
  const respond = (decision: PermissionDecision) =>
    run(() => call('permissions.respond', { id: request.id, decision }), {
      // Command outcomes are reported by ZVYRA's desktop notifications; avoid a second toast.
      success: cmd ? undefined : decision === 'deny' ? 'Denied' : 'Approved'
    })

  if (cmd) {
    return (
      <div className={`perm-card cmd risk-${request.risk} ${compact ? 'compact' : ''}`} role="alertdialog" aria-label={`Approve command: ${request.title}`}>
        <div className="perm-head">
          <span className="perm-icon">
            <ShieldAlert />
          </span>
          <div className="perm-text">
            <div className="perm-title">{request.title}</div>
            <div className="perm-desc">{request.description}</div>
          </div>
          <Badge tone={request.risk === 'high' ? 'danger' : request.risk === 'medium' ? 'warning' : 'neutral'}>{humanize(request.risk)} risk</Badge>
        </div>
        <pre className="perm-command selectable" aria-label="Command">
          <span className="perm-shell">
            <TerminalSquare />
            {cmd.shell === 'cmd' ? 'cmd' : 'PowerShell'}
          </span>
          {cmd.text.length > 600 ? `${cmd.text.slice(0, 600)}…` : cmd.text}
        </pre>
        {request.reason && <div className="perm-reason">{request.reason}</div>}
        <div className="perm-where selectable">
          <FolderOpen />
          <span title={cmd.cwd}>{cmd.cwd}</span>
        </div>
        {!!request.targets?.length && (
          <ul className="perm-targets selectable" aria-label="Affects">
            {request.targets.slice(0, compact ? 2 : 6).map((t) => (
              <li key={t} title={t}>
                {t}
              </li>
            ))}
            {request.targets.length > (compact ? 2 : 6) && <li>+{request.targets.length - (compact ? 2 : 6)} more</li>}
          </ul>
        )}
        <div className="perm-actions">
          <span className="perm-meta">{countdown ? `Expires in ${countdown}` : ''}</span>
          <Button size="sm" variant="ghost" icon={ShieldX} disabled={pending} onClick={() => respond('deny')}>
            Deny
          </Button>
          <Button
            size="sm"
            disabled={pending || !request.canAlwaysAllow}
            onClick={() => respond('allow_always')}
            title={request.canAlwaysAllow ? 'Allow this exact command in this folder from now on (you can revoke it in Settings → Permissions)' : 'High-risk commands are approved one at a time'}
          >
            Always Allow
          </Button>
          <Button size="sm" variant="primary" icon={ShieldCheck} disabled={pending} onClick={() => respond('allow_once')} title="Run this command once">
            Allow
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`perm-card risk-${request.risk} ${compact ? 'compact' : ''}`} role="alertdialog" aria-label={request.title}>
      <div className="perm-head">
        <span className="perm-icon">
          <ShieldAlert />
        </span>
        <div className="perm-text">
          <div className="perm-title">{request.title}</div>
          <div className="perm-desc selectable">{request.description}</div>
        </div>
        <Badge tone={request.risk === 'high' ? 'danger' : request.risk === 'medium' ? 'warning' : 'neutral'}>{humanize(request.risk)} risk</Badge>
      </div>
      {!compact && request.details && request.details.length > 0 && (
        <dl className="perm-details">
          {request.details.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd className="selectable">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="perm-actions">
        <span className="perm-meta">
          {humanize(request.category)}
          {countdown && ` · expires in ${countdown}`}
        </span>
        <Button size="sm" variant="ghost" icon={ShieldX} disabled={pending} onClick={() => respond('deny')}>
          Deny
        </Button>
        {!compact && (
          <Button size="sm" disabled={pending} onClick={() => respond('allow_task')}>
            Allow for task
          </Button>
        )}
        <Button size="sm" variant="primary" icon={ShieldCheck} disabled={pending} onClick={() => respond('allow_once')}>
          Allow once
        </Button>
      </div>
    </div>
  )
}
