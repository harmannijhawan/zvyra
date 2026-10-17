import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DesktopToast, PermissionRequest } from '../../src/shared/contract'
import { ApprovalService, type RulesState } from '../../src/main/desktop/approvals'
import { JsonDoc } from '../../src/main/desktop/jsonDoc'
import { TerminalService, type TerminalState } from '../../src/main/desktop/terminal'

const win = process.platform === 'win32'
let dir = ''
let work = ''
let requests: PermissionRequest[] = []
let toasts: Omit<DesktopToast, 'id' | 'ts'>[] = []
let approvals: ApprovalService
let term: TerminalService

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zvyra-term-'))
  work = join(dir, 'my project')
  mkdirSync(work)
  approvals = new ApprovalService(new JsonDoc<RulesState>(join(dir, 'rules.json'), { rules: [] }), { requested: (r) => requests.push(r), resolved: () => undefined })
  term = new TerminalService(
    new JsonDoc<TerminalState>(join(dir, 'terminal.json'), { runs: [] }),
    async (p) => p,
    () => undefined,
    () => undefined,
    approvals,
    async (cwd) => ({ cwd, home: homedir(), allowedRoots: [dir], env: process.env }),
    (t) => toasts.push(t)
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Answers the next approval request the way a user clicking the popup would. */
const answerNext = (decision: string) =>
  new Promise<PermissionRequest>((resolve) => {
    const start = requests.length
    const t = setInterval(() => {
      if (requests.length > start) {
        clearInterval(t)
        approvals.respond(requests[start].id, decision)
        resolve(requests[start])
      }
    }, 20)
  })

describe.runIf(win)('terminal pipeline', () => {
  it('runs low-risk commands immediately with real output', async () => {
    const r = await term.execute('Get-Location', work, { source: 'agent' })
    expect(r.status).toBe('completed')
    expect(r.output).toContain('my project')
    expect(requests).toHaveLength(0)
  }, 30_000)

  it('never runs a medium-risk command before approval, and Deny stops it', async () => {
    const marker = join(work, 'denied.txt')
    const p = term.execute(`Set-Content -LiteralPath '${marker}' -Value x`, work, { source: 'agent' })
    const req = await answerNext('deny')
    expect(req.command?.text).toContain('denied.txt')
    const r = await p
    expect(r.status).toBe('denied')
    expect(r.ok).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(toasts.some((t) => t.kind === 'denied')).toBe(true)
  }, 30_000)

  it('Allow runs exactly that command once and reports the real result', async () => {
    const marker = join(work, 'allowed.txt')
    const cmd = `Set-Content -LiteralPath '${marker}' -Value ok`
    const p = term.execute(cmd, work, { source: 'agent' })
    await answerNext('allow_once')
    const r = await p
    expect(r.status).toBe('completed')
    expect(existsSync(marker)).toBe(true)
    // Not saved: the same command asks again.
    const again = term.execute(cmd, work, { source: 'agent' })
    await answerNext('deny')
    expect((await again).status).toBe('denied')
  }, 40_000)

  it('Always Allow saves a rule that only matches the same command and folder', async () => {
    const cmd = `node -e "console.log('rule-ok')"`
    const first = term.execute(cmd, work, { source: 'agent', shell: 'powershell' })
    await answerNext('allow_always')
    expect((await first).status).toBe('completed')
    const n = requests.length
    const second = await term.execute(cmd, work, { source: 'agent' })
    expect(second.status).toBe('completed')
    expect(second.approvedBy).toBe('rule')
    expect(requests.length).toBe(n)
    // A different folder still asks.
    const other = term.execute(cmd, dir, { source: 'agent' })
    await answerNext('deny')
    expect((await other).status).toBe('denied')
  }, 40_000)

  it('autonomous mode runs risky commands without asking but still blocks critical ones', async () => {
    const auto = new TerminalService(
      new JsonDoc<TerminalState>(join(dir, 'terminal-auto.json'), { runs: [] }),
      async (p) => p,
      () => undefined,
      () => undefined,
      approvals,
      async (cwd) => ({ cwd, home: homedir(), allowedRoots: [dir], env: process.env }),
      () => undefined,
      () => true
    )
    const n = requests.length
    const marker = join(work, 'auto.txt')
    const r = await auto.execute(`Set-Content -LiteralPath '${marker}' -Value ok`, work, { source: 'agent' })
    expect(r.status).toBe('completed')
    expect(r.approvedBy).toBe('autonomous')
    expect(existsSync(marker)).toBe(true)
    expect((await auto.execute('Format-Volume -DriveLetter Z', work, { source: 'agent' })).status).toBe('blocked')
    expect(requests.length).toBe(n)
  }, 30_000)

  it('blocks critical commands without asking', async () => {
    const n = requests.length
    const r = await term.execute('Format-Volume -DriveLetter Z', work, { source: 'agent' })
    expect(r.status).toBe('blocked')
    expect(requests.length).toBe(n)
  }, 10_000)

  it('reports failures honestly', async () => {
    const r = await term.execute('dir "Z:\\missing\\folder"', work, { source: 'agent', shell: 'cmd' })
    expect(r.status).toBe('failed')
    expect(r.ok).toBe(false)
    expect(r.exitCode).not.toBe(0)
  }, 30_000)
})
