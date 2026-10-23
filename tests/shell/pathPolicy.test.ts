import { describe, expect, it } from 'vitest'
import { explainFsError, pathBlockReason } from '../../src/main/desktop/pathPolicy'

const ctx = { home: 'C:\\Users\\user', env: { SystemDrive: 'C:', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' } }

describe('path policy', () => {
  it('allows any user-chosen folder on any drive, including spaces and nesting', () => {
    for (const p of ['D:\\Zvyra ai\\website', 'E:\\Clients\\Café Roma\\site', 'C:\\Projects\\a\\b\\c', 'C:\\Users\\user\\Documents\\my site', 'C:\\Users\\Public\\Shared'])
      expect(pathBlockReason(p, 'write', ctx)).toBeNull()
  })
  it('refuses writes into protected Windows folders', () => {
    expect(pathBlockReason('C:\\Windows\\System32\\x.dll', 'write', ctx)).toMatch(/protected Windows system folder/)
    expect(pathBlockReason('C:\\Program Files\\App\\a.txt', 'write', ctx)).toMatch(/protected/)
    expect(pathBlockReason('c:\\programdata\\microsoft\\x', 'write', ctx)).toMatch(/protected/)
  })
  it('still allows reading system folders', () => {
    expect(pathBlockReason('C:\\Program Files\\App\\readme.txt', 'read', ctx)).toBeNull()
  })
  it('never touches another user’s profile', () => {
    expect(pathBlockReason('C:\\Users\\someone\\Documents\\a.txt', 'read', ctx)).toMatch(/another user/)
    expect(pathBlockReason('C:\\Users\\someone', 'write', ctx)).toMatch(/another user/)
  })
  it('refuses to write a drive root or the whole profile as a target', () => {
    expect(pathBlockReason('D:\\', 'write', ctx)).toMatch(/root of drive/)
    expect(pathBlockReason('C:\\Users\\user', 'write', ctx)).toMatch(/whole profile/)
  })
  it('rejects relative and device paths', () => {
    expect(pathBlockReason('site\\index.html', 'write', ctx)).toMatch(/absolute/)
    expect(pathBlockReason('\\\\?\\C:\\x', 'read', ctx)).toMatch(/Device paths/)
  })
  it('explains real filesystem errors', () => {
    expect(explainFsError({ code: 'EPERM' }, 'D:\\x')).toMatch(/denied access/)
    expect(explainFsError({ code: 'EBUSY' }, 'D:\\x')).toMatch(/locked/)
    expect(explainFsError({ code: 'EROFS' }, 'E:\\x')).toMatch(/read-only/)
  })
})
