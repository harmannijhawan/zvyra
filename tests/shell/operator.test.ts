import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ActionApprovals, stillApproved } from '../../src/main/desktop/actionApprovals'
import { JsonDoc } from '../../src/main/desktop/jsonDoc'
import { LeadStore, sameLead, type LeadsState } from '../../src/main/desktop/leads'
import { AgentTasks, type AgentTasksState } from '../../src/main/desktop/agentTasks'
import { contrast, designBrief, detectCategory, readableOn } from '../../src/main/agent/designBrief'
import { sniffImage } from '../../src/main/research/assets'
import { serveStatic } from '../../src/main/agent/staticServer'
import { checkMessage, toWaNumber, waLink } from '../../src/main/tools/whatsapp'

const dir = mkdtempSync(join(tmpdir(), 'zvyra-op-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('action approvals (messages, calls, risky clicks)', () => {
  it('waits for the user, binds to the exact payload and never auto-approves', async () => {
    const seen: string[] = []
    const a = new ActionApprovals({ requested: (r) => seen.push(r.id), resolved: () => undefined })
    const r = a.request({ category: 'external_communication', title: 'Send WhatsApp', description: 'x', risk: 'high', payload: { number: '919822012345', text: 'Hello' } })
    expect(a.list()[0]).toMatchObject({ canAlwaysAllow: false, category: 'external_communication' })
    expect(() => a.respond(r.id, 'allow_always')).toThrow(/one at a time/)
    a.respond(r.id, 'allow_once')
    expect(await r.outcome).toBe('allow_once')
    expect(stillApproved(r.fingerprint, { number: '919822012345', text: 'Hello' })).toBe(true)
    expect(stillApproved(r.fingerprint, { number: '919822012345', text: 'Hello!' })).toBe(false)
    expect(seen).toHaveLength(1)
  })
  it('expires unanswered requests as a denial', async () => {
    const a = new ActionApprovals({ requested: () => undefined, resolved: () => undefined }, 20)
    expect(await a.request({ category: 'external_communication', title: 't', description: 'd', risk: 'high', payload: 1 }).outcome).toBe('expired')
  })
  it('denies everything on stop-all', async () => {
    const a = new ActionApprovals({ requested: () => undefined, resolved: () => undefined })
    const r = a.request({ category: 'browser', title: 't', description: 'd', risk: 'medium', payload: 2 })
    a.denyAll()
    expect(await r.outcome).toBe('deny')
  })
})

describe('leads', () => {
  const store = () => new LeadStore(new JsonDoc<LeadsState>(join(dir, `leads-${Math.random()}.json`), { leads: [] }))
  it('merges duplicates by website, phone or name + location', () => {
    const s = store()
    const a = s.upsert({ name: 'Spice Garden', location: 'Pune', website: 'https://spicegarden.example', phones: [{ value: '+91 98220 12345', source: 'https://spicegarden.example/' }] })
    expect(a.created).toBe(true)
    expect(s.upsert({ name: 'Spice Garden Restaurant', website: 'http://www.spicegarden.example/menu' }).created).toBe(false)
    expect(s.upsert({ name: 'SG', phones: [{ value: '098220 12345', source: 'https://listing.example' }] }).created).toBe(false)
    expect(s.upsert({ name: 'spice garden', location: 'pune' }).created).toBe(false)
    expect(s.upsert({ name: 'Spice Garden', location: 'Mumbai' }).created).toBe(true)
    expect(s.list()).toHaveLength(2)
    expect(s.list({ query: 'pune' })[0].phones).toHaveLength(1)
  })
  it('keeps do-not-contact and only marks contacted after verified interactions', () => {
    const s = store()
    const { lead } = s.upsert({ name: 'Cafe Uno' })
    s.logInteraction(lead.id, { channel: 'whatsapp', kind: 'message_sent', summary: 'sent_unverified', verified: false })
    expect(s.get(lead.id)!.status).toBe('new')
    s.logInteraction(lead.id, { channel: 'whatsapp', kind: 'message_sent', summary: 'ok', verified: true })
    expect(s.get(lead.id)!.status).toBe('contacted')
    s.update(lead.id, { status: 'do_not_contact' })
    expect(s.upsert({ name: 'Cafe Uno', status: 'interested' }).lead.status).toBe('do_not_contact')
  })
  it('compares records conservatively', () => {
    expect(sameLead({ name: 'A', phones: [], whatsapp: [] }, { name: 'B' })).toBe(false)
  })
})

describe('agent plans', () => {
  it('shows the declared plan and never reports unstarted steps as done', () => {
    const t = new AgentTasks(new JsonDoc<AgentTasksState>(join(dir, 'tasks.json'), { tasks: [], events: {} }), () => undefined, () => undefined)
    const task = t.start('Research and build', 'island', new AbortController())
    t.setPlan(task.id, [
      { title: 'Research', status: 'done' },
      { title: 'Build', status: 'running' },
      { title: 'Message owner', status: 'pending' }
    ])
    t.step(task.id, 'Writing index.html')
    expect(t.get(task.id)!.plan.map((p) => p.title)).toEqual(['Research', 'Build', 'Message owner'])
    t.finish(task.id, { status: 'completed', summary: 'ok' })
    expect(t.get(task.id)!.plan.map((p) => p.status)).toEqual(['done', 'done', 'skipped'])
  })
})

describe('design brief', () => {
  it('detects categories from the strongest hint first', () => {
    expect(detectCategory('Restaurant', 'Spice Garden')).toBe('restaurant')
    expect(detectCategory('JewelryStore')).toBe('jewelry')
    expect(detectCategory(undefined, 'Swiggy', 'Indian online food ordering and delivery platform')).toBe('restaurant')
    expect(detectCategory('Corporation', 'Swiggy')).toBe('tech')
    expect(detectCategory('nothing here')).toBe('generic')
  })
  it('gives different industries different directions', () => {
    const r = designBrief({ category: 'restaurant' })
    const j = designBrief({ category: 'jewelry' })
    const t = designBrief({ category: 'tech' })
    expect(new Set([r.fonts.display, j.fonts.display, t.fonts.display]).size).toBe(3)
    expect(r.conversion).not.toBe(j.conversion)
  })
  it('uses brand colours but keeps them readable', () => {
    const b = designBrief({ category: 'cafe', themeColor: '#f5e663' })
    expect(b.brandColorsUsed).toContain('#f5e663')
    expect(contrast(b.palette.accent, b.palette.bg)).toBeGreaterThanOrEqual(4.5)
    expect(readableOn('#111111', '#ffffff')).toBe('#111111')
  })
  it('adds content rules for missing data instead of inventing it', () => {
    const b = designBrief({ category: 'restaurant', available: { menu: 0, products: 0, images: 0, phone: false, whatsapp: false, address: true, hours: false } })
    expect(b.contentRules.join(' ')).toMatch(/do not create one/)
    expect(b.contentRules.join(' ')).toMatch(/do not fake product photos/)
  })
})

describe('image validation', () => {
  it('reads real dimensions from file headers', () => {
    const png = Buffer.alloc(33)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(1200, 16)
    png.writeUInt32BE(800, 20)
    expect(sniffImage(png)).toEqual({ type: 'png', width: 1200, height: 800 })
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0, 0, 0, 0, 0])
    expect(sniffImage(jpg)).toEqual({ type: 'jpeg', width: 800, height: 600 })
    expect(sniffImage(Buffer.from('<svg width="64" height="32" xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({ type: 'svg', width: 64, height: 32 })
  })
  it('rejects non-images and scripted SVG', () => {
    expect(sniffImage(Buffer.from('<html>not an image</html>'))).toBeNull()
    expect(sniffImage(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull()
  })
})

describe('local preview server', () => {
  it('serves the site folder and refuses paths outside it', async () => {
    const site = join(dir, 'site')
    mkdirSync(join(site, 'css'), { recursive: true })
    writeFileSync(join(site, 'index.html'), '<!doctype html><title>t</title>')
    writeFileSync(join(site, 'css', 'a.css'), 'body{}')
    writeFileSync(join(dir, 'secret.txt'), 'no')
    const url = await serveStatic(site)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const home = await fetch(url)
    expect(home.status).toBe(200)
    expect(home.headers.get('content-type')).toMatch(/text\/html/)
    expect((await fetch(`${url}css/a.css`)).headers.get('content-type')).toMatch(/text\/css/)
    expect((await fetch(`${url}..%2Fsecret.txt`)).status).not.toBe(200)
    expect((await fetch(`${url}missing.html`)).status).toBe(404)
  })
})

describe('WhatsApp helpers', () => {
  it('requires an international number unless a default country code is set', () => {
    expect(toWaNumber('+91 98220 12345')).toBe('919822012345')
    expect(toWaNumber('0091 98220 12345')).toBe('919822012345')
    expect(() => toWaNumber('098220 12345')).toThrow(/country code/)
    expect(toWaNumber('098220 12345', '91')).toBe('919822012345')
  })
  it('builds the official click-to-chat link and validates text', () => {
    expect(waLink('919822012345', 'Hi & welcome')).toBe('whatsapp://send?phone=919822012345&text=Hi%20%26%20welcome')
    expect(() => checkMessage('   ')).toThrow(/empty/)
  })
})

describe('WhatsApp chat by name', () => {
  it('matches the chat header to the requested name without partial-word mistakes', async () => {
    const { nameMatches } = await import('../../src/main/tools/whatsappVision')
    expect(nameMatches('Manan Sharma', 'Manan')).toBe(true)
    expect(nameMatches('manan', 'Manan')).toBe(true)
    expect(nameMatches('Mananya', 'Manan')).toBe(false)
    expect(nameMatches('Harman', 'Manan')).toBe(false)
  })
})
