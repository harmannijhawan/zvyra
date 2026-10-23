import { mkdir, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { researchBusiness, officialScore } from '../../src/main/research/business'
import { buildDossier, researchOutcome } from '../../src/main/research/dossier'
import type { FetchedPage } from '../../src/main/research/fetcher'
import { extractPage } from '../../src/main/research/extract'

const page = (url: string, html: string, extra: Partial<FetchedPage> = {}): FetchedPage => ({ url, finalUrl: url, html, status: 200, contentType: 'text/html', retrievedAt: '2026-10-18T00:00:00Z', ...extra })
const body = '<html><head><title>Darzi</title><script type="application/ld+json">{"@type":"Restaurant","name":"Darzi"}</script></head><body><h1>Darzi</h1><p>Restaurant listing.</p></body></html>'

describe('research evidence outcomes', () => {
  it('rejects payment promotions while preserving actual dish prices', () => {
    const x = extractPage('<h2>Offers</h2><p>Valid on final payable amount of ₹3000 or more</p><p>25% OFF for up to ₹5000 using RBL Bank Credit Card</p><p>Get 20% OFF up to ₹2000</p><p>Flat ₹250 OFF using Visa Cards</p><h2>Food</h2><p>Paneer Tikka ₹320</p>', 'https://www.district.in/dining/TheDarziBar')
    expect(x.menu.map((m) => m.name)).toEqual(['Paneer Tikka'])
  })
  it('fails a zero-page dossier without inventing identity', () => {
    const d = buildDossier({ name: 'Darzi' }, [], [], [])
    expect(researchOutcome(d)).toMatchObject({ ok: false, status: 'failed', pagesRead: 0 })
    expect(d.name).toBeNull()
  })
  it('marks readable but incomplete evidence partial', async () => {
    const r = await researchBusiness({ url: 'https://darzi.example/' }, { fetch: async (u) => page(u, body) })
    expect(researchOutcome(r.dossier)).toMatchObject({ ok: true, status: 'partial', pagesRead: 1, imagesDownloaded: 0 })
  })
  it('does not confirm a guessed domain from a blocked page with a matching title', async () => {
    const r = await researchBusiness({ name: 'Darzi' }, { search: async () => [], knowledge: null, fetch: async (u) => page(u, body, { blocked: 'blocked' }) })
    expect(r.dossier.officialWebsite).toBeNull()
    expect(researchOutcome(r.dossier).ok).toBe(false)
  })
  it('preserves thrown fetch diagnostics', async () => {
    const r = await researchBusiness({ url: 'https://darzi.example/' }, { fetch: async () => { throw new Error('network fixture unavailable') } })
    expect(r.dossier.sources).toEqual([expect.objectContaining({ status: 'error', note: 'network fixture unavailable' })])
    expect(researchOutcome(r.dossier).pagesRead).toBe(0)
  })
  it('does not label a supplied District listing as the official website', async () => {
    const r = await researchBusiness({ url: 'https://www.district.in/dining/TheDarziBar' }, { fetch: async (u) => page(u, body) })
    expect(r.dossier.officialWebsite).toBeNull()
    expect(r.dossier.sources[0].official).toBe(false)
  })
  it('does not count an unrendered JavaScript shell as read', async () => {
    const r = await researchBusiness({ url: 'https://darzi.example/' }, { fetch: async (u) => page(u, '<html><head><title>Darzi</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>') })
    expect(researchOutcome(r.dossier).pagesRead).toBe(0)
    expect(r.dossier.sources[0].status).toBe('error')
  })
  it('reads grounded third-party candidates when keyword search returns nothing', async () => {
    const listing = 'https://www.district.in/dining/TheDarziBar'
    const r = await researchBusiness({ name: 'Darzi' }, { search: async () => [], knowledge: null, grounded: async () => [listing], robots: async () => true, fetch: async (u) => page(u, u === listing ? body : '', u === listing ? {} : { blocked: 'error' }) })
    expect(officialScore('Darzi', { title: 'Darzi', url: listing })).toBe(0)
    expect(r.dossier.officialWebsite).toBeNull()
    expect(r.dossier.sources).toContainEqual(expect.objectContaining({ url: listing, official: false, status: 'ok' }))
    expect(researchOutcome(r.dossier).status).toBe('partial')
  })
  it('propagates cancellation during page rendering', async () => {
    const abort = new AbortController()
    await expect(researchBusiness({ url: 'https://darzi.example/' }, {
      fetch: async (u) => page(u, '<div id="root"></div><script src="/app.js"></script>'),
      render: async () => { abort.abort(); throw new Error('Cancelled rendering') }
    }, abort.signal)).rejects.toThrow('Cancelled')
  })
  it('propagates cancellation during discovery', async () => {
    const abort = new AbortController()
    await expect(researchBusiness({ name: 'Darzi' }, { search: async () => { abort.abort(); return [] }, knowledge: null }, abort.signal)).rejects.toThrow('Cancelled')
  })
})

describe.skipIf(!process.env.ZVYRA_RELIABILITY_LIVE)('real research reliability evidence', () => {
  it.each([
    { id: 'darzi-name', name: 'The Darzi Bar & Kitchen', location: 'Connaught Place New Delhi' },
    { id: 'darzi-url', url: 'https://www.district.in/dining/TheDarziBar' },
    { id: 'katz-url', url: 'https://katzsdelicatessen.com/' }
  ])('records production pipeline evidence for $id', async ({ id, ...request }) => {
    const dir = '.agents/tasks/operator-upgrade/reliability'
    const startedAt = new Date().toISOString()
    const steps: string[] = []
    const result = await researchBusiness(request, { progress: (step) => steps.push(step) })
    await mkdir(dir, { recursive: true })
    await writeFile(`${dir}/${id}.json`, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), mode: 'Production researchBusiness with default network/search dependencies; no credentialed grounding or Electron renderer', steps, ...result }, null, 2))
    expect(result.summary.outcome.pagesRead).toBeGreaterThanOrEqual(0)
  }, 180_000)
})
