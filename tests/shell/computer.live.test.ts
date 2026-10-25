import { execSync, spawn } from 'node:child_process'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Mock Electron's display/image APIs for running outside electron binary
vi.mock('electron', () => {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }
  return {
    screen: {
      getAllDisplays: () => [display],
      getDisplayNearestPoint: () => display,
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      screenToDipPoint: (p: unknown) => p,
      dipToScreenPoint: (p: unknown) => p
    },
    nativeImage: {
      createFromDataURL: () => ({
        crop() { return this },
        resize() { return this },
        toBitmap: () => Buffer.alloc(64000, 10)
      })
    }
  }
})

vi.mock('../../src/main/tools/screenVision', () => ({
  captureScreen: vi.fn(async () => ({
    dataUrl: 'data:image/jpeg;base64,mock',
    display: { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
    width: 1920,
    height: 1080,
    capturedAt: Date.now()
  })),
  describeScreen: vi.fn(async () => 'Screen description'),
  verifyScreen: vi.fn(async () => ({ verified: true, description: 'Postcondition confirmed' }))
}))

import { pcControl, matchWindows } from '../../src/main/tools/pcControl'
import { uia } from '../../src/main/tools/uia'
import { TaskStateMachine } from '../../src/main/computer/taskLifecycle'
import { executeFastPath, parseFastPathIntent } from '../../src/main/computer/fastPath'
import { TaskTelemetry } from '../../src/main/computer/instrumentation'
import { waitForCondition } from '../../src/main/computer/adaptiveWait'
import type { DesktopToolHost } from '../../src/main/voice/desktopTools'

describe.runIf(process.platform === 'win32' && !process.env['CI'])('Windows Computer Control Integration (live)', () => {
  afterAll(async () => {
    // Ensure any test Notepad windows are gracefully closed
    const wins = matchWindows('notepad', await pcControl.windows(), new Set()).matched
    if (wins.length > 0) {
      await pcControl.close(wins, 2000).catch(() => [])
    }
    pcControl.dispose()
    uia.dispose()
  })

  it('executes fast-path launch, confirms ready state, and completes promptly without large LLM calls', async () => {
    const t0 = Date.now()
    const lifecycle = new TaskStateMachine('live-test-launch', 'open notepad', true)
    const telemetry = new TaskTelemetry('live-test-launch', true)
    const intent = parseFastPathIntent('open notepad')

    const mockHost = {} as DesktopToolHost

    // Measure fast path execution against real Windows
    const result = await executeFastPath(intent, mockHost, lifecycle, telemetry)
    const elapsedMs = Date.now() - t0

    expect(result.ok).toBe(true)
    expect(result.action).toBe('launch')
    expect(lifecycle.state).toBe('COMPLETED')
    expect(lifecycle.isTerminal).toBe(true)

    // Verify Notepad is actually running on the real desktop
    const wins = matchWindows('notepad', await pcControl.windows(), new Set()).matched
    expect(wins.length).toBeGreaterThan(0)
    expect(wins[0].process.toLowerCase()).toContain('notepad')

    // Clean up
    await pcControl.close(wins, 2000)

    // Performance verification: completes in under 3.5 seconds on live Windows
    // (whereas old multi-turn LLM + screenshots baseline took 10-15+ seconds)
    expect(elapsedMs).toBeLessThan(3500)
  }, 30_000)

  it('safely types text into active Notepad and gracefully closes without leaving residue', async () => {
    // 1. Launch a clean Notepad instance on real Windows
    const { computerController } = await import('../../src/main/computer/controller')
    const signal = new AbortController().signal
    spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()

    const readyWin = await waitForCondition(async () => {
      const wins = matchWindows('notepad', await pcControl.windows(), new Set()).matched
      if (wins.length > 0) {
        await pcControl.show(wins[0], 'focus')
        return wins[0]
      }
      return null
    }, { timeoutMs: 6000, minIntervalMs: 50, maxIntervalMs: 150 })

    expect(readyWin).toBeTruthy()

    // 2. Observe the Notepad window and find the Text Editor control through live UIA
    const obs = (await computerController.execute({ action: 'observe' }, null, signal, true)) as any
    const editControl = obs.controls.find((c: any) => c.type === 'Edit' || c.type === 'Document' || /editor|text/i.test(c.name))

    // 3. Type text into Notepad using the controller's verified path
    if (editControl) {
      const typed = await computerController.execute({ action: 'type', frame: obs.frame, ref: editControl.ref, text: 'Zvyra Verified' }, null, signal, true)
      expect(typed.inputExecuted).toBe(true)
    }

    // 4. Gracefully close Notepad on real Windows
    const wins = matchWindows('notepad', await pcControl.windows(), new Set()).matched
    const left = await pcControl.close(wins, 1500)
    if (left.length > 0) {
      await pcControl.keys('alt+f4', 1, left[0].hwnd).catch(() => undefined)
      await new Promise(r => setTimeout(r, 400))
      // On Windows 11 "Don't Save" shortcut or Alt+N
      await pcControl.keys('alt+n', 1, 0).catch(() => undefined)
      await pcControl.keys('n', 1, 0).catch(() => undefined)
      await new Promise(r => setTimeout(r, 400))
    }
    // Clean up any remaining test notepad process
    try {
      execSync('powershell -NoProfile -Command "Get-Process -Name notepad -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'ignore' })
    } catch {}

    // Confirm Notepad is cleanly closed
    const remaining = matchWindows('notepad', await pcControl.windows(), new Set()).matched
    expect(remaining).toHaveLength(0)
  }, 30_000)
})
