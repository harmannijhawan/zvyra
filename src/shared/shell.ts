/**
 * Window-shell contract (UI-owned). These calls manage ZVYRA's own windows
 * (main window, Dynamic Island, tray) and never touch backend services.
 * Transport: 'zvyra:shell' (invoke) and 'zvyra:shell-event' (push).
 * Window geometry is persisted by the shell itself (userData/shell-state.json).
 */

export type IslandMode = 'mini' | 'compact' | 'expanded'

export interface IslandState {
  visible: boolean
  mode: IslandMode
  alwaysOnTop: boolean
  /** Which way the expanded panel grows, chosen from available screen space. */
  expandDirection: 'down' | 'up'
}

export interface MainWindowState {
  visible: boolean
  maximized: boolean
  focused: boolean
}

type M<A, R> = { args: A; result: R }

export interface ShellMethods {
  'island.state': M<void, IslandState>
  'island.setMode': M<{ mode: IslandMode }, IslandState>
  'island.show': M<void, IslandState>
  'island.hide': M<void, IslandState>
  /** Applies settings.island.closeBehavior (hide or minimise). Never quits. */
  'island.close': M<void, IslandState>
  'island.setAlwaysOnTop': M<{ value: boolean }, IslandState>
  'island.resetPosition': M<void, IslandState>
  /** The island window is click-through except over its visible surface. */
  'island.setInteractive': M<{ interactive: boolean }, void>
  /** Custom drag (lets the same surface be clicked and dragged). Window top-left in DIPs. */
  'island.moveTo': M<{ x: number; y: number; done?: boolean }, void>
  'main.show': M<{ route?: string }, MainWindowState>
  'main.state': M<void, MainWindowState>
  'main.minimize': M<void, MainWindowState>
  'main.toggleMaximize': M<void, MainWindowState>
  /** Hides to tray when tray.closeToTray is on, otherwise quits. */
  'main.close': M<void, MainWindowState>
  'app.quit': M<void, void>
  /** Whether the shell is running against the real backend or the preview adapter. */
  'app.backendMode': M<void, { mode: 'real' | 'mock'; reason?: string }>
}

export type ShellMethodName = keyof ShellMethods

export const SHELL_METHOD_NAMES = [
  'island.state', 'island.setMode', 'island.show', 'island.hide', 'island.close', 'island.setAlwaysOnTop',
  'island.resetPosition', 'island.setInteractive', 'island.moveTo', 'main.show', 'main.state', 'main.minimize', 'main.toggleMaximize', 'main.close', 'app.quit',
  'app.backendMode'
] as const satisfies readonly ShellMethodName[]

export interface ShellEventMap {
  'shell.navigate': { route: string }
  'shell.island': IslandState
  'shell.main': MainWindowState
  /** Global shortcut fired; renderers react (e.g. focus input). */
  'shell.shortcut': { action: 'pushToTalk' | 'toggleIsland' | 'stopAll' | 'showMain' }
}

export type ShellEvent = {
  [K in keyof ShellEventMap]: { type: K; payload: ShellEventMap[K] }
}[keyof ShellEventMap]

/**
 * Island window footprint in DIPs. The window keeps the expanded size at all
 * times (transparent + click-through) so every mode change is a pure CSS morph.
 * `compact.height` is the strip the resting pill occupies (used for anchoring).
 */
export const ISLAND_SIZE: Record<IslandMode, { width: number; height: number }> = {
  mini: { width: 520, height: 76 },
  compact: { width: 520, height: 76 },
  expanded: { width: 520, height: 640 }
}
