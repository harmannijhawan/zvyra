/**
 * OWNER: Kiro. Loads a built web page in a hidden, sandboxed window and reports
 * real problems: console errors, missing files, failed requests, plus a
 * screenshot the agent can look at to judge the design.
 */
import { BrowserWindow, session } from 'electron'
import { pathToFileURL } from 'node:url'

export interface SiteReport {
  ok: boolean
  title: string
  consoleErrors: string[]
  failedRequests: string[]
  textSample: string
  screenshotJpegBase64?: string
}

let wired = false
const failures = new Map<number, string[]>()

export async function checkSite(entry: string, width = 1366, height = 860): Promise<SiteReport> {
  const ses = session.fromPartition('zvyra-site-check')
  if (!wired) {
    wired = true
    ses.webRequest.onErrorOccurred((d) => {
      const list = failures.get(d.webContentsId ?? -1)
      if (list && !d.url.startsWith('data:') && !/ERR_ABORTED/.test(d.error)) list.push(`${d.error} ${d.url}`)
    })
    ses.webRequest.onCompleted((d) => {
      const list = failures.get(d.webContentsId ?? -1)
      if (list && d.statusCode >= 400) list.push(`HTTP ${d.statusCode} ${d.url}`)
    })
  }
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { partition: 'zvyra-site-check', sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: false, backgroundThrottling: false }
  })
  const id = win.webContents.id
  failures.set(id, [])
  const consoleErrors: string[] = []
  win.webContents.on('console-message', (...args: unknown[]) => {
    const e = args[0] as { level?: string | number; message?: string; lineNumber?: number; sourceId?: string }
    const level = e?.level ?? args[1]
    const message = e?.message ?? (args[2] as string)
    if (level === 'error' || level === 3) consoleErrors.push(String(message).slice(0, 300))
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    const url = /^https?:/i.test(entry) ? entry : pathToFileURL(entry).href
    await Promise.race([win.loadURL(url), new Promise((_, rej) => setTimeout(() => rej(new Error('Page took longer than 20 s to load')), 20_000))])
    await new Promise((r) => setTimeout(r, 1500)) // let scripts render
    const [title, textSample] = (await win.webContents.executeJavaScript(
      `[document.title, (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 1500)]`,
      true
    )) as [string, string]
    const img = await win.webContents.capturePage()
    const small = img.getSize().width > 1280 ? img.resize({ width: 1280 }) : img
    const failed = failures.get(id) ?? []
    return {
      ok: consoleErrors.length === 0 && failed.length === 0,
      title,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 20),
      failedRequests: [...new Set(failed)].slice(0, 20),
      textSample,
      screenshotJpegBase64: small.toJPEG(72).toString('base64')
    }
  } finally {
    failures.delete(id)
    win.destroy()
  }
}
