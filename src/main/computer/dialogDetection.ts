/**
 * Dialog and modal detection for adaptive reasoning and recovery.
 * Identifies blocking prompts, file dialogs, and permission modals.
 */

import type { UiElement, ForegroundInfo } from '../tools/uia'

export interface DialogState {
  isDialog: boolean
  isModal: boolean
  dialogTitle: string
  ownerProcess: string
  buttons: string[]
  hasInput: boolean
  kind: 'file_save' | 'file_open' | 'confirm' | 'error' | 'permission' | 'generic'
}

export const COMMON_DIALOG_CLASSES = new Set(['#32770', 'Dialog', 'Modal', 'bosa_sdlg_MSWord'])

export function inspectDialog(fg: ForegroundInfo | null, controls: UiElement[]): DialogState {
  if (!fg) {
    return { isDialog: false, isModal: false, dialogTitle: '', ownerProcess: '', buttons: [], hasInput: false, kind: 'generic' }
  }

  const title = fg.title.trim()
  const lowerTitle = title.toLowerCase()
  const buttons = controls
    .filter(c => c.type === 'Button' && c.enabled && c.name)
    .map(c => c.name.trim())
  const hasInput = controls.some(c => c.type === 'Edit' && c.enabled)

  const isSaveDialog = /save\s*as|save\s*file/i.test(lowerTitle) || (buttons.some(b => /^save$/i.test(b)) && hasInput)
  const isOpenDialog = /open\s*file|^open$/i.test(lowerTitle) || (buttons.some(b => /^open$/i.test(b)) && hasInput)
  const isConfirmDialog = /do you want to|confirm|warning|alert|are you sure|changes/i.test(lowerTitle) ||
    (buttons.some(b => /^(yes|no|cancel|ok|discard|don't save|save)$/i.test(b)) && !hasInput)
  const isErrorDialog = /error|failed|stopped|unhandled/i.test(lowerTitle)
  const isPermission = /uac|administrator|allow|permission|credentials/i.test(lowerTitle)

  const isDialog = isSaveDialog || isOpenDialog || isConfirmDialog || isErrorDialog || isPermission ||
    /dialog|popup|modal/i.test(lowerTitle) || (buttons.length > 0 && buttons.length <= 4 && controls.length < 25)

  let kind: DialogState['kind'] = 'generic'
  if (isSaveDialog) kind = 'file_save'
  else if (isOpenDialog) kind = 'file_open'
  else if (isConfirmDialog) kind = 'confirm'
  else if (isErrorDialog) kind = 'error'
  else if (isPermission) kind = 'permission'

  return {
    isDialog,
    isModal: isDialog,
    dialogTitle: title,
    ownerProcess: fg.process,
    buttons,
    hasInput,
    kind
  }
}
