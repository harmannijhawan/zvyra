/**
 * What the shell hands to the backend at boot (SHARED).
 * The backend must not create or own windows; it may parent native dialogs
 * to `getFocusedWindow()`.
 */
import type { BrowserWindow } from 'electron'

export interface ShellLogger {
  debug(scope: string, message: string, data?: Record<string, unknown>): void
  info(scope: string, message: string, data?: Record<string, unknown>): void
  warn(scope: string, message: string, data?: Record<string, unknown>): void
  error(scope: string, message: string, data?: Record<string, unknown>): void
}

export interface BackendContext {
  userDataPath: string
  appVersion: string
  isPackaged: boolean
  /** Absolute path of bundled resources (resources/ in dev, process.resourcesPath when packaged). */
  resourcesPath: string
  getFocusedWindow(): BrowserWindow | null
  logger: ShellLogger
}
