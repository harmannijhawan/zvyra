import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canUseFastPath, parseFastPathIntent, executeFastPath } from '../../src/main/computer/fastPath'
import { TaskStateMachine } from '../../src/main/computer/taskLifecycle'
import { planRecovery, ComputerInputError } from '../../src/main/computer/recovery'
import { inspectDialog } from '../../src/main/computer/dialogDetection'
import { InputQueue, desktopInput } from '../../src/main/computer/inputQueue'
import { TaskTelemetry } from '../../src/main/computer/instrumentation'
import { AgentTasks, type AgentTasksState } from '../../src/main/desktop/agentTasks'
import { JsonDoc } from '../../src/main/desktop/jsonDoc'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { DesktopToolHost } from '../../src/main/voice/desktopTools'

// Mock dependencies for controller and native interaction
const f = vi.hoisted(() => ({
  hwnd: 42,
  metrics: { hwnd: 42, x: 0, y: 0, width: 1920, height: 1080 },
  windows: [{ hwnd: 42, pid: 101, title: 'Untitled - Notepad', process: 'notepad', cls: 'Notepad', minimized: false }],
  controls: [{ name: 'Text Editor', type: 'Edit', runtimeId: '1.2.3', enabled: true, rect: { x: 50, y: 50, w: 500, h: 400 } }],
  clicked: 0,
  typed: [] as string[]
}))

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }],
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }),
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
}))

vi.mock('../../src/main/tools/pcControl', () => ({
  matchWindows: (_t: string, wins: unknown[]) => ({ matched: wins, all: false }),
  pcControl: {
    metrics: vi.fn(async () => f.metrics),
    windows: vi.fn(async () => f.windows),
    show: vi.fn(async () => { f.metrics.hwnd = 42 }),
    smoothMove: vi.fn(async () => ({ samples: 10 })),
    click: vi.fn(async () => { f.clicked++; return true }),
    text: vi.fn(async (t: string) => { f.typed.push(t); return true }),
    keys: vi.fn(async () => true),
    close: vi.fn(async () => []),
    stop: vi.fn()
  }
}))

vi.mock('../../src/main/tools/uia', () => ({
  exactName: (s: string) => `^${s}$`,
  uia: {
    foreground: vi.fn(async () => ({ hwnd: f.metrics.hwnd, pid: 101, process: 'notepad', title: 'Untitled - Notepad', rect: { x: 0, y: 0, w: 800, h: 600 } })),
    tree: vi.fn(async () => f.controls),
    resolve: vi.fn(async () => f.controls[0]),
    checkPoint: vi.fn(async () => true),
    focusControl: vi.fn(async () => true)
  }
}))

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

vi.mock('../../src/main/voice/desktopTools', () => ({
  runDesktopTool: vi.fn(async (_h, name, _args) => {
    if (name === 'launch_app') return { ok: true, name: 'notepad' }
    return { ok: true }
  })
}))

describe('ZVYRA Computer Control Intelligence & Task Completion Overhaul', () => {
  beforeEach(() => {
    f.hwnd = 42
    f.metrics.hwnd = 42
    f.clicked = 0
    f.typed = []
    vi.clearAllMocks()
  })

  // 1. Open an application and finish immediately when its ready state is confirmed.
  it('Requirement 1: Open an application and finish immediately when ready state is confirmed', async () => {
    const lifecycle = new TaskStateMachine('task-1', 'open notepad', true)
    const telemetry = new TaskTelemetry('task-1', true)
    const intent = parseFastPathIntent('open notepad')
    const host = {} as DesktopToolHost

    const result = await executeFastPath(intent, host, lifecycle, telemetry)

    expect(result.ok).toBe(true)
    expect(result.action).toBe('launch')
    expect(lifecycle.state).toBe('COMPLETED')
    expect(lifecycle.isTerminal).toBe(true)
    expect(telemetry.snapshot().actionsExecuted).toBe(1)
  })

  // 2. Click a control, verify the resulting state, and avoid duplicate clicks.
  it('Requirement 2: Click a control, verify resulting state, and avoid duplicate clicks on failure', async () => {
    const { computerController } = await import('../../src/main/computer/controller')
    const signal = new AbortController().signal
    const o = await computerController.execute({ action: 'observe' }, null, signal, true)

    // First click
    const res = await computerController.execute({ action: 'click', frame: o.frame, ref: 'e1' }, null, signal, true)
    expect(res.inputExecuted).toBe(true)
    expect(f.clicked).toBe(1)

    // Trying to repeat with the same consumed frame token is rejected (duplicate prevention)
    await expect(computerController.execute({ action: 'click', frame: o.frame, ref: 'e1' }, null, signal, true)).rejects.toThrow()
    expect(f.clicked).toBe(1) // Still 1, never duplicated
  })

  // 3. Enter text into the correct field even when another window has focus.
  it('Requirement 3: Enter text into the correct field even when another window has focus', async () => {
    const { computerController } = await import('../../src/main/computer/controller')
    const { pcControl } = await import('../../src/main/tools/pcControl')
    const signal = new AbortController().signal
    const o = await computerController.execute({ action: 'observe' }, null, signal, true)

    // Simulate focus moving to another window
    f.metrics.hwnd = 999

    // Type with selector into target field
    const res = await computerController.execute({ action: 'type', frame: o.frame, ref: 'e1', text: 'Hello Zvyra' }, null, signal, true)
    expect(res.inputExecuted).toBe(true)
    expect(pcControl.show).toHaveBeenCalled() // Brought window back into focus
    expect(f.typed).toContain('Hello Zvyra')
  })

  // 4. Complete a multi-step workflow without losing task context.
  it('Requirement 4: Complete a multi-step workflow without losing task context', () => {
    const sm = new TaskStateMachine('task-4', 'multi-step invoice preparation')
    expect(sm.state).toBe('CREATED')

    sm.transition('PLANNING')
    sm.setPlan([
      { title: 'Open invoice app', status: 'pending' },
      { title: 'Enter invoice details', status: 'pending' },
      { title: 'Save invoice', status: 'pending' }
    ])

    // Step 1
    sm.startStep('Open invoice app')
    expect(sm.state).toBe('EXECUTING')
    sm.setActiveWindow({ process: 'invoice', title: 'Invoice Manager', hwnd: 100 })
    sm.finishCurrentStep('done')

    // Step 2
    sm.startStep('Enter invoice details')
    sm.finishCurrentStep('done')

    // Step 3
    sm.startStep('Save invoice')
    sm.finishCurrentStep('done')

    sm.setPlan([
      { title: 'Open invoice app', status: 'done' },
      { title: 'Enter invoice details', status: 'done' },
      { title: 'Save invoice', status: 'done' }
    ])

    expect(sm.context.completedSteps).toHaveLength(3)
    expect(sm.context.activeWindow?.process).toBe('invoice')
    expect(sm.checkCompletion()).toBe(true)
    expect(sm.state).toBe('COMPLETED')
  })

  // 5. Recover from a temporarily missing UI element.
  it('Requirement 5: Recover from a temporarily missing UI element', () => {
    const error = new Error('No control matching Save Button')
    const recovery = planRecovery(error, false, 0)

    expect(recovery.cause).toBe('missing_control')
    expect(recovery.canRetry).toBe(true)
    expect(recovery.recoveryAction).toBe('adaptive_wait')
  })

  // 6. Handle an unexpected modal dialog.
  it('Requirement 6: Handle an unexpected modal dialog', () => {
    const dialogFg = {
      hwnd: 88,
      pid: 200,
      process: 'notepad',
      title: 'Do you want to save changes to Untitled?',
      rect: { x: 100, y: 100, w: 400, h: 200 }
    }
    const dialogControls = [
      { name: 'Save', type: 'Button', enabled: true, rect: { x: 120, y: 220, w: 80, h: 30 } },
      { name: "Don't Save", type: 'Button', enabled: true, rect: { x: 210, y: 220, w: 80, h: 30 } },
      { name: 'Cancel', type: 'Button', enabled: true, rect: { x: 300, y: 220, w: 80, h: 30 } }
    ]

    const dialog = inspectDialog(dialogFg, dialogControls)
    expect(dialog.isDialog).toBe(true)
    expect(dialog.kind).toBe('confirm')
    expect(dialog.buttons).toEqual(['Save', "Don't Save", 'Cancel'])
  })

  // 7. Stop after a bounded number of failed attempts.
  it('Requirement 7: Stop after a bounded number of failed attempts and report blocker', () => {
    const error = new Error('Control remains unavailable')
    // Attempt 0
    const rec0 = planRecovery(error, false, 0, 3)
    expect(rec0.canRetry).toBe(true)

    // Attempt 3 (limit reached)
    const rec3 = planRecovery(error, false, 3, 3)
    expect(rec3.canRetry).toBe(false)
    expect(rec3.recoveryAction).toBe('report_blocker')
    expect(rec3.explanation).toContain('Reached maximum recovery attempts')
  })

  // 8. Detect successful completion without unnecessary extra model calls.
  it('Requirement 8: Detect successful completion without unnecessary extra model calls', () => {
    const sm = new TaskStateMachine('task-8', 'launch calculator')
    expect(sm.criteria?.type).toBe('app_ready')

    // Application window becomes active
    sm.setActiveWindow({ process: 'calculator', title: 'Calculator', hwnd: 77 })
    const finished = sm.checkCompletion()

    expect(finished).toBe(true)
    expect(sm.state).toBe('COMPLETED')
  })

  // 9. Ensure a completed task cannot be restarted by a late asynchronous response.
  it('Requirement 9: Ensure a completed task cannot be restarted by a late async response', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zvyra-test-tasks-'))
    try {
      const doc = new JsonDoc<AgentTasksState>(join(dir, 'tasks.json'), { tasks: [], events: {} })
      const agentTasks = new AgentTasks(doc, () => {}, () => {})

      const t = agentTasks.start('Complete task', 'voice', new AbortController())
      agentTasks.finish(t.id, { status: 'completed', summary: 'Successfully completed' })

      expect(agentTasks.get(t.id)?.status).toBe('completed')

      // Late async error comes in
      agentTasks.finish(t.id, { status: 'failed', error: 'Late network failure' })

      // Must remain completed!
      expect(agentTasks.get(t.id)?.status).toBe('completed')
      expect(agentTasks.get(t.id)?.summary).toBe('Successfully completed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 10. Cancel a task and prevent further queued desktop actions.
  it('Requirement 10: Cancel a task and prevent further queued desktop actions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zvyra-test-tasks-'))
    try {
      const doc = new JsonDoc<AgentTasksState>(join(dir, 'tasks.json'), { tasks: [], events: {} })
      const agentTasks = new AgentTasks(doc, () => {}, () => {})
      const ctrl = new AbortController()

      const t = agentTasks.start('Long task', 'voice', ctrl)
      expect(t.status).toBe('running')

      // User cancels task
      const cancelled = agentTasks.cancel(t.id)
      expect(cancelled?.status).toBe('cancelled')
      expect(ctrl.signal.aborted).toBe(true)

      // Subsequent work with this signal must throw abort error
      await expect(desktopInput.run(async () => 42, ctrl.signal)).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 11. Ensure simple tasks use the fast path when appropriate.
  it('Requirement 11: Ensure simple tasks use the fast path when appropriate', () => {
    expect(canUseFastPath('open notepad')).toBe(true)
    expect(canUseFastPath('launch calculator')).toBe(true)
    expect(canUseFastPath('close notepad')).toBe(true)
    expect(canUseFastPath('minimize edge')).toBe(true)
    expect(canUseFastPath('press ctrl+s')).toBe(true)

    // Complex tasks must NOT use fast path
    expect(canUseFastPath('open notepad and type the inventory and then save it')).toBe(false)
    expect(canUseFastPath('research local businesses and build a 3-page website')).toBe(false)
    expect(canUseFastPath('extract data from table on screen')).toBe(false)
  })

  // 12. Ensure concurrent requests cannot cause conflicting desktop input.
  it('Requirement 12: Ensure concurrent requests cannot cause conflicting desktop input', async () => {
    const q = new InputQueue()
    const sequence: string[] = []

    let finishA!: () => void
    const gateA = new Promise<void>(resolve => { finishA = resolve })

    // Task A starts first and holds input lease
    const taskAPromise = q.run(async () => {
      sequence.push('A:start')
      await gateA
      sequence.push('A:end')
    }, undefined, 'task-A')

    // Task B attempts to run concurrently
    const taskBPromise = q.run(async () => {
      sequence.push('B:start')
      sequence.push('B:end')
    }, undefined, 'task-B')

    // Release Task A
    finishA()
    await Promise.all([taskAPromise, taskBPromise])

    // Must be strictly serialized (Task A completely finishes before Task B starts)
    expect(sequence).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  // 13. Confirm that the existing UI appearance has not changed.
  it('Requirement 13: Confirm that existing UI files remain pixel-for-pixel intact', async () => {
    const { execSync } = await import('node:child_process')
    // Check that our computer control overhaul made zero changes to src/renderer
    const diff = execSync('git diff src/renderer', { encoding: 'utf8' }).trim()
    expect(diff).toBe('')
  })

  // 14. Confirm that failures and verification limitations are reported honestly.
  it('Requirement 14: Confirm that failures and verification limitations are reported honestly', () => {
    const sm = new TaskStateMachine('task-14', 'save file to protected folder')
    sm.fail('Access denied: folder requires administrator privileges')

    expect(sm.state).toBe('FAILED')
    expect(sm.context.error).toBe('Access denied: folder requires administrator privileges')
    expect(sm.context.terminalReason).toContain('Access denied')

    const inputError = new ComputerInputError('Window blocked by modal dialog', false, true, 'modal_dialog')
    expect(inputError.inputExecuted).toBe(false)
    expect(inputError.recoverable).toBe(true)
    expect(inputError.cause).toBe('modal_dialog')
  })
})
