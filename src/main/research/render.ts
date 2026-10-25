/**
 * OWNER: Kiro. Renders a JavaScript-heavy public page in a hidden, sandboxed
 * Chromium window (Electron) and returns the resulting HTML, so menus and
 * listings that are built client-side can be read.
 *
 * Isolation: in-memory session (no cookies kept, nothing shared with the
 * user's browser), no popups, no downloads, no permissions, no file access.
 * The page's own content is returned as data only.
 */
import { BrowserWindow, session } from 'electron'
import { publicUrl, RESEARCH_UA } from './fetcher'

const PARTITION = 'zvyra-research'
let wired = false

function researchSession() {
  const ses = session.fromPartition(PARTITION) // no "persist:" prefix → in-memory
  if (!wired) {
    wired = true
    ses.setUserAgent(RESEARCH_UA)
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (e) => e.preventDefault())
    // Media and fonts aren't needed to read a page.
    ses.webRequest.onBeforeRequest((d, cb) => {
      if (/^(file|chrome|devtools):/i.test(d.url)) return cb({ cancel: true })
      cb({ cancel: d.resourceType === 'media' || d.resourceType === 'font' })
    })
  }
  return ses
}

/**
 * Decodes an image with Chromium's decoders (WebP, AVIF, GIF, JPEG, PNG) in a
 * hidden sandboxed window and re-encodes it as a JPEG no wider than `maxWidth`.
 * Proves the bytes really are a renderable image and yields a universally
 * supported, reasonably sized file. Returns null when Chromium cannot decode it.
 */
export async function imageVariants(buf: Buffer, mime: string, widths: number[]): Promise<{ width: number; height: number; bytes: Buffer }[]> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await win.loadURL('about:blank')
    const result = await Promise.race([
      win.webContents.executeJavaScript(`(async () => {
        const bin = atob(${JSON.stringify(buf.toString('base64'))});
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], {type:${JSON.stringify(mime)}}));
        if (bmp.width * bmp.height > 40000000) { bmp.close(); throw new Error('Image exceeds pixel budget'); }
        const out = [];
        for (const width of ${JSON.stringify(widths)}) {
          if (width > bmp.width || width < 1 || width > 3840) continue;
          const height = Math.max(1, Math.round(bmp.height * width / bmp.width));
          const canvas = new OffscreenCanvas(width, height);
          canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
          const blob = await canvas.convertToBlob({type:'image/webp',quality:.84});
          if (blob.type !== 'image/webp') throw new Error('WebP encoder unavailable');
          const data = new Uint8Array(await blob.arrayBuffer());
          let s = ''; for (let i = 0; i < data.length; i += 32768) s += String.fromCharCode(...data.subarray(i, i + 32768));
          out.push({width,height,data:btoa(s)});
        }
        bmp.close(); return out;
      })()`, true),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Responsive encoding timed out')), 20000) })
    ]) as { width: number; height: number; data: string }[]
    return result.map(v => ({ width: v.width, height: v.height, bytes: Buffer.from(v.data, 'base64') }))
  } finally { if (timer) clearTimeout(timer); if (!win.isDestroyed()) win.destroy() }
}

export async function decodeInChromium(buf: Buffer, mime: string, maxWidth = 3840): Promise<{ width: number; height: number; jpeg: Buffer } | null> {
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { session: researchSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, backgroundThrottling: false } })
  try {
    await win.loadURL('about:blank')
    const js = `(async () => {
      const bin = atob(${JSON.stringify(buf.toString('base64'))}); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: ${JSON.stringify(mime)} }));
      const s = Math.min(1, ${Math.max(64, Math.round(maxWidth))} / bmp.width);
      const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const out = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer());
      let b = ''; for (let i = 0; i < out.length; i += 32768) b += String.fromCharCode.apply(null, out.subarray(i, i + 32768));
      return [bmp.width, bmp.height, btoa(b)];
    })()`
    const [width, height, b64] = (await Promise.race([win.webContents.executeJavaScript(js, true), new Promise((_, rej) => setTimeout(() => rej(new Error('decode timeout')), 20_000))])) as [number, number, string]
    return width > 0 && height > 0 ? { width, height, jpeg: Buffer.from(b64, 'base64') } : null
  } catch {
    return null
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export async function renderPage(raw: string, signal?: AbortSignal, timeoutMs = 25_000): Promise<{ html: string; finalUrl: string; title: string }> {
  const u = publicUrl(raw)
  const win = new BrowserWindow({
    show: false,
    width: 1366,
    height: 900,
    webPreferences: { session: researchSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, images: false, backgroundThrottling: false, webSecurity: true }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    try {
      publicUrl(url)
    } catch {
      e.preventDefault()
    }
  })
  const abort = () => win.destroy()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const load = () => Promise.race([win.loadURL(u.href), new Promise((_, rej) => setTimeout(() => rej(new Error('The page took too long to load')), timeoutMs))])
    await load().catch(async (err: Error) => {
      if (!/ERR_FAILED|ERR_NETWORK_CHANGED/.test(err.message)) throw err
      await new Promise((r) => setTimeout(r, 800))
      await load()
    })
    // Let client-side rendering finish, then scroll to trigger lazy sections.
    await new Promise((r) => setTimeout(r, 1500))
    await win.webContents.executeJavaScript(
      `new Promise(async (done) => { for (let i = 0; i < 8; i++) { window.scrollBy(0, window.innerHeight); await new Promise(r => setTimeout(r, 250)); } window.scrollTo(0, 0); done(true) })`,
      true
    )
    await new Promise((r) => setTimeout(r, 600))
    const [html, title] = (await win.webContents.executeJavaScript('[document.documentElement.outerHTML, document.title]', true)) as [string, string]
    return { html: String(html).slice(0, 4_000_000), finalUrl: win.webContents.getURL(), title: String(title) }
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!win.isDestroyed()) win.destroy()
  }
}
