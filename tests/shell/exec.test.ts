import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCommand, startCommand } from '../../src/main/desktop/exec'

const win = process.platform === 'win32'
let base = ''
let spaced = ''

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'zvyra-exec-test-'))
  spaced = join(base, 'folder with spaces & more')
  await mkdir(spaced, { recursive: true })
  await writeFile(join(spaced, 'hello world.txt'), 'héllo from ZVYRA\n', 'utf8')
})
afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe.runIf(win)('command execution (Windows)', () => {
  it('runs PowerShell in a folder with spaces and captures UTF-8 output', async () => {
    const r = await runCommand({ shell: 'powershell', command: "Get-Content -LiteralPath '.\\hello world.txt'; Write-Output (Get-Location).Path", cwd: spaced, timeoutMs: 30_000 })
    expect(r.status).toBe('exited')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('héllo from ZVYRA')
    expect(r.stdout).toContain('folder with spaces & more')
  }, 40_000)

  it('runs CMD syntax (&&, dir /b) that Windows PowerShell 5.1 rejects', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'echo one && dir /b', cwd: spaced, timeoutMs: 30_000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('one')
    expect(r.stdout).toContain('hello world.txt')
  }, 40_000)

  it('propagates native exit codes and stderr', async () => {
    const ps = await runCommand({ shell: 'powershell', command: 'cmd /c "echo broken 1>&2 & exit 3"', cwd: base, timeoutMs: 30_000 })
    expect(ps.exitCode).toBe(3)
    expect(ps.stderr).toContain('broken')
    const cmd = await runCommand({ shell: 'cmd', command: 'dir "Z:\\definitely\\missing"', cwd: base, timeoutMs: 30_000 })
    expect(cmd.exitCode).not.toBe(0)
  }, 40_000)

  it('reports failing cmdlets as failures, not success', async () => {
    const r = await runCommand({ shell: 'powershell', command: "Get-Item -LiteralPath 'C:\\nope\\missing.txt'", cwd: base, timeoutMs: 30_000 })
    expect(r.status).toBe('exited')
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toLowerCase()).toContain('missing.txt')
    const thrown = await runCommand({ shell: 'powershell', command: "throw 'boom'", cwd: base, timeoutMs: 30_000 })
    expect(thrown.exitCode).toBe(1)
    expect(thrown.stderr).toContain('boom')
  }, 40_000)

  it('runs large multi-line scripts from a file instead of the command line', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `$x${i} = ${i}`)
    lines.push('Write-Output ($x1499 + 1)')
    const big = lines.join('\n')
    expect(big.length).toBeGreaterThan(15_000)
    const r = await runCommand({ shell: 'powershell', command: big, cwd: base, timeoutMs: 60_000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('1500')
    const multi = await runCommand({ shell: 'cmd', command: 'set GREETING=hi\necho %GREETING% there', cwd: base, timeoutMs: 30_000 })
    expect(multi.stdout).toContain('hi there')
  }, 70_000)

  it('respects -ErrorAction SilentlyContinue instead of reporting a failure', async () => {
    const r = await runCommand({ shell: 'powershell', command: "Get-Process -Name 'zvyra-no-such-process' -ErrorAction SilentlyContinue; Write-Output 'still fine'", cwd: base, timeoutMs: 30_000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('still fine')
  }, 40_000)

  it('passes values through environment variables (no string interpolation)', async () => {
    const r = await runCommand({ shell: 'powershell', command: 'Write-Output $env:ZVYRA_ARG', cwd: base, timeoutMs: 30_000, env: { ZVYRA_ARG: "it's \"quoted\" & $(not run)" } })
    expect(r.stdout.trim()).toBe("it's \"quoted\" & $(not run)")
  }, 40_000)

  it('never waits on stdin prompts', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'set /p NAME=Your name: & echo done', cwd: base, timeoutMs: 20_000 })
    expect(r.status).toBe('exited')
    expect(r.stdout).toContain('done')
  }, 30_000)

  it('times out and kills the process tree', async () => {
    const t0 = Date.now()
    const r = await runCommand({ shell: 'powershell', command: 'Start-Sleep -Seconds 30', cwd: base, timeoutMs: 2000 })
    expect(r.status).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 30_000)

  it('can be cancelled', async () => {
    const ctrl = new AbortController()
    const h = startCommand({ shell: 'cmd', command: 'ping -n 30 127.0.0.1', cwd: base, timeoutMs: 60_000, signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 800)
    const r = await h.done
    expect(r.status).toBe('cancelled')
  }, 30_000)

  it('fails clearly for a missing working folder', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'echo hi', cwd: join(base, 'nope'), timeoutMs: 5000 })
    expect(r.status).toBe('spawn_error')
    expect(r.error).toMatch(/doesn’t exist/)
  })
})
