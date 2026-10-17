/**
 * OWNER: Kiro. Work calls through Twilio Programmable Voice (documented REST
 * API: POST /2010-04-01/Accounts/{Sid}/Calls.json). A call is reported as
 * "placed" only when Twilio returns a Call SID.
 */
import { ZvyraError, type CallProviderStatus, type ConfigField, type NotificationPriority } from '../../shared/contract'
import type { JsonDoc } from './jsonDoc'
import { isE164, maskPhone, xmlEscape } from './pure'
import type { SecretStore } from './secrets'

export interface CallsState {
  provider: 'twilio' | null
  accountSid: string
  from: string
  to: string
  enabled: boolean
  minPriority: NotificationPriority
  lastCall?: CallProviderStatus['lastCall']
  /** Phone the user when a task finishes or fails while they are away from the PC. */
  callWhenAway?: boolean
  /** Minutes without keyboard/mouse input (or a locked PC) that count as "away". */
  awayMinutes?: number
}

export const CALLS_DEFAULT: CallsState = { provider: null, accountSid: '', from: '', to: '', enabled: false, minPriority: 'critical', callWhenAway: true, awayMinutes: 5 }
const TOKEN = 'twilio.authToken'

export class CallService {
  constructor(
    private readonly doc: JsonDoc<CallsState>,
    private readonly secrets: SecretStore,
    private readonly onActivity: (type: string, title: string, detail?: string, level?: 'info' | 'success' | 'warning' | 'error') => void
  ) {}

  private configured() {
    const s = this.doc.get()
    return s.provider === 'twilio' && !!s.accountSid && !!s.from && !!s.to && this.secrets.has(TOKEN)
  }

  status(): CallProviderStatus {
    const s = this.doc.get()
    const fields: ConfigField[] = [
      { key: 'accountSid', label: 'Account SID', type: 'text', required: true, placeholder: 'AC…', value: s.accountSid },
      { key: 'authToken', label: 'Auth token', type: 'secret', required: true, hasValue: this.secrets.has(TOKEN) },
      { key: 'from', label: 'Twilio number (from)', type: 'text', required: true, placeholder: '+14155550100', value: s.from, help: 'E.164 format' },
      { key: 'to', label: 'Your phone (to)', type: 'text', required: true, placeholder: '+14155550123', value: s.to, help: 'E.164 format' }
    ]
    return {
      provider: s.provider,
      configured: this.configured(),
      enabled: s.enabled && this.configured(),
      minPriority: s.minPriority,
      destinationMasked: s.to ? maskPhone(s.to) : undefined,
      fields,
      providers: [{ id: 'twilio', name: 'Twilio Programmable Voice' }],
      lastCall: s.lastCall,
      callWhenAway: s.callWhenAway ?? true,
      awayMinutes: s.awayMinutes ?? 5
    }
  }

  /** Away-calls are on and calls are set up. */
  wantsAwayCalls() {
    const s = this.doc.get()
    return this.configured() && (s.callWhenAway ?? true)
  }

  awayMinutes() {
    return this.doc.get().awayMinutes ?? 5
  }

  configure(provider: string, values: Record<string, unknown>): CallProviderStatus {
    if (provider !== 'twilio') throw new ZvyraError('INVALID_ARGS', 'Unsupported call provider')
    const sid = String(values['accountSid'] ?? '').trim()
    const from = String(values['from'] ?? '').trim()
    const to = String(values['to'] ?? '').trim()
    const token = String(values['authToken'] ?? '').trim()
    if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) throw new ZvyraError('INVALID_ARGS', 'Account SID should start with AC followed by 32 hex characters')
    if (!isE164(from) || !isE164(to)) throw new ZvyraError('INVALID_ARGS', 'Phone numbers must be in E.164 format, e.g. +14155550123')
    if (token) this.secrets.set(TOKEN, token)
    if (!this.secrets.has(TOKEN)) throw new ZvyraError('INVALID_ARGS', 'Enter the Twilio auth token')
    this.doc.set({ provider: 'twilio', accountSid: sid, from, to })
    return this.status()
  }

  setEnabled(enabled: boolean, minPriority?: NotificationPriority, away?: { callWhenAway?: boolean; awayMinutes?: number }): CallProviderStatus {
    if (enabled && !this.configured()) throw new ZvyraError('NOT_CONFIGURED', 'Configure a call provider first', 'settings/notifications')
    const patch: Partial<CallsState> = { enabled, ...(minPriority ? { minPriority } : {}) }
    if (typeof away?.callWhenAway === 'boolean') patch.callWhenAway = away.callWhenAway
    if (typeof away?.awayMinutes === 'number' && Number.isFinite(away.awayMinutes)) patch.awayMinutes = Math.max(1, Math.min(240, Math.round(away.awayMinutes)))
    this.doc.set(patch)
    return this.status()
  }

  shouldCall(priority: NotificationPriority, rank: (p: NotificationPriority, min: NotificationPriority) => boolean) {
    const s = this.doc.get()
    return s.enabled && this.configured() && rank(priority, s.minPriority)
  }

  async place(message: string): Promise<CallProviderStatus> {
    if (!this.configured()) throw new ZvyraError('NOT_CONFIGURED', 'Configure a call provider first', 'settings/notifications')
    const s = this.doc.get()
    const token = this.secrets.get(TOKEN)
    if (!token) throw new ZvyraError('NOT_CONFIGURED', 'The stored auth token could not be read. Enter it again.', 'settings/notifications')
    const body = new URLSearchParams({
      To: s.to,
      From: s.from,
      Twiml: `<Response><Say>${xmlEscape(message.slice(0, 1000))}</Say></Response>`
    })
    let status: CallsState['lastCall']
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.accountSid)}/Calls.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${s.accountSid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20_000)
      })
      const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string }
      status = res.ok && json.sid ? { ts: new Date().toISOString(), status: 'placed', reference: json.sid } : { ts: new Date().toISOString(), status: 'failed', error: json.message ?? `HTTP ${res.status}` }
    } catch (err) {
      status = { ts: new Date().toISOString(), status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    this.doc.set({ lastCall: status })
    this.onActivity('call.' + status!.status, status!.status === 'placed' ? 'Call placed' : 'Call failed', status!.reference ?? status!.error, status!.status === 'placed' ? 'success' : 'error')
    if (status!.status === 'failed') throw new ZvyraError('BACKEND_ERROR', `Twilio: ${status!.error}`)
    return this.status()
  }
}
