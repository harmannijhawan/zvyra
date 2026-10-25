/**
 * Authoritative process-wide desktop input queue and coordination lock.
 * Ensures single-threaded, strictly serialized desktop input across TextAgent,
 * voice sessions, and direct computer control. Prevents overlapping actions from
 * competing for mouse, keyboard, or active window.
 */

export class InputQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private epoch = new AbortController()
  private depth = 0
  private version = 0
  private activeOwner: string | null = null
  private leaseControllers = new Map<string, AbortController>()

  get revision() { return this.version }
  get activeTaskId() { return this.activeOwner }
  get signal() { return this.epoch.signal }

  invalidate() { this.version++ }

  stop() {
    this.invalidate()
    this.activeOwner = null
    for (const ctrl of this.leaseControllers.values()) {
      ctrl.abort(new Error('Computer control stopped'))
    }
    this.leaseControllers.clear()
    this.epoch.abort(new Error('Computer control stopped'))
    this.epoch = new AbortController()
  }

  cancelTask(taskId: string) {
    const ctrl = this.leaseControllers.get(taskId)
    if (ctrl) {
      ctrl.abort(new Error(`Task ${taskId} cancelled`))
      this.leaseControllers.delete(taskId)
    }
    if (this.activeOwner === taskId) {
      this.activeOwner = null
      this.invalidate()
    }
  }

  /**
   * Acquire exclusive execution lease for a high-level task.
   */
  async acquireLease(taskId: string, signal?: AbortSignal): Promise<() => void> {
    const combined = AbortSignal.any([this.epoch.signal, ...(signal ? [signal] : [])])
    combined.throwIfAborted()

    const taskCtrl = new AbortController()
    this.leaseControllers.set(taskId, taskCtrl)

    const leaseSignal = AbortSignal.any([combined, taskCtrl.signal])

    // Wait until current queue tail is resolved
    await this.run(async () => {
      leaseSignal.throwIfAborted()
      this.activeOwner = taskId
    }, leaseSignal)

    return () => {
      if (this.activeOwner === taskId) {
        this.activeOwner = null
      }
      this.leaseControllers.delete(taskId)
    }
  }

  async run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, ownerId?: string): Promise<T> {
    if (this.depth >= 32) throw new Error('Computer action queue is full')
    const combined = AbortSignal.any([this.epoch.signal, ...(signal ? [signal] : [])])
    combined.throwIfAborted()
    this.depth++

    const result = this.tail.then(async () => {
      combined.throwIfAborted()
      const previousOwner = this.activeOwner
      if (ownerId) this.activeOwner = ownerId
      try {
        return await work(combined)
      } finally {
        if (ownerId && this.activeOwner === ownerId) {
          this.activeOwner = previousOwner
        }
      }
    })

    this.tail = result.catch(() => undefined)
    try {
      return await result
    } finally {
      this.depth--
    }
  }
}

// Explicit process-wide registry: avoids two independent input locks in ui.cjs and main/index.js.
const registry = globalThis as typeof globalThis & { __zvyraInputQueue?: InputQueue }
export const desktopInput = registry.__zvyraInputQueue ??= new InputQueue()
