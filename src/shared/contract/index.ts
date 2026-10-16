/**
 * ZVYRA shared integration contract — entry point.
 * See docs/CONTRACT.md for ownership rules, transport and changelog.
 */
export * from './types'
export * from './methods'
export * from './events'

import type { MethodArgs, MethodName, MethodResult } from './methods'
import type { ZvyraEvent } from './events'

export const CONTRACT_VERSION = '1.3.0'

export type ErrorCode =
  | 'NOT_IMPLEMENTED' // backend has not built this yet
  | 'NOT_CONFIGURED' // needs credentials / setup (UI shows setup path)
  | 'UNAVAILABLE' // dependency missing (no mic, no engine, offline)
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_ARGS'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'BACKEND_ERROR'

export interface ZvyraErrorShape {
  code: ErrorCode
  message: string
  /** Optional settings route to fix the problem, e.g. "settings/swarm". */
  fixRoute?: string
}

/** IPC envelope. Errors never travel as thrown exceptions across IPC. */
export type InvokeResult<T> = { ok: true; result: T } | { ok: false; error: ZvyraErrorShape }

/** Implemented by the backend (Astra) in the main process. */
export interface ZvyraBackend {
  invoke<K extends MethodName>(method: K, args: MethodArgs<K>): Promise<MethodResult<K>>
  subscribe(listener: (event: ZvyraEvent) => void): () => void
  /** Called once before the app quits. */
  dispose?(): Promise<void>
}

/** Error class backends may throw; main converts it into the envelope. */
export class ZvyraError extends Error implements ZvyraErrorShape {
  constructor(
    public code: ErrorCode,
    message: string,
    public fixRoute?: string
  ) {
    super(message)
    this.name = 'ZvyraError'
  }
}
