/**
 * OWNER: Kiro. Reads menus that are published as images (scanned pages,
 * listing-site menu photos) or PDFs.
 *
 *  - downloads each menu document (same robots/size/format rules as photos),
 *  - Windows: local OCR (Windows.Media.Ocr, no key, nothing leaves the PC),
 *    keeping each line's position so a dish and its price stay together,
 *  - optional AI vision transcription when the user's Gemini key is set,
 *    cross-checked against the OCR text when both are available,
 *  - every item keeps the document URL and page number it came from; a price
 *    the scan does not show clearly is recorded as unknown, never guessed.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MenuItem } from './extract'
import { fetchImageBytes, sniffImage } from './assets'

export interface MenuDocument {
  url: string
  /** The page that linked or embedded the document. */
  pageUrl: string
  section?: string
  kind: 'image' | 'pdf'
  official: boolean
  /** 1-based position among the source page's menu documents. */
  page?: number
}

export interface OcrLine {
  text: string
  /** Left / top / right edge and height of the line in image pixels. */
  x: number
  y: number
  x2: number
  h: number
}

export type ReadMenuItem = MenuItem & { document: string; page?: number; crossChecked?: boolean }

/* ---------------------------------------------------------------- OCR line parsing (pure) */

// OCR engines rarely read the rupee sign: it comes out as <, «, ‹, ₹, 2 or a stray 0.
const RUPEE_GLYPH = /^(?:₹|<|«|‹|Rs\.?|INR)$/i
const PRICE_TOKEN = /^(?:(₹|<|«|‹|Rs\.?|INR)\s?)?(\d{1,3}(?:,\d{3})+|\d{1,5})(?:\.(\d{1,2}))?(?:\/-)?$/i

/** Splits trailing price tokens from a menu line. Unclear amounts become `unclear: true`. */
export function splitPrices(text: string, currency = 'INR'): { name: string; prices: number[]; unclear: boolean } {
  // "< 755" and "<755" are the same token; join a lone glyph with the following number.
  const tokens = text.replace(/([₹<«‹])\s+(\d)/g, '$1$2').trim().split(/\s+/)
  const prices: number[] = []
  let unclear = false
  while (tokens.length > 1) {
    const t = tokens[tokens.length - 1].replace(/[.,;:]+$/, '')
    const m = PRICE_TOKEN.exec(t)
    if (!m) break
    const glyph = m[1] ?? ''
    const digits = m[2].replace(/,/g, '')
    if (!glyph) {
      // "Plain/Butter 05", "Laccha Paratha 025": the ₹ was read as a 0, so the amount is unknown.
      if (/^0/.test(digits)) {
        unclear = true
        tokens.pop()
        continue
      }
      // A lone digit is part of the name ("Platter 2"), not a price.
      if (digits.length < 2) break
    } else if (!RUPEE_GLYPH.test(glyph) && currency === 'INR') break
    prices.unshift(Number(m[3] ? `${digits}.${m[3]}` : digits))
    tokens.pop()
  }
  return { name: tokens.join(' ').replace(/[\s.\-–—:|·•]+$/, '').trim(), prices, unclear }
}

const FOOTNOTE = /^\*|subject to change|taxes|gst|service charge|prices (are|listed)|all prices|government|levied|allergen|please inform|chef recommends|veg\b.*non-?veg\b.*symbol/i

/**
 * Turns positioned OCR lines into menu items: larger, price-less lines are
 * section headings, priced lines are dishes, small lines under a dish are its
 * description. The business name and footnotes are skipped.
 */
export function parseOcrMenu(lines: OcrLine[], opts: { businessName?: string; section?: string; currency?: string } = {}): MenuItem[] {
  const clean = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text.length >= 2).sort((a, b) => a.y - b.y || a.x - b.x)
  if (!clean.length) return []
  const priced = clean.filter((l) => splitPrices(l.text, opts.currency).prices.length)
  const heights = (priced.length ? priced : clean).map((l) => l.h).sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)] || 1
  const nameKey = (opts.businessName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const out: MenuItem[] = []
  let section = opts.section
  for (const l of clean) {
    const key = l.text.toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (!key || (nameKey && (key === nameKey || nameKey.includes(key) && key.length > 6)) || /^(restaurant|bar|kitchen|menu|food menu|beverages? menu)$/i.test(l.text)) continue
    if (FOOTNOTE.test(l.text)) continue
    const p = splitPrices(l.text, opts.currency)
    if (!p.prices.length && !p.unclear) {
      if (l.h >= median * 1.15 && l.text.length <= 48 && !/[.,]$/.test(l.text)) {
        section = l.text
        continue
      }
      const last = out[out.length - 1]
      if (last && l.h <= median * 0.88 && l.text.length > 12) {
        last.description = last.description ? `${last.description} ${l.text}` : l.text
        continue
      }
    }
    const name = p.name
    if (!name || name.length < 3 || name.length > 70 || !/[a-z]/i.test(name) || /^\d/.test(name)) continue
    const currency = opts.currency ?? 'INR'
    const sym = currency === 'INR' ? '₹' : `${currency} `
    out.push({
      name,
      price: p.prices.length ? p.prices.map((n) => `${sym}${n}`).join(' / ') : undefined,
      amount: p.prices[0],
      currency: p.prices.length ? currency : undefined,
      section,
      via: 'ocr'
    })
  }
  return out
}

/* ---------------------------------------------------------------- Windows OCR */

const OCR_SCRIPT = String.raw`
param([string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'No Windows OCR language is installed.' }
$res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
$lines = foreach ($l in $res.Lines) {
  $w = @($l.Words); $a = $w[0].BoundingRect; $b = $w[$w.Count - 1].BoundingRect
  $h = ($w | ForEach-Object { $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
  [pscustomobject]@{ text = $l.Text; x = [int]$a.X; y = [int]$a.Y; x2 = [int]($b.X + $b.Width); h = [int]$h }
}
[pscustomobject]@{ width = $bmp.PixelWidth; height = $bmp.PixelHeight; lines = @($lines) } | ConvertTo-Json -Depth 4 -Compress
`

let scriptFile: string | null = null

/** Local OCR with Windows' built-in engine. Throws on other platforms. */
export async function windowsOcr(file: string, signal?: AbortSignal): Promise<{ width: number; height: number; lines: OcrLine[] }> {
  if (process.platform !== 'win32') throw new Error('Local OCR is only available on Windows.')
  if (!scriptFile) {
    const dir = join(tmpdir(), 'zvyra-ocr')
    await mkdir(dir, { recursive: true })
    scriptFile = join(dir, 'ocr.ps1')
    await writeFile(scriptFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(OCR_SCRIPT, 'utf8')]))
  }
  const exe = process.env['SystemRoot'] ? join(process.env['SystemRoot'], 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile!, '-Path', file], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), 60_000)
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new Error('Cancelled'))
      try {
        const j = JSON.parse(out.trim()) as { width: number; height: number; lines: OcrLine[] | OcrLine | null }
        resolve({ width: j.width, height: j.height, lines: Array.isArray(j.lines) ? j.lines : j.lines ? [j.lines] : [] })
      } catch {
        reject(new Error(`OCR failed${code ? ` (exit ${code})` : ''}: ${err.trim().split('\n')[0]?.slice(0, 200) || 'no output'}`))
      }
    })
  })
}

/* ---------------------------------------------------------------- reading documents */

export interface MenuReaderDeps {
  ocr?: (file: string, signal?: AbortSignal) => Promise<{ width: number; height: number; lines: OcrLine[] }>
  /** AI transcription of one menu page (image or PDF bytes). Optional; needs the user's key. */
  vision?: (bytes: Buffer, mimeType: string, signal?: AbortSignal) => Promise<MenuItem[]>
  fetchBytes?: typeof fetchImageBytes
  progress?: (step: string) => void
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Does the OCR text of the same page contain this dish (and its price)? */
function seenInOcr(item: MenuItem, ocrText: string) {
  const words = item.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)
  const hay = ocrText.toLowerCase()
  const nameOk = words.length ? words.filter((w) => hay.includes(w)).length / words.length >= 0.6 : hay.includes(item.name.toLowerCase())
  return nameOk && (item.amount === undefined || norm(ocrText).includes(String(item.amount)))
}

export async function readMenuDocuments(
  docs: MenuDocument[],
  opts: { businessName?: string; currency?: string; maxDocs?: number; keepDir?: string; signal?: AbortSignal },
  deps: MenuReaderDeps = {}
): Promise<{ items: ReadMenuItem[]; read: { url: string; method: string; items: number; local?: string }[]; failed: { url: string; reason: string }[] }> {
  const ocr = deps.ocr ?? (process.platform === 'win32' ? windowsOcr : undefined)
  const getBytes = deps.fetchBytes ?? fetchImageBytes
  const items: ReadMenuItem[] = []
  const read: { url: string; method: string; items: number; local?: string }[] = []
  const failed: { url: string; reason: string }[] = []
  const dir = opts.keepDir ?? join(tmpdir(), 'zvyra-menus')
  await mkdir(dir, { recursive: true })
  for (const [i, doc] of docs.slice(0, Math.max(1, Math.min(24, opts.maxDocs ?? 16))).entries()) {
    opts.signal?.throwIfAborted()
    deps.progress?.(`Reading menu page ${i + 1}/${Math.min(docs.length, opts.maxDocs ?? 16)}`)
    const got = await getBytes(doc.url, opts.signal, doc.kind === 'pdf' ? 'application/pdf' : undefined).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
    if ('error' in got) {
      failed.push({ url: doc.url, reason: got.error })
      continue
    }
    const info = doc.kind === 'image' ? sniffImage(got.buf) : null
    const isPdf = got.buf.subarray(0, 5).toString('latin1') === '%PDF-'
    if (doc.kind === 'image' && (!info || info.type === 'svg')) {
      failed.push({ url: doc.url, reason: 'not a readable image' })
      continue
    }
    if (doc.kind === 'pdf' && !isPdf) {
      failed.push({ url: doc.url, reason: 'not a PDF file' })
      continue
    }
    const ext = isPdf ? 'pdf' : info!.type === 'jpeg' ? 'jpg' : info!.type
    const file = join(dir, `menu-${String(doc.page ?? i + 1).padStart(2, '0')}.${ext}`)
    await writeFile(file, got.buf)
    let ocrText = ''
    let ocrItems: MenuItem[] = []
    if (ocr && !isPdf && ['png', 'jpeg', 'gif', 'webp'].includes(info!.type)) {
      try {
        const r = await ocr(file, opts.signal)
        ocrText = r.lines.map((l) => l.text).join('\n')
        ocrItems = parseOcrMenu(r.lines, { businessName: opts.businessName, section: doc.section, currency: opts.currency })
      } catch (e) {
        opts.signal?.throwIfAborted()
        failed.push({ url: doc.url, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    let visionItems: MenuItem[] = []
    if (deps.vision) {
      try {
        visionItems = (await deps.vision(got.buf, isPdf ? 'application/pdf' : `image/${info!.type}`, opts.signal)).map((m) => ({ ...m, section: m.section ?? doc.section, via: 'vision' as const }))
      } catch (e) {
        opts.signal?.throwIfAborted()
        if (!ocrItems.length) failed.push({ url: doc.url, reason: `AI transcription failed: ${e instanceof Error ? e.message : String(e)}` })
      }
    }
    // Vision reads cleaner text; OCR is an independent reading of the same page to check it against.
    const chosen: ReadMenuItem[] = visionItems.length
      ? visionItems.map((m) => ({ ...m, document: doc.url, page: doc.page, crossChecked: ocrText ? seenInOcr(m, ocrText) : undefined }))
      : ocrItems.map((m) => ({ ...m, document: doc.url, page: doc.page }))
    items.push(...chosen)
    read.push({ url: doc.url, method: visionItems.length ? (ocrText ? 'vision+ocr' : 'vision') : ocrItems.length ? 'ocr' : 'none', items: chosen.length, local: opts.keepDir ? file : undefined })
  }
  return { items, read, failed }
}
