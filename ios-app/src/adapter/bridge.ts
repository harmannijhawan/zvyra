/**
 * Installs `window.zvyra` for the standalone iOS app.
 *
 * The renderer (src/renderer) only ever talks to the backend through
 * `window.zvyra` — the same narrow bridge the Electron preload exposes. Here
 * we build that bridge in-process from the browser-safe IosBackend and the
 * browser shell adapter, so the identical UI runs unchanged inside WKWebView.
 */
import {
  CONTRACT_VERSION,
  METHOD_NAMES,
  type InvokeResult,
  type MethodArgs,
  type MethodName,
  type MethodResult,
  type ZvyraErrorShape,
  type ZvyraEvent
} from '@shared/contract'
import type { ZvyraBridge } from '../../../src/preload/types'
import { IosBackend } from './iosBackend'
import { shellInvoke, shellSubscribe } from './shell'

function toErrorShape(error: unknown): ZvyraErrorShape {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const e = error as { code: ZvyraErrorShape['code']; message: string; fixRoute?: string }
    return { code: e.code, message: e.message, fixRoute: e.fixRoute }
  }
  return { code: 'BACKEND_ERROR', message: error instanceof Error ? error.message : String(error) }
}

export function installBridge(): ZvyraBridge {
  const backend = new IosBackend()
  const methods = new Set<string>(METHOD_NAMES)

  const bridge: ZvyraBridge = {
    contractVersion: CONTRACT_VERSION,
    invoke: async <K extends MethodName>(
      method: K,
      args: MethodArgs<K>
    ): Promise<InvokeResult<MethodResult<K>>> => {
      if (!methods.has(method)) {
        return { ok: false, error: { code: 'INVALID_ARGS', message: `Unknown method: ${method}` } }
      }
      try {
        const result = await backend.invoke(method, args)
        return { ok: true, result }
      } catch (error) {
        return { ok: false, error: toErrorShape(error) }
      }
    },
    onEvent: (listener: (event: ZvyraEvent) => void) => backend.subscribe(listener),
    shell: {
      invoke: shellInvoke,
      onEvent: shellSubscribe
    }
  }

  window.zvyra = bridge
  return bridge
}
