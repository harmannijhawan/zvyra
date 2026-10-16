import { describe, expect, it } from 'vitest'
import { matchWindows, parseKeys, type WinInfo } from '../../src/main/tools/pcControl'

let n = 1
const w = (process: string, title: string, cls = 'Window', pid = 100): WinInfo => ({ hwnd: n++, pid, process, title, cls, minimized: false })
const wins: WinInfo[] = [
  w('notepad', 'notes.txt - Notepad', 'Notepad', 1),
  w('chrome', 'YouTube - Google Chrome', 'Chrome_WidgetWin_1', 2),
  w('msedge', 'News - Microsoft Edge', 'Chrome_WidgetWin_1', 3),
  w('explorer', 'Downloads', 'CabinetWClass', 4),
  w('explorer', 'Program Manager', 'Progman', 4),
  w('explorer', 'Taskbar', 'Shell_TrayWnd', 4),
  w('WINWORD', 'Budget report - Word', 'OpusApp', 5),
  w('ZVYRA', 'ZVYRA', 'Chrome_WidgetWin_1', 99),
  w('dwm', 'DWM', 'Dwm', 6)
]
const self = new Set([99])
const names = (r: { matched: WinInfo[] }) => r.matched.map((x) => x.process).sort()

describe('window matching', () => {
  it('closes notepad by name', () => {
    expect(names(matchWindows('notepad', wins, self))).toEqual(['notepad'])
    expect(names(matchWindows('Notepad.exe', wins, self))).toEqual(['notepad'])
  })
  it('“all tabs” / “browser” means every browser window', () => {
    expect(names(matchWindows('all tabs', wins, self))).toEqual(['chrome', 'msedge'])
    expect(names(matchWindows('browser', wins, self))).toEqual(['chrome', 'msedge'])
  })
  it('File Explorer means folder windows only, never the desktop or taskbar', () => {
    expect(matchWindows('file explorer', wins, self).matched.map((x) => x.cls)).toEqual(['CabinetWClass'])
  })
  it('“all apps” never includes ZVYRA, the shell or system processes', () => {
    const r = matchWindows('all apps', wins, self)
    expect(r.all).toBe(true)
    expect(names(r)).toEqual(['WINWORD', 'chrome', 'explorer', 'msedge', 'notepad'])
    expect(r.matched.some((x) => x.cls === 'Progman' || x.cls === 'Shell_TrayWnd')).toBe(false)
  })
  it('matches friendly names and window titles', () => {
    expect(names(matchWindows('word', wins, self))).toEqual(['WINWORD'])
    expect(names(matchWindows('budget report', wins, self))).toEqual(['WINWORD'])
    expect(matchWindows('spotify', wins, self).matched).toHaveLength(0)
  })
})

describe('shortcuts', () => {
  it('parses key combos', () => {
    expect(parseKeys('ctrl+w')).toEqual([0x11, 0x57])
    expect(parseKeys('Ctrl + Shift + T')).toEqual([0x11, 0x10, 0x54])
    expect(parseKeys('alt+f4')).toEqual([0x12, 0x73])
    expect(() => parseKeys('ctrl+banana')).toThrow(/Unknown key/)
  })
})
