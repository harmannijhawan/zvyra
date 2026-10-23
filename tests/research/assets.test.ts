import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeImage, downloadAssets } from '../../src/main/research/assets'
import type { Dossier } from '../../src/main/research/dossier'

const { decode, robots, chromium } = vi.hoisted(() => ({ decode: vi.fn(), robots: vi.fn(), chromium: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: decode } }))
vi.mock('../../src/main/research/fetcher', async (original) => ({ ...await original<object>(), robotsAllows: robots }))
vi.mock('../../src/main/research/render', () => ({ decodeInChromium: chromium }))
const png = () => { const b = Buffer.alloc(24); b.writeUInt32BE(0x89504e47); b.writeUInt32BE(1200, 16); b.writeUInt32BE(800, 20); return b }
const decoded = (width = 1200) => ({ isEmpty: () => false, getSize: () => ({ width, height: 800 }), toBitmap: () => Buffer.alloc(4) })
const dossier = (urls = ['https://example.org/photo.png']) => ({ images: urls.map(url => ({ url, pageUrl: 'https://example.org/', role: 'content', official: true, rights: 'Source photo' })) }) as Dossier
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'zvyra-assets-')); robots.mockResolvedValue(true); decode.mockReturnValue(decoded()) })
afterEach(async () => { vi.unstubAllGlobals(); vi.clearAllMocks(); await rm(dir, { recursive: true, force: true }) })
describe('decoded asset acquisition', () => {
  it('never accepts a header-only image rejected by the runtime decoder', async () => {
    decode.mockReturnValue({ isEmpty: () => true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png(), { headers: { 'content-type': 'image/png' } })))
    const result = await downloadAssets(dossier(), dir)
    expect(result.saved).toHaveLength(0)
    expect(result.skipped[0].reason).toContain('not a decodable image')
    expect(JSON.parse(await readFile(result.creditsFile, 'utf8'))).toEqual([])
  })
  it('uses decoded AVIF dimensions instead of bypassing size requirements', async () => {
    chromium.mockResolvedValue({ width: 100, height: 67, jpeg: Buffer.from('jpegbytes') })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(Buffer.from('0000ftypavif0'))))
    const result = await downloadAssets(dossier(), dir)
    expect(result.saved).toHaveLength(0)
    expect(result.skipped[0].reason).toContain('too small')
  })
  it('preserves provenance and deduplicates decoded assets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(png())))
    const result = await downloadAssets(dossier(['https://example.org/a.png', 'https://example.org/b.png']), dir)
    expect(result.counts).toEqual({ discovered: 2, attempted: 2, downloaded: 2, validated: 2, saved: 1, skipped: 1 })
    expect(result.saved[0]).toMatchObject({ width: 1200, height: 800, pageUrl: 'https://example.org/', kind: 'official', rights: 'Source photo' })
    expect(result.skipped[0].reason).toBe('duplicate')
  })
  it('rejects private redirect destinations before fetching them', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.png' } }))
    vi.stubGlobal('fetch', fetcher)
    const result = await downloadAssets(dossier(), dir)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.saved).toHaveLength(0)
    expect(result.skipped[0].reason).toContain('public')
  })
  it('checks robots permission on redirected image hosts', async () => {
    robots.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/photo.png' } })))
    const result = await downloadAssets(dossier(), dir)
    expect(robots).toHaveBeenLastCalledWith('https://cdn.example.org/photo.png', expect.any(AbortSignal))
    expect(result.skipped[0].reason).toContain('robots.txt')
  })
  it('stops an oversized stream without requiring Content-Length', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)))
    const result = await downloadAssets(dossier(), dir)
    expect(cancel).toHaveBeenCalled()
    expect(result.skipped[0].reason).toBe('larger than 12 MB')
    expect(decode).not.toHaveBeenCalled()
  })
  it('propagates cancellation during a download instead of reporting a skip', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { controller.abort(); throw controller.signal.reason }))
    await expect(downloadAssets(dossier(), dir, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('fails closed when no usable decoder or no positive dimensions are available', async () => {
    decode.mockImplementationOnce(() => { throw new Error('decoder unavailable') })
    expect(await decodeImage(png())).toBeNull()
    decode.mockReturnValueOnce(decoded(0))
    expect(await decodeImage(png())).toBeNull()
    expect(await decodeImage(Buffer.from('<svg width="1200" height="800"><script/></svg>'))).toBeNull()
  })
  it('bounds failed candidate attempts instead of trying an entire large dossier', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetcher)
    const input = dossier(Array.from({ length: 54 }, (_, i) => 'https://example.org/' + i + '.png'))
    const result = await downloadAssets(input, dir, { max: 6 })
    expect(fetcher).toHaveBeenCalledTimes(18)
    expect(result.counts).toEqual({ discovered: 54, attempted: 18, downloaded: 0, validated: 0, saved: 0, skipped: 54 })
    expect(result.skipped[53].reason).toContain('attempt limit')
  })
  it('returns partial results when the overall deadline expires and stops further attempts', async () => {
    const fetcher = vi.fn().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetcher)
    const result = await downloadAssets(dossier(['https://example.org/a.png', 'https://example.org/b.png']), dir, { timeoutMs: 20 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.counts).toMatchObject({ attempted: 1, downloaded: 0, saved: 0, skipped: 2 })
    expect(result.skipped.every(s => s.reason.includes('time budget'))).toBe(true)
  })
  it('updates dossier dimensions from decoded bytes', async () => {
    const input = dossier()
    input.images[0].width = 9000
    input.images[0].height = 9000
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png())))
    await downloadAssets(input, dir)
    expect(input.images[0]).toMatchObject({ width: 1200, height: 800 })
  })

  it('excludes explicitly labelled payment and promotion assets and tries photos before logos', async () => {
    const input = dossier(['https://example.org/logo.png', 'https://example.org/bank.png', 'https://example.org/photo.png', 'https://example.org/promo-service/a.png'])
    input.images[0].role = 'logo'
    input.images[1].role = 'logo'
    input.images[1].alt = 'Bank logo'
    const fetcher = vi.fn().mockImplementation(async () => new Response(png()))
    vi.stubGlobal('fetch', fetcher)
    const result = await downloadAssets(input, dir, { max: 1 })
    expect(result.saved[0].url).toBe('https://example.org/photo.png')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.skipped).toHaveLength(2)
    expect(result.counts).toMatchObject({ discovered: 4, attempted: 1, saved: 1, skipped: 2 })
  })

})
