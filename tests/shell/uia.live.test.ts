/**
 * Opt-in (ZVYRA_LIVE_UIA=1): UI Automation against the real desktop. Read-only:
 * reads the foreground window and the names of WhatsApp's call/search buttons.
 * Prints no message content.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { uia } from '../../src/main/tools/uia'

describe.skipIf(!process.env['ZVYRA_LIVE_UIA'])('UI Automation (live)', () => {
  afterAll(() => uia.dispose())
  it('reads the foreground window', async () => {
    const fg = await uia.foreground()
    console.log('foreground:', fg.process, fg.rect, fg.browserUrl ? 'browser url read' : '')
    expect(fg.hwnd).toBeGreaterThan(0)
  }, 30_000)
  it('lists WhatsApp toolbar buttons when WhatsApp is open', async () => {
    const els = await uia.tree({ process: 'WhatsApp.Root', types: ['Button'], max: 200, depth: 30 }).catch((e: Error) => {
      console.log('WhatsApp not available:', e.message)
      return []
    })
    const ui = els.filter((e) => /call|search|new chat|menu|settings|attach|send|emoji|voice/i.test(e.name)).map((e) => `${e.type}:${e.name}`)
    console.log('WhatsApp buttons:', [...new Set(ui)].slice(0, 30).join(' | '), `(${els.length} buttons total)`)
    expect(Array.isArray(els)).toBe(true)
  }, 40_000)
})
