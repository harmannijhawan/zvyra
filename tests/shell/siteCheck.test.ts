import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ widths: [] as number[], screenshot: 'aW1hZ2U=', review: '{}', reviewError: false, anchors: [] as string[], clipped: [] as string[] }))
vi.mock('electron', () => ({
  app: { getPath: () => '/qa-test' },
  session: { fromPartition: () => ({ webRequest: { onErrorOccurred() {}, onCompleted() {} }, setPermissionRequestHandler() {} }) },
  BrowserWindow: class {
    constructor(opts: { width: number }) { state.widths.push(opts.width) }
    webContents = {
      id: 1, on() {}, setWindowOpenHandler() {}, setUserAgent() {},
      debugger: { attach() {}, detach() {}, sendCommand: async () => ({ data: state.screenshot }) },
      executeJavaScript: async (source: string) => source.includes('const vis =') ? {
        title: 'Example', text: 'Example', seo: { title: true, description: true, viewport: true, lang: true, h1Count: 1, ogImage: true },
        a11y: { imagesWithoutAlt: 0, emptyLinks: 0, unlabeledInputs: 0, unnamedButtons: 0 },
        overflow: null, broken: [], small: [], low: [], clipped: state.clipped, brokenAnchors: state.anchors, ph: [], links: [], height: 900
      } : []
    }
    async loadURL() {}
    destroy() {}
  }
}))
vi.mock('node:fs', () => ({ existsSync: () => true, mkdirSync() {}, statSync: () => ({ size: 10 }), writeFileSync() {} }))
vi.mock('../../src/main/agent/staticServer', () => ({ previewUrl: vi.fn() }))
vi.mock('../../src/main/tools/gemini', () => ({ generateWithFallback: async () => {
  if (state.reviewError) throw new Error('vision unavailable')
  return { res: { text: state.review } }
} }))
import { checkSite } from '../../src/main/agent/siteCheck'

describe('site delivery QA gates', () => {
  beforeEach(() => { state.widths = []; state.screenshot = 'aW1hZ2U='; state.review = '{"issues":[]}'; state.reviewError = false; state.anchors = []; state.clipped = [] })
  it('checks all required sizes with unique screenshot names', async () => {
    const report = await checkSite('https://example.test')
    expect(state.widths.sort((a, b) => a - b)).toEqual([360, 390, 768, 1024, 1440])
    expect(new Set(report.viewports.map(v => v.screenshot)).size).toBe(5)
    expect(report.ok).toBe(true)
  })
  it('fails delivery when screenshots are empty', async () => {
    state.screenshot = ''
    const report = await checkSite('https://example.test')
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.includes('screenshot missing'))).toBe(true)
  })
  it('fails delivery for high severity visual findings and review errors', async () => {
    state.review = '{"issues":[{"severity":"high","area":"hero","issue":"Heading clipped","fix":"Wrap heading"}]}'
    const report = await checkSite('https://example.test', { review: { key: 'test' } })
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.includes('Heading clipped'))).toBe(true)
    state.reviewError = true
    const failed = await checkSite('https://example.test', { review: { key: 'test' } })
    expect(failed.ok).toBe(false)
    expect(failed.issues.some(i => i.includes('vision unavailable'))).toBe(true)
  })
  it('propagates clipped text and missing same-page anchors into failures', async () => {
    state.clipped = ['h1 Heading']
    state.anchors = ['https://example.test/#missing']
    const report = await checkSite('https://example.test')
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.includes('clipped text'))).toBe(true)
    expect(report.brokenLinks).toEqual(['missing anchor https://example.test/#missing'])
  })
})
