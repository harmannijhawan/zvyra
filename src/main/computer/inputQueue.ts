/** Shared by the separately bundled desktop and SWARM runtimes in one Electron process. */
export class InputQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private epoch = new AbortController()
  private depth = 0
  private version = 0
  get revision() { return this.version }
  invalidate() { this.version++ }
  get signal() { return this.epoch.signal }
  stop() { this.invalidate(); this.epoch.abort(new Error('Computer control stopped')); this.epoch = new AbortController() }
  async run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.depth >= 32) throw new Error('Computer action queue is full')
    const combined = AbortSignal.any([this.epoch.signal, ...(signal ? [signal] : [])])
    combined.throwIfAborted()
    this.depth++
    const result = this.tail.then(async () => { combined.throwIfAborted(); return work(combined) })
    this.tail = result.catch(() => undefined)
    try { return await result } finally { this.depth-- }
  }
}
// Explicit process-wide registry: avoids two independent input locks in ui.cjs and main/index.js.
const registry = globalThis as typeof globalThis & { __zvyraInputQueue?: InputQueue }
export const desktopInput = registry.__zvyraInputQueue ??= new InputQueue()
