/** OWNER: Kiro. Small persisted JSON document with atomic, debounced writes. */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class JsonDoc<T extends object> {
  private value: T
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    defaults: T
  ) {
    try {
      this.value = { ...defaults, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<T>) }
    } catch {
      this.value = { ...defaults }
    }
  }

  get(): T {
    return this.value
  }

  set(update: Partial<T> | ((v: T) => Partial<T>)) {
    const patch = typeof update === 'function' ? update(this.value) : update
    this.value = { ...this.value, ...patch }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 250)
    return this.value
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const data = JSON.stringify(this.value, null, 2)
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, data)
      await rename(tmp, this.file)
    }).catch(() => undefined)
    return this.writing
  }
}
