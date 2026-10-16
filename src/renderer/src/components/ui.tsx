/** Shared UI primitives. Small, accessible, styled by styles/base.css + app.css. */
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { dismissToast, useToasts } from '../lib/toast'
import type { Tone } from '../lib/format'

type BtnVariant = 'default' | 'primary' | 'ghost' | 'danger'

export function Button({
  variant = 'default',
  size,
  icon: Icon,
  loading,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'lg'; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button
      type="button"
      className={`btn ${variant !== 'default' ? `btn-${variant}` : ''} ${size ? `btn-${size}` : ''} ${className ?? ''}`}
      disabled={rest.disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : Icon ? <Icon /> : null}
      {children}
    </button>
  )
}

export function IconButton({
  icon: Icon,
  label,
  size,
  active,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; size?: 'sm'; active?: boolean }) {
  return (
    <button
      type="button"
      className={`icon-btn ${size ?? ''} ${active ? 'active' : ''} ${className ?? ''}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon />
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Badge({ tone = 'neutral', children, icon: Icon }: { tone?: Tone; children: ReactNode; icon?: LucideIcon }) {
  return (
    <span className={`badge ${tone}`}>
      {Icon && <Icon />}
      {children}
    </span>
  )
}

export function Dot({ tone, pulse }: { tone?: 'success' | 'warning' | 'danger' | 'info'; pulse?: boolean }) {
  return <span className={`dot ${tone ?? ''} ${pulse ? 'pulse' : ''}`} aria-hidden="true" />
}

export function Card({
  title,
  icon: Icon,
  actions,
  children,
  className,
  padded = true
}: {
  title?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <section className={`card ${padded ? 'padded' : ''} ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && (
            <h3 className="card-title">
              {Icon && <Icon />}
              {title}
            </h3>
          )}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 480
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button.btn-primary, button')
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
  children
}: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-body">{body}</div>
      {children}
    </Modal>
  )
}

export function Field({ label, help, children, htmlFor }: { label: string; help?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help && <div className="field-help">{help}</div>}
    </div>
  )
}

const TOAST_ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle }

export function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = TOAST_ICON[t.tone]
        return (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span className="toast-icon">
              <Icon />
            </span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-msg">{t.message}</div>}
            </div>
            {t.action && (
              <Button
                size="sm"
                onClick={() => {
                  t.action!.run()
                  dismissToast(t.id)
                }}
              >
                {t.action.label}
              </Button>
            )}
            <IconButton icon={X} label="Dismiss" size="sm" onClick={() => dismissToast(t.id)} />
          </div>
        )
      })}
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="progressbar" aria-label="Loading" />
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  )
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="kv">
      {items.map((i) => (
        <div key={i.label} className="kv-row">
          <dt>{i.label}</dt>
          <dd>{i.value}</dd>
        </div>
      ))}
    </dl>
  )
}
