/**
 * OWNER: Kiro. Reliable CMD / PowerShell execution.
 *
 * Why this exists (root causes of the old failures):
 *  - Commands were passed to PowerShell as `-EncodedCommand <base64>`: the
 *    UTF-16 base64 blob is ~2.7x the script size and runs into the 32 767-char
 *    Windows command-line limit, and errors came back as CLIXML noise.
 *  - Everything ran in Windows PowerShell 5.1, so CMD syntax (`&&`, `dir /b`,
 *    `set X=1`) failed outright.
 *  - stdin was left as an open pipe, so anything that prompted (npm init,
 *    `pause`, "Are you sure?") hung until the 15-minute timeout.
 *  - The PowerShell exit code ignored native programs' $LASTEXITCODE, so a
 *    failing `npm install` was reported as success.
 *
 * Now: scripts are written to a private temp file and run by path (PowerShell
 * `-File`, CMD `call`), short single-line CMD commands run with verbatim
 * arguments, stdin is closed, output is decoded as UTF-8 per stream, exit
 * codes are propagated, and every run has a timeout and can be cancelled.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { CommandShell } from '../../shared/contract'

const SYSTEM_ROOT = process.env['SystemRoot'] ?? 'C:\\Windows'
export const POWERSHELL_EXE = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
export const CMD_EXE = process.env['ComSpec'] && /cmd\.exe$/i.test(process.env['ComSpec']) ? process.env['ComSpec'] : join(SYSTEM_ROOT, 'System32', 'cmd.exe')

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 30 * 60_000
const MAX_OUTPUT = 400_000
/** Single-line CMD commands up to this length run inline (interactive semantics); longer ones go to a file. */
const CMD_INLINE_MAX = 6000

export type ExecStatus = 'exited' | 'timeout' | 'cancelled' | 'spawn_error'

export interface ExecOptions {
  shell: CommandShell
  command: string
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
  /** Where temporary script files go (defaults to the OS temp folder). */
  tempDir?: string
  env?: NodeJS.ProcessEnv
}

export interface ExecResult {
  status: ExecStatus
  exitCode: number | null
  stdout: string
  stderr: string
  /** stdout and stderr interleaved in arrival order (ANSI colour codes removed). */
  output: string
  durationMs: number
  truncated: boolean
  error?: string
}

export interface ExecHandle {
  pid: number | undefined
  done: Promise<ExecResult>
  /** Stops the process tree. */
  kill(reason?: 'cancelled' | 'timeout'): void
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
export const stripAnsi = (s: string) => s.replace(ANSI, '')

/** PowerShell wrapper: UTF-8 output, no progress noise, real exit codes for cmdlets and native programs. */
export function powershellScript(command: string): string {
  return [
    // Errors stop the script and fail the run, unless the command itself says
    // -ErrorAction SilentlyContinue / Ignore (which is then respected).
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}',
    '$OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    // Windows PowerShell 5.1 otherwise reads BOM-less UTF-8 as ANSI and writes UTF-16.
    "$PSDefaultParameterValues['*:Encoding'] = 'utf8'",
    '$global:LASTEXITCODE = 0',
    '$__zvyraFailed = $false',
    // Format output inside the script: Windows PowerShell 5.1 otherwise loses pending
    // table output (Get-Location, Get-ChildItem…) when the script exits right after it.
    'try {',
    '& {',
    command,
    '} | Out-String -Stream -Width 240',
    '} catch {',
    '  $__zvyraFailed = $true',
    '  [Console]::Error.WriteLine(($_ | Out-String).Trim())',
    '}',
    'if ($__zvyraFailed) { exit 1 }',
    'if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    'exit 0',
    ''
  ].join('\r\n')
}

export function cmdScript(command: string): string {
  return ['@echo off', 'chcp 65001 >nul', command.replace(/\r?\n/g, '\r\n'), 'exit /b %errorlevel%', ''].join('\r\n')
}

function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const k = spawn(join(SYSTEM_ROOT, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    k.on('error', () => child.kill())
  } else child.kill('SIGTERM')
}

interface Prepared {
  file: string
  args: string[]
  verbatim: boolean
  script?: string
}

async function prepare(o: ExecOptions): Promise<Prepared> {
  const dir = o.tempDir ?? join(tmpdir(), 'zvyra-commands')
  if (o.shell === 'powershell') {
    if (process.platform !== 'win32') throw new Error('PowerShell commands run on Windows only.')
    await mkdir(dir, { recursive: true })
    const script = join(dir, `${randomUUID()}.ps1`)
    // UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII text correctly.
    await writeFile(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(powershellScript(o.command), 'utf8')]))
    return { file: POWERSHELL_EXE, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], verbatim: false, script }
  }
  if (process.platform !== 'win32') throw new Error('CMD commands run on Windows only.')
  const single = !/[\r\n]/.test(o.command) && o.command.length <= CMD_INLINE_MAX
  if (single) {
    // `cmd /d /s /c "<line>"`: /s strips exactly the outer quotes, the line keeps its own quoting.
    return { file: CMD_EXE, args: ['/d', '/s', '/c', `"chcp 65001 >nul & ${o.command}"`], verbatim: true }
  }
  await mkdir(dir, { recursive: true })
  const script = join(dir, `${randomUUID()}.cmd`)
  if (/["%^&|<>]/.test(script)) throw new Error(`The temporary folder path can’t be used safely by CMD: ${script}`)
  await writeFile(script, cmdScript(o.command), 'utf8')
  return { file: CMD_EXE, args: ['/d', '/s', '/c', `"call "${script}""`], verbatim: true, script }
}

/** Starts a command and returns immediately; `done` settles when it exits, times out or is cancelled. */
export function startCommand(o: ExecOptions): ExecHandle {
  const started = Date.now()
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, o.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  let child: ChildProcess | null = null
  let stopReason: 'cancelled' | 'timeout' | null = null
  let earlyStop: 'cancelled' | 'timeout' | null = null
  const handle: ExecHandle = {
    pid: undefined,
    done: Promise.resolve() as unknown as Promise<ExecResult>,
    kill(reason = 'cancelled') {
      if (!child) {
        earlyStop = reason
        return
      }
      if (stopReason) return
      stopReason = reason
      killTree(child)
    }
  }

  handle.done = (async (): Promise<ExecResult> => {
    const fail = (error: string): ExecResult => ({ status: 'spawn_error', exitCode: null, stdout: '', stderr: error, output: error, durationMs: Date.now() - started, truncated: false, error })
    if (!o.command.trim()) return fail('Empty command')
    if (!existsSync(o.cwd)) return fail(`The working folder doesn’t exist: ${o.cwd}`)
    if (o.signal?.aborted) return { ...fail('Cancelled before it started'), status: 'cancelled' }
    let prep: Prepared
    try {
      prep = await prepare(o)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    const cleanup = () => (prep.script ? rm(prep.script, { force: true }).catch(() => undefined) : undefined)
    if (earlyStop) {
      await cleanup()
      return { ...fail('Stopped before it started'), status: earlyStop }
    }

    return new Promise<ExecResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let output = ''
      let truncated = false
      const add = (which: 'stdout' | 'stderr', text: string) => {
        if (!text) return
        const clean = stripAnsi(text)
        if (which === 'stdout') stdout = (stdout + clean).slice(-MAX_OUTPUT)
        else stderr = (stderr + clean).slice(-MAX_OUTPUT)
        output += clean
        if (output.length > MAX_OUTPUT) {
          output = output.slice(-MAX_OUTPUT)
          truncated = true
        }
        try {
          o.onOutput?.(which, clean)
        } catch {
          /* a bad listener must not break the run */
        }
      }
      let spawned: ChildProcess
      try {
        spawned = spawn(prep.file, prep.args, {
          cwd: o.cwd,
          windowsHide: true,
          windowsVerbatimArguments: prep.verbatim,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...o.env, NO_COLOR: '1', FORCE_COLOR: '0', npm_config_color: 'false', npm_config_yes: 'false' }
        })
      } catch (err) {
        void cleanup()
        return resolve(fail(`Couldn’t start ${o.shell === 'cmd' ? 'CMD' : 'PowerShell'}: ${err instanceof Error ? err.message : String(err)}`))
      }
      child = spawned
      handle.pid = spawned.pid
      const outDec = new StringDecoder('utf8')
      const errDec = new StringDecoder('utf8')
      spawned.stdout?.on('data', (b: Buffer) => add('stdout', outDec.write(b)))
      spawned.stderr?.on('data', (b: Buffer) => add('stderr', errDec.write(b)))
      const timer = setTimeout(() => handle.kill('timeout'), timeoutMs)
      const onAbort = () => handle.kill('cancelled')
      o.signal?.addEventListener('abort', onAbort, { once: true })
      let spawnError: string | undefined
      spawned.once('error', (err) => {
        spawnError = err.message
      })
      spawned.once('close', (code) => {
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
        add('stdout', outDec.end())
        add('stderr', errDec.end())
        void cleanup()
        const durationMs = Date.now() - started
        if (spawnError && code === null && !stopReason) return resolve({ ...fail(`Couldn’t start ${o.shell === 'cmd' ? 'CMD' : 'PowerShell'}: ${spawnError}`), durationMs })
        if (stopReason) {
          const note = stopReason === 'timeout' ? `Stopped after ${Math.round(timeoutMs / 1000)} s (timeout)` : 'Stopped'
          return resolve({ status: stopReason, exitCode: code, stdout, stderr, output: `${output}${output && !output.endsWith('\n') ? '\n' : ''}[${note}]`, durationMs, truncated, error: note })
        }
        resolve({ status: 'exited', exitCode: code, stdout, stderr, output, durationMs, truncated })
      })
    })
  })()
  return handle
}

export function runCommand(o: ExecOptions): Promise<ExecResult> {
  return startCommand(o).done
}

/** One-line, honest description of a finished run (for the AI and notifications). */
export function describeResult(r: ExecResult): string {
  switch (r.status) {
    case 'exited':
      return r.exitCode === 0 ? 'Finished successfully (exit code 0)' : `Failed with exit code ${r.exitCode}`
    case 'timeout':
      return r.error ?? 'Timed out'
    case 'cancelled':
      return 'Cancelled'
    case 'spawn_error':
      return `Couldn’t start: ${r.error ?? 'unknown error'}`
  }
}
