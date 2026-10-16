import type { InvokeResult, MethodArgs, MethodName, MethodResult, ZvyraEvent } from '../shared/contract'
import type { ShellEvent, ShellMethodName, ShellMethods } from '../shared/shell'

export interface ZvyraBridge {
  /** Contract version the preload was built against. */
  contractVersion: string
  invoke<K extends MethodName>(method: K, args: MethodArgs<K>): Promise<InvokeResult<MethodResult<K>>>
  onEvent(listener: (event: ZvyraEvent) => void): () => void
  shell: {
    invoke<K extends ShellMethodName>(
      method: K,
      args: ShellMethods[K]['args']
    ): Promise<InvokeResult<ShellMethods[K]['result']>>
    onEvent(listener: (event: ShellEvent) => void): () => void
  }
}

declare global {
  interface Window {
    zvyra?: ZvyraBridge
  }
}
