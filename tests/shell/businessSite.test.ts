import { describe, expect, it } from 'vitest'
import { businessSiteHtml } from '../../src/main/agent/businessSite'
import { buildDossier } from '../../src/main/research/dossier'
import { extractPage } from '../../src/main/research/extract'

describe('source-based site generation', () => {
  it('refuses empty research instead of inventing restaurant content', () => {
    expect(() => businessSiteHtml(buildDossier({name:'Unverified restaurant'},[],[],[]))).toThrow(/sourced business identity/)
  })
  it('escapes content, keeps missing prices unknown, and only uses local images', () => {
    const url = 'https://restaurant.example/'
    const retrievedAt = new Date().toISOString()
    const extract = extractPage(`<script type="application/ld+json">{"@type":"Restaurant","name":"A & B","hasMenu":{"@type":"Menu","hasMenuItem":{"@type":"MenuItem","name":"Soup"}}}</script>`,url)
    const d = buildDossier({},[{extract,retrievedAt,official:true}],[{url,retrievedAt,status:'ok',official:true}],[])
    d.description = {value:'<script>alert(1)</script>',sources:d.name!.sources,confidence:'medium'}
    d.images.push({url:'https://example.org/unvalidated.jpg',pageUrl:url,retrievedAt,official:true,rights:'unknown',role:'content'})
    const html = businessSiteHtml(d)
    expect(html).toContain('A &amp; B')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('Soup')
    expect(html).toContain('Price unclear in scan')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('tel:')
    expect(html).toContain('Address not verified')
  })
})
