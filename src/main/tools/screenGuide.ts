/**
 * OWNER: Kiro. The pen overlay: a transparent, click-through window over one
 * display where ZVYRA draws numbered circles, arrows and handwritten labels
 * ("go here → then here → done"). Only the small "Got it" button takes clicks.
 * The drawing itself happens in renderer/guide.html; steps travel in the URL hash.
 */
import { app, BrowserWindow, type Display } from 'electron'
import { join } from 'node:path'
import type { GuideStep } from './screenVision'

let win: BrowserWindow | null = null
let timer: NodeJS.Timeout | null = null

export interface GuideData {
  steps: GuideStep[]
  title?: string
  next?: string
}

export function showGuide(display: Display, data: GuideData) {
  closeGuide()
  const b = display.bounds
  const w = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    alwaysOnTop: true,
    title: 'ZVYRA Guide',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false }
  })
  win = w
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setIgnoreMouseEvents(true, { forward: true })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  const hash = encodeURIComponent(JSON.stringify({ ...data, w: b.width, h: b.height }))
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && dev) void w.loadURL(`${dev}/guide.html#${hash}`)
  else void w.loadFile(join(__dirname, '../renderer/guide.html'), { hash })
  w.once('ready-to-show', () => {
    if (!w.isDestroyed()) {
      w.setBounds(b) // exact display bounds at the current scale
      w.showInactive()
    }
  })
  w.on('closed', () => {
    if (win === w) win = null
  })
  // Stays long enough to follow along, then fades away on its own.
  timer = setTimeout(closeGuide, 20_000 + data.steps.length * 4000)
}

export function closeGuide() {
  if (timer) clearTimeout(timer)
  timer = null
  const w = win
  win = null
  if (w && !w.isDestroyed()) w.destroy()
}

export function guideVisible() {
  return !!win && !win.isDestroyed()
}

/** Click-through everywhere except the "Got it" button (renderer toggles this). */
export function setGuideInteractive(interactive: boolean) {
  if (!win || win.isDestroyed()) return
  if (interactive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

export function isGuideWindow(id: number) {
  return !!win && !win.isDestroyed() && win.webContents.id === id
}
