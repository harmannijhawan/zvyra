/** Approval request card, shared by the island, Home, Tasks and Computer screens. */
import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
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
  const respond = (decision: PermissionDecision) =>
    run(() => call('permissions.respond', { id: request.id, decision }), {
      success: decision === 'deny' ? 'Denied' : 'Approved'
    })
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
