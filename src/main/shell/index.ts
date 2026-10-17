/**
 * OWNER: Kiro (UI shell).
 * Manages the main window, the Dynamic Island, the tray, global shortcuts and
 * login-item settings. Talks to the backend only through the contract.
 */
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
  type NativeImage
} from 'electron'
import { join } from 'node:path'
import type { AppSettings, VoiceStatus, ZvyraBackend, ZvyraEvent } from '../../shared/contract'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import {
  SHELL_METHOD_NAMES,
  type IslandMode,
  type IslandState,
  type MainWindowState,
  type ShellEvent,
  type ShellMethodName,
  type ShellMethods
} from '../../shared/shell'
import type { ShellLogger } from '../backendContext'
import { broadcast, isTrustedSender, toErrorShape } from '../ipc'
import { renderZIcon } from './iconRaster'
import { dockedBounds } from './islandGeometry'
import { closeGuide, setGuideInteractive } from '../tools/screenGuide'
import { ShellStateStore } from './shellState'
import { runQaCapture } from './qaCapture'

type ShellHandlers = { [K in ShellMethodName]: (args: ShellMethods[K]['args']) => Promise<ShellMethods[K]['result']> | ShellMethods[K]['result'] }

export interface ShellOptions {
  backend: ZvyraBackend
  backendMode: { mode: 'real' | 'mock'; reason?: string }
  logger: ShellLogger
  startHidden: boolean
}

export class Shell {
  private main: BrowserWindow | null = null
  private island: BrowserWindow | null = null
  private tray: Tray | null = null
  private settings: AppSettings = DEFAULT_SETTINGS
  private voice: VoiceStatus | null = null
  private islandMode: IslandMode = 'compact'
  /** The island is docked to the top centre of this display. */
  private islandDisplayId: number | null = null
  private dragging = false
  private pendingPermissions = new Set<string>()
  private hiddenBeforeApproval = false
  private pendingRoute: string | null = null
  private quitting = false
  private readonly store: ShellStateStore
  private readonly iconTray: NativeImage
  private readonly iconApp: NativeImage

  constructor(private readonly opts: ShellOptions) {
    this.store = new ShellStateStore(app.getPath('userData'))
    this.iconTray = nativeImage.createFromBitmap(renderZIcon(32), { width: 32, height: 32, scaleFactor: 2 })
    this.iconApp = nativeImage.createFromBitmap(renderZIcon(256), { width: 256, height: 256 })
  }

  get isQuitting() {
    return this.quitting
  }

  async start() {
    await this.loadSettings()
    this.registerIpc()
    this.opts.backend.subscribe((e) => this.onBackendEvent(e))
    this.createTray()
    this.guardMediaPermissions()
    this.createIsland()
    this.createMain(!this.opts.startHidden && !this.settings.startup.startHidden)
    this.applyShortcuts()
    this.applyLoginItem()
    // Resolution, scaling, taskbar or monitor changes: re-dock at the exact top centre.
    for (const ev of ['display-metrics-changed', 'display-removed', 'display-added'] as const) {
      screen.on(ev as 'display-added', () => this.placeIsland())
    }
    const qaDir = process.env['ZVYRA_QA_CAPTURE']
    if (qaDir && !app.isPackaged) {
      void runQaCapture({
        dir: qaDir,
        main: () => this.main,
        island: () => this.island,
        setIslandMode: (m) => {
          if (!this.island?.isVisible()) this.island?.showInactive()
          this.setIslandMode(m)
        },
        navigate: (route) => this.main?.webContents.send('zvyra:shell-event', { type: 'shell.navigate', payload: { route } }),
        quit: () => this.quit(),
        hideIsland: () => this.hideIsland(),
        inject: (e) => broadcast('zvyra:event', e),
        geometry: () => ({
          displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor })),
          islandDisplay: this.islandDisplay().id,
          island: this.island?.getBounds()
        }),
        exercise:
          process.env['ZVYRA_QA_PROMPT'] || this.opts.backendMode.mode === 'mock'
            ? () =>
                this.opts.backend.invoke('assistant.submit', {
                  text: process.env['ZVYRA_QA_PROMPT'] || 'Delete the old build folders and tidy the project',
                  source: 'island'
                })
            : undefined
      })
    }
  }

  /**
   * Camera access is granted to the Dynamic Island only (video, no microphone —
   * the voice window has its own session). Other permissions keep Electron's
   * previous behaviour.
   */
  private guardMediaPermissions() {
    const isIsland = (wc: Electron.WebContents | null) => !!wc && !!this.island && !this.island.isDestroyed() && wc.id === this.island.webContents.id
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      if (permission !== 'media') return cb(true)
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      cb(isIsland(wc) && types.length > 0 && types.every((t) => t === 'video'))
    })
    session.defaultSession.setPermissionCheckHandler((wc, permission) => (permission === 'media' ? isIsland(wc) : true))
  }

  /** Bring the island forward (without stealing focus) when something needs to be seen, e.g. the camera. */
  private revealIsland() {
    if (!this.island || this.island.isDestroyed()) this.createIsland()
    const win = this.island!
    if (this.islandMode === 'mini') this.setIslandMode('compact', false)
    if (!win.isVisible()) win.showInactive()
    win.setAlwaysOnTop(true, 'floating')
    win.moveTop()
    this.emitIsland()
  }

  /* ------------------------------------------------------------ settings */

  private async loadSettings() {
    try {
      this.settings = await this.opts.backend.invoke('settings.get', undefined)
    } catch (err) {
      this.opts.logger.warn('shell', 'settings.get failed; using defaults', { message: toErrorShape(err).message })
    }
  }

  private onBackendEvent(e: ZvyraEvent) {
    if (e.type === 'settings.changed') {
      const prev = this.settings
      this.settings = e.payload
      if (prev.island.alwaysOnTop !== e.payload.island.alwaysOnTop) this.setAlwaysOnTop(e.payload.island.alwaysOnTop)
      if (prev.island.enabled !== e.payload.island.enabled) (e.payload.island.enabled ? this.showIsland() : this.hideIsland())
      if (JSON.stringify(prev.shortcuts) !== JSON.stringify(e.payload.shortcuts)) this.applyShortcuts()
      if (JSON.stringify(prev.startup) !== JSON.stringify(e.payload.startup)) this.applyLoginItem()
      this.refreshTrayMenu()
    } else if (e.type === 'voice.status') {
      const ACTIVE = ['wake_detected', 'listening', 'transcribing', 'speaking']
      const wasActive = !!this.voice && ACTIVE.includes(this.voice.state)
      this.voice = e.payload
      const active = ACTIVE.includes(e.payload.state)
      if (active && !wasActive) this.onWakeShowIsland()
      else if (!active && wasActive) this.onConversationEnded()
      this.refreshTrayMenu()
    } else if (e.type === 'camera.state' && e.payload.open) {
      this.revealIsland()
    } else if (e.type === 'permission.requested') {
      // Approval popups live in the island: make sure it can be seen, without stealing focus.
      if (!this.pendingPermissions.size) this.hiddenBeforeApproval = !this.island || this.island.isDestroyed() || !this.island.isVisible()
      this.pendingPermissions.add(e.payload.id)
      this.revealIsland()
    } else if (e.type === 'permission.resolved') {
      this.pendingPermissions.delete(e.payload.id)
      if (!this.pendingPermissions.size && this.hiddenBeforeApproval) {
        this.hiddenBeforeApproval = false
        setTimeout(() => {
          if (!this.pendingPermissions.size && !(this.voice && ['wake_detected', 'listening', 'transcribing', 'speaking'].includes(this.voice.state))) this.hideIsland()
        }, 1500)
      }
    } else if (e.type === 'desktop.toast') {
      // Notifications are shown only inside the Dynamic Island (no separate window, no system pop-ups).
      // Problems bring a hidden island back so they aren't missed.
      if (e.payload.kind === 'error' || e.payload.kind === 'denied') this.revealIsland()
    }
    broadcast('zvyra:event', e)
  }

  private hiddenBeforeWake = false
  private miniBeforeWake = false
  private restoreTimer: NodeJS.Timeout | null = null

  /** A conversation started (wake word or push-to-talk): make the island visible wherever it was. */
  private onWakeShowIsland() {
    if (this.restoreTimer) clearTimeout(this.restoreTimer)
    this.restoreTimer = null
    if (!this.island || this.island.isDestroyed()) this.createIsland()
    const win = this.island!
    this.hiddenBeforeWake = !win.isVisible()
    this.miniBeforeWake = this.islandMode === 'mini'
    if (this.miniBeforeWake) this.setIslandMode('compact', false)
    if (!win.isVisible()) win.showInactive()
    win.setAlwaysOnTop(true, 'floating')
    win.moveTop()
    this.emitIsland()
  }

  /** Back to sleep: return the island to how the user left it. */
  private onConversationEnded() {
    if (!this.hiddenBeforeWake && !this.miniBeforeWake) return
    if (this.restoreTimer) clearTimeout(this.restoreTimer)
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null
      if (this.voice && ['wake_detected', 'listening', 'transcribing', 'speaking'].includes(this.voice.state)) return
      if (this.miniBeforeWake) this.setIslandMode('mini', false)
      if (this.hiddenBeforeWake) this.hideIsland()
      if (!this.settings.island.alwaysOnTop) this.island?.setAlwaysOnTop(false)
      this.hiddenBeforeWake = this.miniBeforeWake = false
    }, 3500)
  }

  private applyLoginItem() {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return
    try {
      app.setLoginItemSettings({
        openAtLogin: this.settings.startup.openAtLogin,
        args: this.settings.startup.startHidden ? ['--hidden'] : []
      })
    } catch (err) {
      this.opts.logger.warn('shell', 'setLoginItemSettings failed', { message: String(err) })
    }
  }

  private applyShortcuts() {
    globalShortcut.unregisterAll()
    const s = this.settings.shortcuts
    const bind = (accel: string, action: 'pushToTalk' | 'toggleIsland' | 'stopAll' | 'showMain', fn: () => void) => {
      if (!accel) return
      try {
        if (!globalShortcut.register(accel, () => {
          this.emitShell({ type: 'shell.shortcut', payload: { action } })
          fn()
        })) this.opts.logger.warn('shell', `Shortcut unavailable: ${accel}`)
      } catch {
        this.opts.logger.warn('shell', `Invalid shortcut: ${accel}`)
      }
    }
    bind(s.toggleIsland, 'toggleIsland', () => (this.island?.isVisible() ? this.hideIsland() : this.showIsland()))
    bind(s.showMain, 'showMain', () => this.showMain())
    bind(s.stopAll, 'stopAll', () => void this.opts.backend.invoke('system.stopAll', undefined).catch(() => undefined))
    bind(s.pushToTalk, 'pushToTalk', () => {
      const listening = this.voice?.state === 'listening'

      void this.opts.backend
        .invoke(listening ? 'voice.stopListening' : 'voice.startListening', listening ? undefined : { source: 'island' })
        .catch(() => undefined)
    })
  }

  /* ------------------------------------------------------------ windows */

  private webPreferences() {
    return {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  }

  private load(win: BrowserWindow, page: 'index' | 'island') {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!app.isPackaged && dev) void win.loadURL(`${dev}/${page}.html`)
    else void win.loadFile(join(__dirname, `../renderer/${page}.html`))
  }

  private harden(win: BrowserWindow) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      const dev = process.env['ELECTRON_RENDERER_URL']
      if (!(dev && url.startsWith(dev)) && !url.startsWith('file://')) e.preventDefault()
    })
  }

  private createMain(show: boolean) {
    const saved = this.store.get().main
    const win = new BrowserWindow({
      width: saved?.width ?? 1320,
      height: saved?.height ?? 860,
      x: saved?.x,
      y: saved?.y,
      minWidth: 1000,
      minHeight: 660,
      show: false,
      frame: false,
      // Windows 11 acrylic behind semi-opaque UI layers → real translucent glass.
      backgroundColor: process.platform === 'win32' ? '#00000000' : '#050914',
      backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
      title: 'ZVYRA',
      icon: this.iconApp,
      webPreferences: this.webPreferences()
    })
    this.main = win
    this.harden(win)
    this.load(win, 'index')
    win.once('ready-to-show', () => {
      if (saved?.maximized) win.maximize()
      if (show) win.show()
    })
    win.webContents.on('did-finish-load', () => {
      if (this.pendingRoute) {
        win.webContents.send('zvyra:shell-event', { type: 'shell.navigate', payload: { route: this.pendingRoute } })
        this.pendingRoute = null
      }
    })
    const persist = () => {
      if (win.isDestroyed() || win.isMinimized()) return
      const maximized = win.isMaximized()
      const b = maximized ? (this.store.get().main ?? win.getNormalBounds()) : win.getBounds()
      this.store.update({ main: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
    }
    win.on('resize', persist)
    win.on('move', persist)
    for (const ev of ['maximize', 'unmaximize', 'show', 'hide', 'focus', 'blur'] as const) {
      win.on(ev as 'show', () => this.emitShell({ type: 'shell.main', payload: this.mainState() }))
    }
    win.on('close', (e) => {
      if (this.quitting) return
      if (this.settings.tray.closeToTray) {
        e.preventDefault()
        win.hide()
      } else {
        this.quit()
      }
    })
    win.on('closed', () => {
      this.main = null
    })
  }

  showMain(route?: string) {
    if (!this.main || this.main.isDestroyed()) this.createMain(true)
    const win = this.main!
    if (route) {
      if (win.webContents.isLoading()) this.pendingRoute = route
      else win.webContents.send('zvyra:shell-event', { type: 'shell.navigate', payload: { route } })
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return this.mainState()
  }

  private mainState(): MainWindowState {
    const w = this.main
    return {
      visible: !!w && !w.isDestroyed() && w.isVisible(),
      maximized: !!w && !w.isDestroyed() && w.isMaximized(),
      focused: !!w && !w.isDestroyed() && w.isFocused()
    }
  }

  private createIsland() {
    if (this.island && !this.island.isDestroyed()) return
    const saved = this.store.get().island
    this.islandMode = saved?.mode === 'mini' ? 'mini' : 'compact'
    // Only the chosen display is remembered; the island is always docked to its top centre.
    const display = saved ? screen.getDisplayNearestPoint({ x: Math.round(saved.x), y: Math.round(saved.y) }) : screen.getPrimaryDisplay()
    this.islandDisplayId = display.id
    // Fixed footprint: the window never resizes, the pill morphs inside it.
    const bounds = dockedBounds(display.workArea)
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      thickFrame: false,
      alwaysOnTop: this.settings.island.alwaysOnTop,
      title: 'ZVYRA Island',
      icon: this.iconApp,
      webPreferences: this.webPreferences()
    })
    this.island = win
    if (this.settings.island.alwaysOnTop) win.setAlwaysOnTop(true, 'floating')
    // Click-through everywhere except the visible surface (renderer toggles this).
    win.setIgnoreMouseEvents(true, { forward: true })
    this.harden(win)
    this.load(win, 'island')
    win.once('ready-to-show', () => {
      const visible = saved ? saved.visible !== false : true
      if (this.settings.island.enabled && visible) win.showInactive()
      this.emitIsland()
    })
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault()
        this.hideIsland()
      }
    })
    win.on('closed', () => {
      this.island = null
    })
  }

  /** The display the island is docked to (falls back to primary when it was unplugged). */
  private islandDisplay(): Electron.Display {
    return screen.getAllDisplays().find((d) => d.id === this.islandDisplayId) ?? screen.getPrimaryDisplay()
  }

  private persistIsland() {
    const work = this.islandDisplay().workArea
    this.store.update({
      island: {
        x: work.x + work.width / 2,
        y: work.y,
        mode: this.islandMode === 'expanded' ? 'compact' : this.islandMode,
        visible: !!this.island?.isVisible()
      }
    })
  }

  private islandState(): IslandState {
    return {
      visible: !!this.island && !this.island.isDestroyed() && this.island.isVisible(),
      mode: this.islandMode,
      alwaysOnTop: !!this.island && !this.island.isDestroyed() && this.island.isAlwaysOnTop(),
      expandDirection: 'down'
    }
  }

  private emitIsland() {
    this.emitShell({ type: 'shell.island', payload: this.islandState() })
    this.refreshTrayMenu()
  }

  /** Mode changes are visual only (CSS morph in the renderer); the window keeps its footprint. */
  setIslandMode(mode: IslandMode, focus = true) {
    const win = this.island
    if (!win || win.isDestroyed()) return this.islandState()
    this.islandMode = mode
    if (mode === 'expanded' && focus) {
      win.setIgnoreMouseEvents(false)
      win.focus()
    }
    this.persistIsland()
    this.emitIsland()
    return this.islandState()
  }

  /** Docks the window to the exact top centre of its display (also after scaling/resolution changes). */
  private placeIsland() {
    const win = this.island
    if (!win || win.isDestroyed() || this.dragging) return
    const bounds = dockedBounds(this.islandDisplay().workArea)
    const cur = win.getBounds()
    if (cur.x !== bounds.x || cur.y !== bounds.y || cur.width !== bounds.width || cur.height !== bounds.height) win.setBounds(bounds)
  }

  showIsland() {
    if (!this.island || this.island.isDestroyed()) this.createIsland()
    this.island!.showInactive()
    if (this.settings.island.alwaysOnTop) this.island!.setAlwaysOnTop(true, 'floating')
    this.persistIsland()
    this.emitIsland()
    return this.islandState()
  }

  hideIsland() {
    if (this.islandMode === 'expanded') this.setIslandMode('compact')
    this.island?.hide()
    this.persistIsland()
    this.emitIsland()
    return this.islandState()
  }

  private setAlwaysOnTop(value: boolean) {
    this.island?.setAlwaysOnTop(value, 'floating')
    this.emitIsland()
    return this.islandState()
  }

  /* ------------------------------------------------------------ tray */

  private createTray() {
    this.tray = new Tray(this.iconTray)
    this.tray.setToolTip(this.opts.backendMode.mode === 'mock' ? 'ZVYRA (preview backend)' : 'ZVYRA')
    this.tray.on('click', () => this.showMain())
    this.refreshTrayMenu()
  }

  private refreshTrayMenu() {
    if (!this.tray || this.tray.isDestroyed()) return
    const islandVisible = !!this.island?.isVisible()
    const wake = !!this.voice?.wakeWordEnabled
    const menu = Menu.buildFromTemplate([
      { label: 'Open ZVYRA', click: () => this.showMain() },
      { label: islandVisible ? 'Hide Dynamic Island' : 'Show Dynamic Island', click: () => (islandVisible ? this.hideIsland() : this.showIsland()) },
      { type: 'separator' },
      {
        label: 'Listen for "Hey Zvyra"',
        type: 'checkbox',
        checked: wake,
        enabled: !!this.voice && this.voice.state !== 'unavailable',
        click: () => void this.opts.backend.invoke('voice.setWakeWord', { enabled: !wake }).catch(() => undefined)
      },
      { label: 'Stop all tasks', click: () => void this.opts.backend.invoke('system.stopAll', undefined).catch(() => undefined) },
      { type: 'separator' },
      { label: 'Settings', click: () => this.showMain('settings') },
      { label: 'Quit ZVYRA', click: () => this.quit() }
    ])
    this.tray.setContextMenu(menu)
  }

  /* ------------------------------------------------------------ IPC */

  private emitShell(event: ShellEvent) {
    broadcast('zvyra:shell-event', event)
  }

  private registerIpc() {
    const h: ShellHandlers = {
      'island.state': () => this.islandState(),
      'island.setMode': ({ mode }) => this.setIslandMode(mode),
      'island.show': () => this.showIsland(),
      'island.hide': () => this.hideIsland(),
      'island.close': () => (this.settings.island.closeBehavior === 'minimize' ? this.setIslandMode('mini') : this.hideIsland()),
      'island.setAlwaysOnTop': ({ value }) => {
        void this.opts.backend.invoke('settings.update', { island: { alwaysOnTop: value } }).catch(() => undefined)
        return this.setAlwaysOnTop(value)
      },
      'island.resetPosition': () => {
        this.islandDisplayId = screen.getPrimaryDisplay().id
        this.placeIsland()
        this.persistIsland()
        this.emitIsland()
        return this.islandState()
      },
      // Dragging moves the island to another display; on release it docks to that display's top centre.
      'island.moveTo': ({ x, y, done }) => {
        const win = this.island
        if (!win || win.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return
        const b = win.getBounds()
        if (!done) {
          this.dragging = true
          win.setPosition(Math.round(x), Math.round(y))
          return
        }
        this.dragging = false
        this.islandDisplayId = screen.getDisplayNearestPoint({ x: Math.round(x + b.width / 2), y: Math.round(y + 24) }).id
        this.placeIsland()
        this.persistIsland()
      },
      'island.reveal': () => {
        this.revealIsland()
        return this.islandState()
      },
      'guide.close': () => closeGuide(),
      'guide.setInteractive': ({ interactive }) => setGuideInteractive(!!interactive),
      'island.setInteractive': ({ interactive }) => {
        const win = this.island
        if (!win || win.isDestroyed()) return
        if (interactive) win.setIgnoreMouseEvents(false)
        else win.setIgnoreMouseEvents(true, { forward: true })
      },
      'main.show': ({ route } = {}) => this.showMain(route),
      'main.state': () => this.mainState(),
      'main.minimize': () => {
        this.main?.minimize()
        return this.mainState()
      },
      'main.toggleMaximize': () => {
        if (this.main?.isMaximized()) this.main.unmaximize()
        else this.main?.maximize()
        return this.mainState()
      },
      'main.close': () => {
        this.main?.close()
        return this.mainState()
      },
      'app.quit': () => this.quit(),
      'app.backendMode': () => this.opts.backendMode
    }
    const allowed = new Set<string>(SHELL_METHOD_NAMES)
    ipcMain.handle('zvyra:shell', async (e, method: unknown, args: unknown) => {
      if (!isTrustedSender(e)) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Untrusted sender' } }
      if (typeof method !== 'string' || !allowed.has(method)) {
        return { ok: false, error: { code: 'INVALID_ARGS', message: `Unknown shell method: ${String(method)}` } }
      }
      try {
        const fn = h[method as ShellMethodName] as (a: unknown) => unknown
        return { ok: true, result: await fn(args) }
      } catch (err) {
        return { ok: false, error: toErrorShape(err) }
      }
    })
  }

  /* ------------------------------------------------------------ lifecycle */

  quit() {
    this.quitting = true
    app.quit()
  }

  async shutdown() {
    this.quitting = true
    globalShortcut.unregisterAll()
    await this.store.flush().catch(() => undefined)
    this.tray?.destroy()
  }
}
