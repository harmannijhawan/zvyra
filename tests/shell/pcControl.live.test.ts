import { spawn } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { matchWindows, PcControl } from '../../src/main/tools/pcControl'

// Real Windows check: opens Notepad, finds it, closes it like clicking X.
const pc = new PcControl()
afterAll(() => pc.dispose())

describe.runIf(process.platform === 'win32' && !process.env['CI'])('PC control (live)', () => {
  it('lists windows and closes Notepad quickly', async () => {
    const before = matchWindows('notepad', await pc.windows(), new Set()).matched.map((w) => w.hwnd)
    spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
    let mine: Awaited<ReturnType<PcControl['windows']>> = []
    for (let i = 0; i < 40 && !mine.length; i++) {
      await new Promise((r) => setTimeout(r, 250))
      mine = matchWindows('notepad', await pc.windows(), new Set()).matched.filter((w) => !before.includes(w.hwnd))
    }
    expect(mine.length).toBeGreaterThan(0)
    const t0 = Date.now()
    const left = await pc.close(mine)
    expect(left).toHaveLength(0)
    expect(Date.now() - t0).toBeLessThan(3000)
  }, 60_000)
})
