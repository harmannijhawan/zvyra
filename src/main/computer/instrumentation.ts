/**
 * Structured, privacy-conscious performance instrumentation for computer control tasks.
 * Measures understanding, planning, model latency, UI inspection, execution, and verification.
 */

export interface TaskMetrics {
  taskId: string
  taskType: 'fast_path' | 'reasoning' | 'mixed'
  startedAt: number
  endedAt?: number
  totalDurationMs?: number
  taskUnderstandingMs?: number
  planningMs?: number
  modelLatencyMs?: number
  uiInspectionMs?: number
  actionExecutionMs?: number
  verificationMs?: number
  modelCalls: number
  uiInspections: number
  actionsExecuted: number
  recoveries: number
  retries: number
  success: boolean
  terminalReason?: string
  fastPathUsed: boolean
}

// Regex to scrub sensitive values from diagnostics and logs
const SENSITIVE_PATTERN = /\b(password|secret|token|api[_-]?key|bearer|credential|auth)\s*[:=]\s*(\S+)/gi

export function sanitizeLogText(text: string): string {
  if (!text) return ''
  return text.replace(SENSITIVE_PATTERN, '$1=[REDACTED]').slice(0, 1000)
}

export class TaskTelemetry {
  private metrics: TaskMetrics
  private modelCallStart = 0
  private inspectionStart = 0
  private executionStart = 0
  private verificationStart = 0
  private planningStart = 0

  constructor(taskId: string, fastPath = false) {
    this.metrics = {
      taskId,
      taskType: fastPath ? 'fast_path' : 'reasoning',
      startedAt: Date.now(),
      modelCalls: 0,
      uiInspections: 0,
      actionsExecuted: 0,
      recoveries: 0,
      retries: 0,
      success: false,
      fastPathUsed: fastPath,
      modelLatencyMs: 0,
      uiInspectionMs: 0,
      actionExecutionMs: 0,
      verificationMs: 0,
      planningMs: 0,
      taskUnderstandingMs: 0
    }
  }

  setFastPath(used: boolean) {
    this.metrics.fastPathUsed = used
    if (used) this.metrics.taskType = 'fast_path'
  }

  recordUnderstanding(ms: number) {
    this.metrics.taskUnderstandingMs = (this.metrics.taskUnderstandingMs ?? 0) + ms
  }

  startPlanning() {
    this.planningStart = Date.now()
  }

  stopPlanning() {
    if (this.planningStart) {
      this.metrics.planningMs = (this.metrics.planningMs ?? 0) + (Date.now() - this.planningStart)
      this.planningStart = 0
    }
  }

  startModelCall() {
    this.modelCallStart = Date.now()
    this.metrics.modelCalls++
  }

  stopModelCall() {
    if (this.modelCallStart) {
      this.metrics.modelLatencyMs = (this.metrics.modelLatencyMs ?? 0) + (Date.now() - this.modelCallStart)
      this.modelCallStart = 0
    }
  }

  startUiInspection() {
    this.inspectionStart = Date.now()
    this.metrics.uiInspections++
  }

  stopUiInspection() {
    if (this.inspectionStart) {
      this.metrics.uiInspectionMs = (this.metrics.uiInspectionMs ?? 0) + (Date.now() - this.inspectionStart)
      this.inspectionStart = 0
    }
  }

  startActionExecution() {
    this.executionStart = Date.now()
  }

  stopActionExecution(executed = true) {
    if (this.executionStart) {
      this.metrics.actionExecutionMs = (this.metrics.actionExecutionMs ?? 0) + (Date.now() - this.executionStart)
      this.executionStart = 0
    }
    if (executed) this.metrics.actionsExecuted++
  }

  startVerification() {
    this.verificationStart = Date.now()
  }

  stopVerification() {
    if (this.verificationStart) {
      this.metrics.verificationMs = (this.metrics.verificationMs ?? 0) + (Date.now() - this.verificationStart)
      this.verificationStart = 0
    }
  }

  recordRecovery() {
    this.metrics.recoveries++
  }

  recordRetry() {
    this.metrics.retries++
  }

  finish(success: boolean, reason?: string): TaskMetrics {
    this.stopPlanning()
    this.stopModelCall()
    this.stopUiInspection()
    this.stopActionExecution(false)
    this.stopVerification()

    this.metrics.endedAt = Date.now()
    this.metrics.totalDurationMs = this.metrics.endedAt - this.metrics.startedAt
    this.metrics.success = success
    this.metrics.terminalReason = reason ? sanitizeLogText(reason) : success ? 'Task completed successfully' : 'Task failed'
    return { ...this.metrics }
  }

  snapshot(): Readonly<TaskMetrics> {
    return { ...this.metrics }
  }
}
