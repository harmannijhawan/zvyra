import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PermissionRequest } from '../../src/shared/contract'
import { ApprovalService, makeOp, needsApproval, ruleMatches, verifyBeforeRun, type RulesState } from '../../src/main/desktop/approvals'
import { classifyCommand, type CommandContext } from '../../src/main/desktop/commandRisk'
import { JsonDoc } from '../../src/main/desktop/jsonDoc'

const cwd = 'C:\\Users\\alex\\Documents\\ZVYRA Projects\\shop'
const ctx: CommandContext = { cwd, home: 'C:\\Users\\alex', allowedRoots: [], env: { SystemRoot: 'C:\\Windows' } }
const op = (command: string, shell: 'powershell' | 'cmd' = 'powershell', dir = cwd, source: 'agent' | 'user' = 'agent') =>
  makeOp(shell, command, dir, classifyCommand(command, shell, { ...ctx, cwd: dir }), source)

let dir = ''
let doc: JsonDoc<RulesState>
let requested: PermissionRequest[]
let resolved: [string, string][]
let svc: ApprovalService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zvyra-approvals-'))
  doc = new JsonDoc<RulesState>(join(dir, 'rules.json'), { rules: [] })
  requested = []
  resolved = []
  svc = new ApprovalService(doc, { requested: (r) => requested.push(r), resolved: (id, d) => resolved.push([id, d]) }, 200)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('approval policy', () => {
  it('runs low-risk commands without asking and asks for medium/high from the AI', () => {
    expect(needsApproval(op('Get-ChildItem'))).toBe(false)
    expect(needsApproval(op('npm install'))).toBe(true)
    expect(needsApproval(op('Remove-Item .\\dist -Recurse'))).toBe(true)
  })
  it('only asks the user about their own typed commands when they are high risk', () => {
    expect(needsApproval(op('npm install', 'powershell', cwd, 'user'))).toBe(false)
    expect(needsApproval(op('Remove-Item .\\dist -Recurse', 'powershell', cwd, 'user'))).toBe(true)
  })
  it('refuses to even ask about critical commands', () => {
    expect(() => svc.request(op('Format-Volume -DriveLetter C'))).toThrow(/blocked/)
  })
})

describe('Allow (once)', () => {
  it('approves only the pending request and saves nothing', async () => {
    const { id, outcome } = svc.request(op('npm install'))
    expect(requested).toHaveLength(1)
    expect(requested[0].command?.text).toBe('npm install')
    expect(requested[0].canAlwaysAllow).toBe(true)
    svc.respond(id, 'allow_once')
    expect(await outcome).toBe('allow_once')
    expect(svc.rules()).toHaveLength(0)
    expect(svc.findRule(op('npm install'))).toBeUndefined()
    expect(() => svc.respond(id, 'allow_once')).toThrow(/expired or was already answered/)
  })
  it('deny resolves as deny', async () => {
    const { id, outcome } = svc.request(op('npm run build'))
    svc.respond(id, 'deny')
    expect(await outcome).toBe('deny')
    expect(resolved).toEqual([[id, 'deny']])
  })
  it('expires unanswered requests as a denial', async () => {
    const { outcome } = svc.request(op('npm run build'))
    expect(await outcome).toBe('expired')
    expect(svc.list()).toHaveLength(0)
  })
})

describe('Always allow', () => {
  it('saves a narrow rule for the exact command, shell and folder', async () => {
    const { id, outcome } = svc.request(op('npm   install'))
    svc.respond(id, 'allow_always')
    expect(await outcome).toBe('allow_always')
    const [rule] = svc.rules()
    expect(rule).toMatchObject({ shell: 'powershell', program: 'npm', command: 'npm install', risk: 'medium' })
    expect(svc.findRule(op('npm install'))?.id).toBe(rule.id)
    // Anything else still asks.
    expect(svc.findRule(op('npm install left-pad'))).toBeUndefined()
    expect(svc.findRule(op('npm install', 'cmd'))).toBeUndefined()
    expect(svc.findRule(op('npm install', 'powershell', 'C:\\Users\\alex\\Documents\\other'))).toBeUndefined()
    expect(svc.findRule(op('npm install; Remove-Item .\\src -Recurse'))).toBeUndefined()
  })
  it('is never offered or accepted for high-risk commands', () => {
    const { id } = svc.request(op('Remove-Item .\\dist -Recurse'))
    expect(requested[0].canAlwaysAllow).toBe(false)
    expect(() => svc.respond(id, 'allow_always')).toThrow(/one at a time/)
    expect(svc.rules()).toHaveLength(0)
  })
  it('a saved rule cannot authorise a command that now classifies higher', () => {
    const rule = { id: 'r', shell: 'powershell' as const, program: 'remove-item', command: 'Remove-Item .\\dist -Recurse', cwd, risk: 'medium' as const, createdAt: '', uses: 0 }
    expect(ruleMatches(rule, op('Remove-Item .\\dist -Recurse'))).toBe(false)
  })
  it('can be revoked', async () => {
    const { id, outcome } = svc.request(op('npm run lint'))
    svc.respond(id, 'allow_always')
    await outcome
    const [rule] = svc.rules()
    expect(svc.revoke(rule.id)).toHaveLength(0)
    expect(svc.findRule(op('npm run lint'))).toBeUndefined()
  })
})

describe('approval binding', () => {
  it('rejects a command swapped after approval', () => {
    const approved = op('npm run build')
    const swapped = 'npm run build; Remove-Item .\\src -Recurse'
    expect(verifyBeforeRun(approved, 'powershell', swapped, cwd, classifyCommand(swapped, 'powershell', ctx))).toMatch(/changed after it was approved/)
    expect(verifyBeforeRun(approved, 'powershell', 'npm run build', 'C:\\Users\\alex', classifyCommand('npm run build', 'powershell', ctx))).toMatch(/changed/)
    expect(verifyBeforeRun(approved, 'powershell', 'npm run build', cwd, classifyCommand('npm run build', 'powershell', ctx))).toBeNull()
  })
  it('freezes approved operations', () => {
    const o = op('npm run build') as { command: string }
    expect(() => {
      o.command = 'rm -r C:\\'
    }).toThrow()
  })
})
