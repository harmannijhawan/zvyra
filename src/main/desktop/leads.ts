/**
 * OWNER: Kiro. Lead records for client acquisition (local JSON, no cloud).
 *
 *  - one record per business: duplicates are detected by website host, phone
 *    (last 10 digits) or name + location, and merged instead of re-created,
 *  - contact details are stored with the source URL they were verified from,
 *  - interactions are only logged by the tools that performed them (verified
 *    or explicitly unverified); nothing is logged on the model's say-so,
 *  - "do not contact" is respected by the messaging tools.
 */
import { randomUUID } from 'node:crypto'
import type { JsonDoc } from './jsonDoc'

export type LeadStatus = 'new' | 'researched' | 'concept_ready' | 'contacted' | 'replied' | 'interested' | 'proposal_sent' | 'won' | 'lost' | 'do_not_contact'
export const LEAD_STATUSES: LeadStatus[] = ['new', 'researched', 'concept_ready', 'contacted', 'replied', 'interested', 'proposal_sent', 'won', 'lost', 'do_not_contact']

export interface VerifiedContact {
  value: string
  source: string
}

export interface LeadInteraction {
  id: string
  at: string
  channel: 'whatsapp' | 'email' | 'call' | 'note' | 'browser'
  kind: 'draft_opened' | 'message_sent' | 'call_interface_opened' | 'email_drafted' | 'reply_received' | 'note'
  summary: string
  /** True only when the tool confirmed the outcome (e.g. the message left the compose box). */
  verified: boolean
}

export interface Lead {
  id: string
  name: string
  category?: string
  location?: string
  website?: string
  sourceUrls: string[]
  phones: VerifiedContact[]
  emails: VerifiedContact[]
  whatsapp: VerifiedContact[]
  address?: VerifiedContact
  notes: string
  opportunities: string[]
  proposedServices: string[]
  proposal?: string
  drafts: { channel: 'whatsapp' | 'email'; text: string; createdAt: string }[]
  status: LeadStatus
  lastContactAt?: string
  followUpAt?: string
  dossierPath?: string
  projectPath?: string
  interactions: LeadInteraction[]
  createdAt: string
  updatedAt: string
}

export interface LeadsState {
  leads: Lead[]
}

const hostOf = (u?: string) => {
  if (!u) return ''
  try {
    return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}
const digits = (p: string) => p.replace(/\D/g, '').slice(-10)
const key = (s?: string) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Is `b` the same business as `a`? */
export function sameLead(a: Pick<Lead, 'name' | 'location' | 'website' | 'phones' | 'whatsapp'>, b: Partial<Pick<Lead, 'name' | 'location' | 'website' | 'phones' | 'whatsapp'>>): boolean {
  const ha = hostOf(a.website)
  const hb = hostOf(b.website)
  if (ha && hb && ha === hb) return true
  const pa = new Set([...a.phones, ...a.whatsapp].map((p) => digits(p.value)).filter((d) => d.length >= 7))
  if ([...(b.phones ?? []), ...(b.whatsapp ?? [])].some((p) => pa.has(digits(p.value)))) return true
  if (key(a.name) && key(a.name) === key(b.name)) return !a.location || !b.location || key(a.location) === key(b.location)
  return false
}

function mergeContacts(a: VerifiedContact[], b: VerifiedContact[] | undefined, norm: (s: string) => string) {
  const out = [...a]
  for (const c of b ?? []) if (c.value && !out.some((x) => norm(x.value) === norm(c.value))) out.push(c)
  return out
}

export type LeadInput = Partial<Omit<Lead, 'id' | 'createdAt' | 'updatedAt' | 'interactions'>> & { name: string }

export class LeadStore {
  constructor(private readonly doc: JsonDoc<LeadsState>) {}

  list(filter: { status?: LeadStatus; dueBefore?: string; query?: string } = {}): Lead[] {
    return this.doc
      .get()
      .leads.filter((l) => !filter.status || l.status === filter.status)
      .filter((l) => !filter.dueBefore || (l.followUpAt && l.followUpAt <= filter.dueBefore))
      .filter((l) => !filter.query || key(`${l.name} ${l.location} ${l.website} ${l.category}`).includes(key(filter.query)))
  }

  get(id: string) {
    return this.doc.get().leads.find((l) => l.id === id)
  }

  find(q: Partial<Lead>): Lead | undefined {
    return this.doc.get().leads.find((l) => sameLead(l, q))
  }

  /** Creates the lead or merges into the existing record for the same business. */
  upsert(input: LeadInput): { lead: Lead; created: boolean } {
    const now = new Date().toISOString()
    const existing = this.find(input)
    if (existing) {
      const merged: Lead = {
        ...existing,
        ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && !['name', 'phones', 'emails', 'whatsapp', 'sourceUrls', 'opportunities', 'proposedServices', 'drafts', 'notes'].includes(k))),
        phones: mergeContacts(existing.phones, input.phones, digits),
        emails: mergeContacts(existing.emails, input.emails, (s) => s.toLowerCase()),
        whatsapp: mergeContacts(existing.whatsapp, input.whatsapp, digits),
        sourceUrls: [...new Set([...existing.sourceUrls, ...(input.sourceUrls ?? [])])],
        opportunities: [...new Set([...existing.opportunities, ...(input.opportunities ?? [])])],
        proposedServices: [...new Set([...existing.proposedServices, ...(input.proposedServices ?? [])])],
        drafts: [...existing.drafts, ...(input.drafts ?? [])].slice(-20),
        notes: input.notes && !existing.notes.includes(input.notes) ? `${existing.notes}${existing.notes ? '\n' : ''}${input.notes}` : existing.notes,
        // A do-not-contact lead stays that way unless the user changes it explicitly with a status update.
        status: existing.status === 'do_not_contact' ? 'do_not_contact' : (input.status ?? existing.status),
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now
      }
      this.save(merged)
      return { lead: merged, created: false }
    }
    const lead: Lead = {
      id: `lead-${randomUUID().slice(0, 8)}`,
      name: input.name.trim(),
      category: input.category,
      location: input.location,
      website: input.website,
      sourceUrls: input.sourceUrls ?? [],
      phones: input.phones ?? [],
      emails: input.emails ?? [],
      whatsapp: input.whatsapp ?? [],
      address: input.address,
      notes: input.notes ?? '',
      opportunities: input.opportunities ?? [],
      proposedServices: input.proposedServices ?? [],
      proposal: input.proposal,
      drafts: input.drafts ?? [],
      status: input.status ?? 'new',
      followUpAt: input.followUpAt,
      dossierPath: input.dossierPath,
      projectPath: input.projectPath,
      interactions: [],
      createdAt: now,
      updatedAt: now
    }
    this.save(lead)
    return { lead, created: true }
  }

  /** Explicit update by id (status, follow-up, notes, proposal…). */
  update(id: string, patch: Partial<Pick<Lead, 'status' | 'followUpAt' | 'notes' | 'proposal' | 'opportunities' | 'proposedServices' | 'projectPath' | 'dossierPath' | 'category' | 'location'>> & { addDraft?: { channel: 'whatsapp' | 'email'; text: string } }): Lead {
    const l = this.get(id)
    if (!l) throw new Error(`No lead with id ${id}`)
    if (patch.status && !LEAD_STATUSES.includes(patch.status)) throw new Error(`Unknown status ${patch.status}`)
    const { addDraft, ...rest } = patch
    const next: Lead = {
      ...l,
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      drafts: addDraft ? [...l.drafts, { ...addDraft, createdAt: new Date().toISOString() }].slice(-20) : l.drafts,
      updatedAt: new Date().toISOString()
    }
    this.save(next)
    return next
  }

  /** Only called by tools that performed (and checked) the interaction. */
  logInteraction(id: string, i: Omit<LeadInteraction, 'id' | 'at'>): Lead {
    const l = this.get(id)
    if (!l) throw new Error(`No lead with id ${id}`)
    const at = new Date().toISOString()
    const contacted = i.verified && (i.kind === 'message_sent' || i.kind === 'call_interface_opened')
    const next: Lead = {
      ...l,
      interactions: [...l.interactions, { ...i, id: randomUUID().slice(0, 8), at }].slice(-200),
      lastContactAt: contacted ? at : l.lastContactAt,
      status: contacted && ['new', 'researched', 'concept_ready'].includes(l.status) ? 'contacted' : l.status,
      updatedAt: at
    }
    this.save(next)
    return next
  }

  /** Leads matching a phone number (for messaging tools). */
  byPhone(phone: string) {
    const d = digits(phone)
    return this.doc.get().leads.find((l) => [...l.phones, ...l.whatsapp].some((p) => digits(p.value) === d))
  }

  private save(l: Lead) {
    this.doc.set((s) => ({ leads: [l, ...s.leads.filter((x) => x.id !== l.id)].slice(0, 5000) }))
  }
}
