/**
 * Typed renderer client for the shared contract. Everything the UI does goes
 * through `call()` / `onEvent()`; there is no other path to the backend.
 */
import type { ErrorCode, MethodArgs, MethodName, MethodResult, ZvyraErrorShape, ZvyraEvent } from '@shared/contract'
import type { ShellEvent, ShellMethodName, ShellMethods } from '@shared/shell'

export class ClientError extends Error {
  code: ErrorCode
  fixRoute?: string
  constructor(shape: ZvyraErrorShape) {
    super(shape.message)
    this.code = shape.code
    this.fixRoute = shape.fixRoute
  }
}

const bridge = () => window.zvyra

export const hasBridge = () => !!bridge()

export async function call<K extends MethodName>(method: K, ...args: MethodArgs<K> extends void ? [] : [MethodArgs<K>]): Promise<MethodResult<K>> {
  const b = bridge()
  if (!b) throw new ClientError({ code: 'UNAVAILABLE', message: 'ZVYRA bridge is not available in this window.' })
  const res = await b.invoke(method, args[0] as MethodArgs<K>)
  if (!res.ok) throw new ClientError(res.error)
  return res.result
}

export async function shellCall<K extends ShellMethodName>(method: K, ...args: ShellMethods[K]['args'] extends void ? [] : [ShellMethods[K]['args']]): Promise<ShellMethods[K]['result']> {
  const b = bridge()
  if (!b) throw new ClientError({ code: 'UNAVAILABLE', message: 'Window shell is not available.' })
  const res = await b.shell.invoke(method, args[0] as ShellMethods[K]['args'])
  if (!res.ok) throw new ClientError(res.error)
  return res.result
}

export function onEvent(listener: (e: ZvyraEvent) => void): () => void {
  return bridge()?.onEvent(listener) ?? (() => undefined)
}

export function onShellEvent(listener: (e: ShellEvent) => void): () => void {
  return bridge()?.shell.onEvent(listener) ?? (() => undefined)
}

export function errorMessage(err: unknown): string {
  if (err instanceof ClientError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export function errorCode(err: unknown): ErrorCode | undefined {
  return err instanceof ClientError ? err.code : undefined
}
