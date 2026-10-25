/**
 * OWNER: Kiro. Image acquisition for generated websites.
 *
 *  - downloads only images found on pages the research step was allowed to read
 *    (robots.txt is checked again for the image host),
 *  - validates image bytes with the runtime decoder, size limits, duplicates,
 *  - writes assets/images/* plus assets/CREDITS.json with the original URL,
 *    the page it came from, the retrieval time and a rights note,
 *  - optional openly-licensed stock (Openverse) is labelled as stock, never as
 *    the business's own photos.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Dossier } from './dossier'
import { publicUrl, RESEARCH_UA, robotsAllows } from './fetcher'

export interface ImageInfo {
  type: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'avif'
  width: number
  height: number
}

/** Reads the image type and pixel size from the file header (no decoding). */
export function sniffImage(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') return { type: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++
        continue
      }
      const marker = b[o + 1]
      const len = b.readUInt16BE(o + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) }
      o += 2 + len
    }
    return null
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16)
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
    if (chunk === 'VP8 ') return { type: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  if (b.length >= 12 && b.toString('ascii', 4, 12) === 'ftypavif') return { type: 'avif', width: 0, height: 0 }
  const head = b.subarray(0, 4000).toString('utf8')
  if (/<svg[\s>]/i.test(head)) {
    const tag = /<svg[^>]*>/i.exec(head)?.[0] ?? ''
    const num = (k: string) => Number(new RegExp(`\\b${k}="([\\d.]+)(px)?"`).exec(tag)?.[1] ?? NaN)
    const vb = /viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/.exec(tag)
    const w = num('width') || Number(vb?.[1] ?? 0)
    const h = num('height') || Number(vb?.[2] ?? 0)
    // Scripts inside SVG are not acceptable assets.
    if (/<script|onload=|javascript:/i.test(b.toString('utf8'))) return null
    return { type: 'svg', width: Math.round(w) || 0, height: Math.round(h) || 0 }
  }
  return null
}

export interface SavedAsset {
  file: string
  relative: string
  url: string
  pageUrl: string
  retrievedAt: string
  width: number
  height: number
  bytes: number
  role: string
  alt?: string
  kind: 'official' | 'third-party' | 'stock'
  rights: string
  attribution?: string
  license?: string
  variants?: { relative: string; width: number; height: number; type: string; bytes: number }[]
  srcset?: string
  variantError?: string
}

const MAX_BYTES = 12 * 1024 * 1024

/** Header sniffing identifies format only; a real decoder must accept the bytes. */
export async function decodeImage(buf: Buffer): Promise<ImageInfo | null> {
  return (await prepareImage(buf))?.info ?? null
}

/** Largest width written into a website's assets folder (bigger photos are scaled down). */
export const MAX_ASSET_WIDTH = 3840

export function responsiveWidths(width: number): number[] {
  return [...new Set([480, 768, 1280, 1920, 2560, MAX_ASSET_WIDTH, width].filter(w => w <= width && w <= MAX_ASSET_WIDTH))].sort((a, b) => a - b)
}

async function saveVariants(project: string, relative: string, prepared: { info: ImageInfo; buf: Buffer }): Promise<Pick<SavedAsset, 'variants' | 'srcset' | 'variantError'>> {
  try {
    const { imageVariants } = await import('./render')
    const outputs = await imageVariants(prepared.buf, `image/${prepared.info.type}`, responsiveWidths(prepared.info.width))
    const variants: NonNullable<SavedAsset['variants']> = []
    for (const output of outputs) {
      const path = relative.replace(/\.[^.]+$/, `-${output.width}.webp`)
      await writeFile(join(project, path), output.bytes)
      variants.push({ relative: path, width: output.width, height: output.height, type: 'image/webp', bytes: output.bytes.length })
    }
    return { variants, srcset: variants.map(v => `${v.relative} ${v.width}w`).join(', ') }
  } catch (error) {
    return { variantError: `Responsive encoding unavailable; use the validated original: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Decodes the bytes with a real decoder and returns web-ready bytes:
 * JPEG/PNG through Electron's decoder (scaled down when very large), WebP/AVIF/GIF
 * through Chromium (re-encoded as JPEG). Null = not a renderable image.
 */
export async function prepareImage(buf: Buffer): Promise<{ info: ImageInfo; buf: Buffer; ext: string } | null> {
  const header = sniffImage(buf)
  if (!header || header.type === 'svg' || header.width * header.height > 40_000_000) return null
  try {
    if (header.type === 'png' || header.type === 'jpeg') {
      const { nativeImage } = await import('electron')
      const decoded = nativeImage.createFromBuffer(buf)
      if (decoded.isEmpty()) return null
      const { width, height } = decoded.getSize()
      if (width <= 0 || height <= 0 || width * height > 40_000_000 || !decoded.toBitmap().length) return null
      if (width > MAX_ASSET_WIDTH) {
        const small = decoded.resize({ width: MAX_ASSET_WIDTH, quality: 'best' })
        const s = small.getSize()
        return header.type === 'png'
          ? { info: { type: 'png', width: s.width, height: s.height }, buf: small.toPNG(), ext: 'png' }
          : { info: { type: 'jpeg', width: s.width, height: s.height }, buf: small.toJPEG(84), ext: 'jpg' }
      }
      return { info: { type: header.type, width, height }, buf, ext: header.type === 'jpeg' ? 'jpg' : 'png' }
    }
    const { decodeInChromium } = await import('./render')
    const mime = `image/${header.type}`
    const r = await decodeInChromium(buf, mime, MAX_ASSET_WIDTH)
    if (!r) return null
    if (r.width <= MAX_ASSET_WIDTH && (header.type === 'webp' || header.type === 'avif'))
      return { info: { type: header.type, width: r.width, height: r.height }, buf, ext: header.type }
    return { info: { type: 'jpeg', width: r.width > MAX_ASSET_WIDTH ? MAX_ASSET_WIDTH : r.width, height: r.width > MAX_ASSET_WIDTH ? Math.round((r.height * MAX_ASSET_WIDTH) / r.width) : r.height }, buf: r.jpeg, ext: 'jpg' }
  } catch {
    return null
  }
}

/** Downloads a public image (or, with `pdf`, a PDF) with the same robots, redirect and size rules as photos. */
export function fetchImageBytes(url: string, signal?: AbortSignal, accept?: 'application/pdf') {
  return getImage(url, signal, accept)
}

// JPEG/PNG first: CDNs negotiate formats, and JPEG/PNG decode everywhere (WebP/AVIF need Chromium).
const IMAGE_ACCEPT = 'image/jpeg,image/png;q=0.9,image/webp;q=0.6,image/*;q=0.5'

async function getImage(url: string, signal?: AbortSignal, accept?: 'application/pdf'): Promise<{ buf: Buffer; type: string } | { error: string }> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  try {
    let current = publicUrl(url).href
    for (let redirects = 0; redirects <= 5; redirects++) {
      requestSignal.throwIfAborted()
      if (!(await robotsAllows(current, requestSignal))) return { error: 'robots.txt disallows this image' }
      requestSignal.throwIfAborted()
      const r = await fetch(current, { headers: { 'User-Agent': RESEARCH_UA, Accept: accept ? `${accept},*/*;q=0.5` : IMAGE_ACCEPT }, redirect: 'manual', signal: requestSignal })
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        await r.body?.cancel()
        const location = r.headers.get('location')
        if (!location) return { error: 'redirect without a destination' }
        const target = new URL(location, current)
        if (!/^https?:$/.test(target.protocol)) return { error: 'unsupported image redirect protocol' }
        current = publicUrl(target.href).href
        continue
      }
      if (!r.ok) { await r.body?.cancel(); return { error: 'HTTP ' + r.status } }
      const type = r.headers.get('content-type') ?? ''
      if (type && !/^image\//i.test(type) && !(accept && /pdf|octet-stream/i.test(type))) { await r.body?.cancel(); return { error: 'not an image (' + type + ')' } }
      const len = Number(r.headers.get('content-length') ?? 0)
      if (len > MAX_BYTES) { await r.body?.cancel(); return { error: 'larger than 12 MB' } }
      if (!r.body) return { error: 'empty image response' }
      const reader = r.body.getReader()
      const chunks: Buffer[] = []
      let bytes = 0
      try {
        while (true) {
          requestSignal.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MAX_BYTES) { await reader.cancel(); return { error: 'larger than 12 MB' } }
          chunks.push(Buffer.from(value))
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        throw error
      } finally { reader.releaseLock() }
      requestSignal.throwIfAborted()
      return { buf: Buffer.concat(chunks, bytes), type }
    }
    return { error: 'too many image redirects' }
  } catch (e) {
    signal?.throwIfAborted()
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image'

/**
 * Downloads the dossier's best images into <projectDir>/assets/images and
 * records credits. Images below `minWidth` are skipped (logos may be smaller).
 */
export async function downloadAssets(
  dossier: Dossier,
  projectDir: string,
  opts: { max?: number; minWidth?: number; maxAttempts?: number; timeoutMs?: number; signal?: AbortSignal; progress?: (s: string) => void } = {}
): Promise<{ saved: SavedAsset[]; skipped: { url: string; reason: string }[]; creditsFile: string; counts: { discovered: number; attempted: number; downloaded: number; validated: number; saved: number; skipped: number } }> {
  const max = Math.max(1, Math.min(40, opts.max ?? 16))
  const maxAttempts = Math.max(1, Math.min(40, opts.maxAttempts ?? max * 3))
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(90_000, opts.timeoutMs ?? 90_000)))
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
  const counts = { discovered: dossier.images.length, attempted: 0, downloaded: 0, validated: 0, saved: 0, skipped: 0 }
  const minWidth = opts.minWidth ?? 480
  const dir = join(projectDir, 'assets', 'images')
  await mkdir(dir, { recursive: true })
  const saved: SavedAsset[] = []
  const skipped: { url: string; reason: string }[] = []
  const hashes = new Set<string>()
  // Use explicit asset labels and paths, never infer visual relevance from guessed content.
  const irrelevant = (image: Dossier['images'][number]) => /\b(?:bank logo|payment (?:logo|icon)|credit card|debit card|app store|google play|advertisement|ad banner)\b/i.test(image.alt ?? '') || /\/(?:promo-service|ads|advertisements)\//i.test(image.url)
  const candidates = dossier.images.filter((image) => {
    const reason = irrelevant(image) ? 'payment, promotion or app-store asset excluded' : image.role === 'icon' && dossier.images.length >= 4 ? 'icon excluded from photo candidates' : null
    if (reason) skipped.push({ url: image.url, reason })
    return !reason
  }).sort((a, b) => Number(a.role === 'logo' || a.role === 'icon') - Number(b.role === 'logo' || b.role === 'icon'))
  // The same photo is often listed resized ("x.jpg?width=818") and original ("x.jpg"): keep one, the original.
  const byPath = new Map<string, Dossier['images'][number]>()
  for (const image of candidates) {
    const key = image.url.split(/[?#]/)[0].toLowerCase()
    const cur = byPath.get(key)
    if (!cur) byPath.set(key, image)
    else {
      if (!image.url.includes('?') && cur.url.includes('?')) byPath.set(key, { ...image, role: cur.role === 'og' ? 'og' : image.role })
      skipped.push({ url: image.url.includes('?') ? image.url : cur.url, reason: 'same photo at another size' })
    }
  }
  candidates.splice(0, candidates.length, ...byPath.values())
  for (const img of candidates) {
    if (saved.length >= max) break
    opts.signal?.throwIfAborted()
    if (counts.attempted >= maxAttempts || deadline.aborted) {
      const reason = deadline.aborted ? 'asset acquisition time budget exhausted' : 'asset acquisition attempt limit reached'
      for (const remaining of candidates.slice(candidates.indexOf(img))) skipped.push({ url: remaining.url, reason })
      break
    }
    counts.attempted++
    opts.progress?.(`Downloading image candidate ${counts.attempted}/${Math.min(candidates.length, maxAttempts)}`)
    const got = await getImage(img.url, signal).catch((error: unknown) => {
      opts.signal?.throwIfAborted()
      if (deadline.aborted) return { error: 'asset acquisition time budget exhausted' }
      throw error
    })
    if ('error' in got) {
      skipped.push({ url: img.url, reason: got.error })
      continue
    }
    counts.downloaded++
    const prepared = await prepareImage(got.buf)
    opts.signal?.throwIfAborted()
    if (!prepared) {
      skipped.push({ url: img.url, reason: `not a decodable image (${sniffImage(got.buf)?.type ?? got.type ?? 'unknown format'})` })
      continue
    }
    const info = prepared.info
    counts.validated++
    img.width = info.width
    img.height = info.height
    const isLogo = img.role === 'logo' || img.role === 'icon'
    if (info.width < (isLogo ? 64 : minWidth)) {
      skipped.push({ url: img.url, reason: `too small (${info.width}×${info.height})` })
      continue
    }
    const hash = createHash('sha1').update(got.buf).digest('hex')
    if (hashes.has(hash)) {
      skipped.push({ url: img.url, reason: 'duplicate' })
      continue
    }
    hashes.add(hash)
    const name = `${isLogo ? 'logo' : slug(img.alt ?? img.role)}-${hash.slice(0, 12)}.${prepared.ext}`
    const file = join(dir, name)
    await writeFile(file, prepared.buf)
    img.local = `assets/images/${name}`
    saved.push({
      file,
      relative: `assets/images/${name}`,
      url: img.url,
      pageUrl: img.pageUrl,
      retrievedAt: new Date().toISOString(),
      width: info.width,
      height: info.height,
      bytes: prepared.buf.length,
      role: img.role,
      alt: img.alt,
      kind: img.official ? 'official' : 'third-party',
      rights: img.rights
    })
    Object.assign(saved[saved.length - 1], await saveVariants(projectDir, img.local, prepared))
  }
  opts.signal?.throwIfAborted()
  const creditsFile = await writeCredits(projectDir, saved)
  return { saved, skipped, creditsFile, counts: { ...counts, saved: saved.length, skipped: skipped.length } }
}

async function writeCredits(projectDir: string, add: SavedAsset[]) {
  const creditsFile = join(projectDir, 'assets', 'CREDITS.json')
  let prev: SavedAsset[] = []
  try {
    prev = JSON.parse(await readFile(creditsFile, 'utf8')) as SavedAsset[]
  } catch {
    /* first write */
  }
  const merged = [...prev.filter((p) => !add.some((a) => a.relative === p.relative)), ...add].map((a) => ({ ...a, file: undefined }))
  await mkdir(join(projectDir, 'assets'), { recursive: true })
  await writeFile(creditsFile, JSON.stringify(merged, null, 2), 'utf8')
  return creditsFile
}

/**
 * Openly licensed stock photos from Openverse (no key). Always labelled
 * "stock" with creator + licence; never to be presented as the business's own.
 */
export async function downloadStock(query: string, projectDir: string, opts: { count?: number; signal?: AbortSignal } = {}): Promise<{ saved: SavedAsset[]; skipped: { url: string; reason: string }[]; creditsFile: string; counts: { saved: number; skipped: number } }> {
  const count = Math.max(1, Math.min(12, opts.count ?? 4))
  const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial,modification&page_size=${count * 3}&mature=false`
  const r = await fetch(api, { headers: { 'User-Agent': 'ZVYRA/0.4 (+https://zvyra.org)' }, signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`Openverse answered HTTP ${r.status}`)
  const j = (await r.json()) as { results?: { url: string; title?: string; creator?: string; license: string; license_version?: string; license_url?: string; foreign_landing_url?: string; width?: number; height?: number; attribution?: string }[] }
  const dir = join(projectDir, 'assets', 'images')
  await mkdir(dir, { recursive: true })
  const saved: SavedAsset[] = []
  const skipped: { url: string; reason: string }[] = []
  for (const item of j.results ?? []) {
    if (saved.length >= count) break
    opts.signal?.throwIfAborted()
    if ((item.width ?? 0) && (item.width ?? 0) < 800) continue
    const got = await getImage(item.url, opts.signal)
    if ('error' in got) {
      skipped.push({ url: item.url, reason: got.error })
      continue
    }
    const prepared = await prepareImage(got.buf)
    const info = prepared?.info
    opts.signal?.throwIfAborted()
    if (!prepared || !info || info.width < 800) {
      skipped.push({ url: item.url, reason: info ? `too small (${info.width}px)` : 'not a valid image' })
      continue
    }
    const name = `stock-${slug(query)}-${createHash('sha256').update(got.buf).digest('hex').slice(0, 12)}.${prepared.ext}`
    await writeFile(join(dir, name), prepared.buf)
    const license = `${item.license.toUpperCase()}${item.license_version ? ` ${item.license_version}` : ''}`
    saved.push({
      file: join(dir, name),
      relative: `assets/images/${name}`,
      url: item.url,
      pageUrl: item.foreign_landing_url ?? item.url,
      retrievedAt: new Date().toISOString(),
      width: info.width,
      height: info.height,
      bytes: prepared.buf.length,
      role: 'content',
      alt: item.title,
      kind: 'stock',
      license,
      attribution: item.attribution ?? `“${item.title ?? 'Photo'}” by ${item.creator ?? 'unknown'} (${license})`,
      rights: `Openly licensed stock photo (${license}${item.license_url ? `, ${item.license_url}` : ''}). Credit the author on the site. Generic imagery: do not present it as this business's own product or premises.`
    })
    Object.assign(saved[saved.length - 1], await saveVariants(projectDir, `assets/images/${name}`, prepared))
  }
  opts.signal?.throwIfAborted()
  const creditsFile = await writeCredits(projectDir, saved)
  return { saved, skipped, creditsFile, counts: { saved: saved.length, skipped: skipped.length } }
}
