/**
 * Opt-in live check against the real web (ZVYRA_LIVE=1). Not part of the normal
 * run: results depend on the network and on the sites. Prints what was found.
 */
import { describe, expect, it } from 'vitest'
import { researchBusiness } from '../../src/main/research/business'

describe.skipIf(!process.env['ZVYRA_LIVE'])('live research', () => {
  it.for([
    { name: process.env['ZVYRA_LIVE_NAME'] ?? 'Swiggy', location: process.env['ZVYRA_LIVE_WHERE'] ?? '' }
  ])('researches $name', async (q) => {
    const r = await researchBusiness(q, { progress: (s) => console.log('·', s) })
    const s = r.summary
    const out = process.env['ZVYRA_LIVE_OUT']
    if (out) (await import('node:fs')).writeFileSync(out, JSON.stringify(r.summary, null, 1))
    console.log(JSON.stringify({ name: s.name, site: s.officialWebsite, phones: s.phones, emails: s.emails, addresses: s.addresses, menu: s.menu.count, products: s.products.count, images: s.images.count, conflicts: s.conflicts.map((c) => c.field), unavailable: s.unavailable, sources: s.sources }, null, 1))
    expect(r.dossier.sources.length).toBeGreaterThan(0)
  }, 120_000)
})
