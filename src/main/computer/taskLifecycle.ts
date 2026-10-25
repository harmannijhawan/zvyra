/**
 * Explicit Task Lifecycle & State Machine for ZVYRA Computer Control.
 * Enforces explicit completion criteria, terminal state protection, and structured context retention.
 */

import { randomUUID } from 'node:crypto'
import type { TaskStatus, ComputerPhase } from '../../shared/contract'

export type TaskLifecycleState =
  | 'CREATED'
  | 'PLANNING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'RECOVERING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface TaskSuccessCriteria {
  type: 'app_ready' | 'window_closed' | 'window_state' | 'text_entered' | 'file_saved' | 'milestones_complete' | 'custom'
  targetApp?: string
  expectedWindow?: string
  expectedText?: string
  expectedValue?: string
  description: string
  isSatisfied?: (state: TaskContext) => boolean
}

export interface TaskStepRecord {
  id: string
  action: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  timestamp: number
  resultNote?: string
}

export interface TaskContext {
  taskId: string
  instruction: string
  state: TaskLifecycleState
  successCriteria?: TaskSuccessCriteria
  activeHwnd?: number
  activeWindow?: { process: string; title: string; hwnd: number }
  completedSteps: TaskStepRecord[]
  currentStep?: TaskStepRecord
  planMilestones: { title: string; status: string }[]
  retries: number
  recoveries: number
  terminalReason?: string
  error?: string
  createdAt: number
  updatedAt: number
  finishedAt?: number
  isFastPath: boolean
}

const TERMINAL_STATES = new Set<TaskLifecycleState>(['COMPLETED', 'FAILED', 'CANCELLED'])

export class TaskStateMachine {
  private ctx: TaskContext
  private listeners = new Set<(state: TaskLifecycleState, ctx: Readonly<TaskContext>) => void>()

  constructor(taskId: string, instruction: string, isFastPath = false, criteria?: TaskSuccessCriteria) {
    const now = Date.now()
    this.ctx = {
      taskId: taskId || `task-${randomUUID()}`,
      instruction,
      state: 'CREATED',
      successCriteria: criteria ?? deriveSuccessCriteria(instruction),
      completedSteps: [],
      planMilestones: [],
      retries: 0,
      recoveries: 0,
      createdAt: now,
      updatedAt: now,
      isFastPath
    }
  }

  get id() { return this.ctx.taskId }
  get state() { return this.ctx.state }
  get isTerminal() { return TERMINAL_STATES.has(this.ctx.state) }
  get context(): Readonly<TaskContext> { return this.ctx }
  get criteria() { return this.ctx.successCriteria }

  subscribe(fn: (state: TaskLifecycleState, ctx: Readonly<TaskContext>) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    this.ctx.updatedAt = Date.now()
    for (const fn of this.listeners) {
      try { fn(this.ctx.state, this.ctx) } catch { /* ignore listener error */ }
    }
  }

  transition(to: TaskLifecycleState, note?: string): boolean {
    if (this.isTerminal) {
      // Terminal states are locked and immutable. Late async responses cannot restart or overwrite!
      return false
    }

    if (this.ctx.state === to) return true

    // Check valid transitions
    const from = this.ctx.state
    const valid =
      (from === 'CREATED' && ['PLANNING', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(to)) ||
      (from === 'PLANNING' && ['EXECUTING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(to)) ||
      (from === 'EXECUTING' && ['VERIFYING', 'RECOVERING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(to)) ||
      (from === 'VERIFYING' && ['COMPLETED', 'EXECUTING', 'PLANNING', 'RECOVERING', 'FAILED', 'CANCELLED'].includes(to)) ||
      (from === 'RECOVERING' && ['PLANNING', 'EXECUTING', 'VERIFYING', 'FAILED', 'CANCELLED'].includes(to))

    if (!valid) return false

    this.ctx.state = to
    if (note) this.ctx.terminalReason = note
    if (TERMINAL_STATES.has(to)) {
      this.ctx.finishedAt = Date.now()
    }
    this.notify()
    return true
  }

  setSuccessCriteria(criteria: TaskSuccessCriteria) {
    if (this.isTerminal) return
    this.ctx.successCriteria = criteria
  }

  setActiveWindow(win: { process: string; title: string; hwnd: number }) {
    if (this.isTerminal) return
    this.ctx.activeHwnd = win.hwnd
    this.ctx.activeWindow = win
    this.ctx.updatedAt = Date.now()
  }

  setPlan(milestones: { title: string; status: string }[]) {
    if (this.isTerminal) return
    this.ctx.planMilestones = milestones
    this.ctx.updatedAt = Date.now()
  }

  startStep(actionDescription: string): TaskStepRecord {
    const step: TaskStepRecord = {
      id: randomUUID(),
      action: actionDescription,
      status: 'running',
      timestamp: Date.now()
    }
    this.ctx.currentStep = step
    this.transition('EXECUTING', actionDescription)
    return step
  }

  finishCurrentStep(status: 'done' | 'failed' | 'skipped', note?: string) {
    if (!this.ctx.currentStep) return
    const s = this.ctx.currentStep
    s.status = status
    s.resultNote = note
    this.ctx.completedSteps.push(s)
    this.ctx.currentStep = undefined
    this.ctx.updatedAt = Date.now()
  }

  recordRetry() {
    if (this.isTerminal) return
    this.ctx.retries++
    this.transition('RECOVERING', `Retry attempt ${this.ctx.retries}`)
  }

  recordRecovery(reason: string) {
    if (this.isTerminal) return
    this.ctx.recoveries++
    this.transition('RECOVERING', reason)
  }

  /**
   * Evaluates if success criteria have been satisfied.
   */
  checkCompletion(): boolean {
    if (this.isTerminal) return this.ctx.state === 'COMPLETED'
    const crit = this.ctx.successCriteria
    if (!crit) return false

    if (crit.isSatisfied && crit.isSatisfied(this.ctx)) {
      this.complete(`Success condition satisfied: ${crit.description}`)
      return true
    }

    if (crit.type === 'app_ready' && crit.targetApp) {
      if (this.ctx.activeWindow && isAppMatch(this.ctx.activeWindow, crit.targetApp)) {
        this.complete(`Application ${crit.targetApp} is active and ready`)
        return true
      }
    }

    if (crit.type === 'milestones_complete' && this.ctx.planMilestones.length > 0) {
      const allDone = this.ctx.planMilestones.every(m => m.status === 'done' || m.status === 'skipped')
      if (allDone) {
        this.complete('All plan milestones successfully finished')
        return true
      }
    }

    return false
  }

  complete(summary = 'Task completed successfully'): boolean {
    if (this.isTerminal) return false
    if (this.ctx.currentStep) {
      this.finishCurrentStep('done', summary)
    }
    this.ctx.terminalReason = summary
    return this.transition('COMPLETED', summary)
  }

  fail(error: string): boolean {
    if (this.isTerminal) return false
    if (this.ctx.currentStep) {
      this.finishCurrentStep('failed', error)
    }
    this.ctx.error = error
    this.ctx.terminalReason = error
    return this.transition('FAILED', error)
  }

  cancel(reason = 'Task cancelled'): boolean {
    if (this.isTerminal) return false
    if (this.ctx.currentStep) {
      this.finishCurrentStep('skipped', reason)
    }
    this.ctx.terminalReason = reason
    return this.transition('CANCELLED', reason)
  }

  /**
   * Maps current state to contract TaskStatus
   */
  toTaskStatus(): TaskStatus {
    switch (this.ctx.state) {
      case 'CREATED': return 'queued'
      case 'PLANNING': return 'planning'
      case 'EXECUTING': return 'running'
      case 'VERIFYING': return 'verifying'
      case 'RECOVERING': return 'running'
      case 'COMPLETED': return 'completed'
      case 'FAILED': return 'failed'
      case 'CANCELLED': return 'cancelled'
    }
  }

  /**
   * Maps current state to contract ComputerPhase
   */
  toComputerPhase(): ComputerPhase {
    switch (this.ctx.state) {
      case 'CREATED': return 'idle'
      case 'PLANNING': return 'planning'
      case 'EXECUTING': return 'executing'
      case 'VERIFYING': return 'verifying'
      case 'RECOVERING': return 'observing'
      case 'COMPLETED': return 'completed'
      case 'FAILED': return 'failed'
      case 'CANCELLED': return 'idle'
    }
  }
}

function isAppMatch(activeWin: { process: string; title: string }, targetApp: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\.exe$/, '').trim()
  const p = norm(activeWin.process)
  const t = norm(activeWin.title)
  const target = norm(targetApp)
  return p === target || p.includes(target) || t.includes(target)
}

/**
 * Derives explicit completion criteria from natural language instructions.
 */
export function deriveSuccessCriteria(instruction: string): TaskSuccessCriteria {
  const text = instruction.toLowerCase().trim()

  const launchMatch = /^(?:open|launch|start)\s+([a-z0-9 _-]+?)(?:\s+and\s+.*|\s*\.|\s*$)/i.exec(text)
  if (launchMatch) {
    const app = launchMatch[1].trim()
    return {
      type: 'app_ready',
      targetApp: app,
      description: `${app} window is open and ready`
    }
  }

  const closeMatch = /^(?:close|exit|quit)\s+([a-z0-9 _-]+?)(?:\s*\.|\s*$)/i.exec(text)
  if (closeMatch) {
    const app = closeMatch[1].trim()
    return {
      type: 'window_closed',
      targetApp: app,
      description: `${app} is closed`
    }
  }

  const windowStateMatch = /^(?:minimize|maximize|restore)\s+([a-z0-9 _-]+?)(?:\s*\.|\s*$)/i.exec(text)
  if (windowStateMatch) {
    return {
      type: 'window_state',
      description: `Window state updated for ${windowStateMatch[1].trim()}`
    }
  }

  const saveMatch = /\bsave\b/i.test(text)
  if (saveMatch) {
    return {
      type: 'file_saved',
      description: 'Document or file is saved'
    }
  }

  return {
    type: 'milestones_complete',
    description: 'All requested actions and milestones completed'
  }
}
