/**
 * Diagnostic failure classification and bounded intelligent recovery.
 * Identifies the concrete cause of failures (focus, stale coordinates, missing control, modal dialog, timing)
 * and chooses the smallest appropriate recovery without infinite retry loops.
 */

export type FailureCause =
  | 'focus_lost'
  | 'stale_target'
  | 'missing_control'
  | 'modal_dialog'
  | 'timing'
  | 'permission'
  | 'non_idempotent_executed'
  | 'unknown'

export interface RecoveryPlan {
  cause: FailureCause
  canRetry: boolean
  recoveryAction: 'refocus' | 'refresh_observation' | 'adaptive_wait' | 'handle_modal' | 'report_blocker'
  explanation: string
}

export const isObservationConflict = (error: unknown) =>
  /observe again|re-observ|stale|foreground window changed|focus (?:or displays |changed)|control (?:must|moved|has no)|unknown control ref|accessibility (?:element|traversal)|target is covered/i.test(String(error))

export class ComputerInputError extends Error {
  constructor(
    message: string,
    readonly inputExecuted: boolean | 'unknown',
    readonly recoverable: boolean,
    readonly cause: FailureCause = 'unknown'
  ) {
    super(message)
    this.name = 'ComputerInputError'
  }
}

export function classifyFailure(error: unknown, inputExecuted: boolean | 'unknown'): FailureCause {
  const msg = String(error instanceof Error ? error.message : error).toLowerCase()

  if (inputExecuted === true || inputExecuted === 'unknown') {
    return 'non_idempotent_executed'
  }

  if (/foreground window changed|focus (?:or displays |changed)|intended window could not regain focus/i.test(msg)) {
    return 'focus_lost'
  }

  if (/stale|content moved|target content moved|control moved|frame has been replaced|no active observation/i.test(msg)) {
    return 'stale_target'
  }

  if (/modal|dialog|prompt|blocked by dialog|target is covered/i.test(msg)) {
    return 'modal_dialog'
  }

  if (/not found|no control matching|unknown control ref|has no visible/i.test(msg)) {
    return 'missing_control'
  }

  if (/timed out|did not reach|busy|loading|did not respond in time/i.test(msg)) {
    return 'timing'
  }

  if (/permission|uac|admin|sensitive|approval/i.test(msg)) {
    return 'permission'
  }

  return 'unknown'
}

export function planRecovery(error: unknown, inputExecuted: boolean | 'unknown', attemptCount = 0, maxAttempts = 3): RecoveryPlan {
  const cause = classifyFailure(error, inputExecuted)

  if (attemptCount >= maxAttempts) {
    return {
      cause,
      canRetry: false,
      recoveryAction: 'report_blocker',
      explanation: `Reached maximum recovery attempts (${maxAttempts}). Blocker: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  switch (cause) {
    case 'non_idempotent_executed':
      return {
        cause,
        canRetry: false,
        recoveryAction: 'refresh_observation',
        explanation: 'Input was already delivered or partial. Inspect the UI before taking further actions; do not blindly repeat.'
      }

    case 'focus_lost':
      return {
        cause,
        canRetry: true,
        recoveryAction: 'refocus',
        explanation: 'The target application lost focus. Reactivating target window.'
      }

    case 'stale_target':
      return {
        cause,
        canRetry: true,
        recoveryAction: 'refresh_observation',
        explanation: 'The target control moved or observation expired. Refreshing UI state and relocating target.'
      }

    case 'missing_control':
      return {
        cause,
        canRetry: true,
        recoveryAction: 'adaptive_wait',
        explanation: 'Target control is temporarily not visible. Waiting adaptively for UI to settle.'
      }

    case 'modal_dialog':
      return {
        cause,
        canRetry: true,
        recoveryAction: 'handle_modal',
        explanation: 'An unexpected modal or dialog appeared over the target. Inspecting dialog options.'
      }

    case 'timing':
      return {
        cause,
        canRetry: true,
        recoveryAction: 'adaptive_wait',
        explanation: 'Application is still responding. Giving it additional time to settle.'
      }

    case 'permission':
      return {
        cause,
        canRetry: false,
        recoveryAction: 'report_blocker',
        explanation: 'Action requires user permission or security approval.'
      }

    default:
      return {
        cause: 'unknown',
        canRetry: attemptCount < 2,
        recoveryAction: attemptCount < 2 ? 'refresh_observation' : 'report_blocker',
        explanation: String(error instanceof Error ? error.message : error)
      }
  }
}
