import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: {}, shell: {}, app: { getAppMetrics: () => [] }, desktopCapturer: {}, screen: {}, BrowserWindow: class {} }))
const { isScreenRequest } = await import('../../src/main/voice/extraTools')

describe('screen requests never use the webcam', () => {
  it('treats screen, window and page questions as screen requests', () => {
    for (const q of ['see my screen', "what's on my screen", 'look at this window', 'read this page', 'what does this error message mean', 'check my monitor', 'what is this app']) expect(isScreenRequest(q), q).toBe(true)
  })
  it('keeps real camera requests on the camera', () => {
    for (const q of ['what am I holding', 'how do I look', 'open my webcam', 'look through the camera at my screen']) expect(isScreenRequest(q), q).toBe(false)
  })
})
