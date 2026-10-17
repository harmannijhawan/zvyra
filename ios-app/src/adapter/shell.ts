/**
 * Browser window-shell adapter for the standalone iOS app.
 *
 * On desktop the shell methods manage real Electron windows (main window,
 * Dynamic Island, tray). On iOS there is a single full-screen WKWebView, so
 * this adapter keeps the same typed contract but reports a sensible fixed
 * state: the main window is always visible, the island is hidden, and window
 * controls (minimise/maximise/close/quit) are no-ops. The UI stays identical;
 * only the behaviour behind the title-bar buttons changes.
 */
import type { InvokeResult } from '@shared/contract'
import type {
  IslandState,
  MainWindowState,
  ShellEvent,
  ShellMethodName,
  ShellMethods
} from '@shared/shell'

const ISLAND_STATE: IslandState = {
  visible: false,
  mode: 'compact',
  alwaysOnTop: false,
  expandDirection: 'down'
}

const MAIN_STATE: MainWindowState = {
  visible: true,
  maximized: true,
  focused: true
}

type ShellHandlers = {
  [K in ShellMethodName]: (args: ShellMethods[K]['args']) => ShellMethods[K]['result']
}

const handlers: ShellHandlers = {
  'island.state': () => ISLAND_STATE,
  'island.setMode': () => ISLAND_STATE,
  'island.show': () => ISLAND_STATE,
  'island.hide': () => ISLAND_STATE,
  'island.close': () => ISLAND_STATE,
  'island.setAlwaysOnTop': () => ISLAND_STATE,
  'island.resetPosition': () => ISLAND_STATE,
  'island.setInteractive': () => undefined,
  'island.moveTo': () => undefined,
  'island.reveal': () => ISLAND_STATE,
  'guide.close': () => undefined,
  'guide.setInteractive': () => undefined,
  'main.show': () => MAIN_STATE,
  'main.state': () => MAIN_STATE,
  'main.minimize': () => MAIN_STATE,
  'main.toggleMaximize': () => MAIN_STATE,
  'main.close': () => MAIN_STATE,
  'app.quit': () => undefined,
  'app.backendMode': () => ({ mode: 'mock', reason: 'Standalone iOS preview build' })
}

export function shellInvoke<K extends ShellMethodName>(
  method: K,
  args: ShellMethods[K]['args']
): Promise<InvokeResult<ShellMethods[K]['result']>> {
  return Promise.resolve()
    .then(() => (handlers[method] as (a: ShellMethods[K]['args']) => ShellMethods[K]['result'])(args))
    .then((result) => ({ ok: true as const, result }))
    .catch((error: unknown) => ({
      ok: false as const,
      error: { code: 'BACKEND_ERROR' as const, message: error instanceof Error ? error.message : String(error) }
    }))
}

/** No shell events are ever pushed on iOS; return an inert unsubscribe. */
export function shellSubscribe(_listener: (event: ShellEvent) => void): () => void {
  void _listener
  return () => undefined
}
