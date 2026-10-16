/**
 * ZVYRA main entry (SHARED — keep to boot order only).
 * 1. single-instance lock  2. backend (real or preview)  3. contract IPC  4. shell
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { ZvyraBackend } from '../shared/contract'
import { createBackend } from './backend'
import type { BackendContext } from './backendContext'
import { registerContractIpc } from './ipc'
import { createLogger } from './logger'
import { MockBackend } from './mock/mockBackend'
import { withDesktopServices } from './desktop'
import { Shell } from './shell'

app.setAppUserModelId('ai.zvyra.desktop')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let shell: Shell | null = null
  let backend: ZvyraBackend | null = null
  const logger = createLogger(join(app.getPath('userData'), 'logs'))

  app.on('second-instance', () => shell?.showMain())

  app.whenReady().then(async () => {
    const forceMock = process.argv.includes('--mock-backend')
    const ctx: BackendContext = {
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      resourcesPath: app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'),
      getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
      logger
    }
    let mode: { mode: 'real' | 'mock'; reason?: string } = { mode: 'real' }
    if (!forceMock) {
      try {
        backend = await createBackend(ctx)
      } catch (err) {
        logger.error('boot', 'Backend failed to start', { message: err instanceof Error ? err.message : String(err) })
        mode = { mode: 'mock', reason: `Backend failed to start: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    if (!backend) {
      if (mode.mode === 'real') mode = { mode: 'mock', reason: forceMock ? 'Started with --mock-backend' : 'No backend registered in src/main/backend' }
      backend = new MockBackend()
      logger.warn('boot', 'Running with the preview backend', { reason: mode.reason })
    }
    // Real engine gets the desktop-services layer (files, terminal, apps, calls, schedules…).
    if (mode.mode === 'real') backend = withDesktopServices(backend, ctx)
    const active = backend
    registerContractIpc(() => active, logger)
    shell = new Shell({ backend: active, backendMode: mode, logger, startHidden: process.argv.includes('--hidden') })
    await shell.start()
  })

  // Tray app: keep running when all windows are hidden or closed.
  app.on('window-all-closed', () => {
    if (shell?.isQuitting) app.quit()
  })

  let shuttingDown = false
  app.on('before-quit', (e) => {
    if (shuttingDown) return
    shuttingDown = true
    e.preventDefault()
    void (async () => {
      await shell?.shutdown()
      await backend?.dispose?.().catch(() => undefined)
      app.exit(0)
    })()
  })
}
