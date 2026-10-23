import { describe, expect, it } from 'vitest'
import { CompletionEvidence } from '../../src/main/agent/completion'

describe('runtime completion evidence', () => {
  it('requires a local site check after HTML creation and later stylesheet changes', () => {
    const e = new CompletionEvidence()
    e.observe('create_file', {}, { path: 'D:\\site\\index.html' })
    expect(e.issues()).toHaveLength(1)
    e.observe('check_site', { target: 'D:\\other-site' }, { ok: true })
    expect(e.issues()).toHaveLength(1)
    e.observe('check_site', { target: 'D:\\site' }, { ok: true })
    expect(e.issues()).toEqual([])
    e.observe('edit_file', {}, { path: 'D:\\site\\styles.css' })
    expect(e.issues()).toHaveLength(1)
    e.observe('check_site', { target: 'D:\\site\\index.html' }, { ok: true })
    expect(e.issues()).toEqual([])
  })
  it('does not erase failed research when a different project succeeds', () => {
    const e = new CompletionEvidence()
    e.observe('research_business', { save_to: 'a' }, { ok: false, error: 'No pages read' })
    e.observe('research_business', { save_to: 'b' }, { ok: true })
    expect(e.issues()).toEqual(['No pages read'])
    e.observe('research_business', { save_to: 'a' }, { ok: true, status: 'partial' })
    expect(e.issues()).toEqual([])
  })
  it('treats ok:false and thrown-tool errors as failed verification', () => {
    const e = new CompletionEvidence()
    e.observe('check_site', { target: 'a' }, { ok: false, issues: ['clipped heading'] })
    expect(e.issues()).toEqual(['clipped heading'])
    e.observe('check_site', { target: 'a' }, { error: 'Browser failed' })
    expect(e.issues()).toEqual(['Browser failed'])
    e.observe('check_site', { target: 'a' }, { ok: true })
    expect(e.issues()).toEqual([])
  })
  it('does not demand browser testing for an unrelated source edit', () => {
    const e = new CompletionEvidence()
    e.observe('edit_file', {}, { path: 'D:/source/main.ts' })
    expect(e.issues()).toEqual([])
  })
})
