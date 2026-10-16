/**
 * OWNER: Kiro. Runs a short, FIXED PowerShell script (never AI- or user-typed
 * text) and returns stdout. Used by tools for things Node can't do directly on
 * Windows: media keys, volume, battery, windows and processes.
 *
 * Values are passed in environment variables (read as $env:ZVYRA_*), never
 * spliced into the script text, so names like "it's & $(x)" can't inject code.
 * Runs through the shared executor (script file, closed stdin, real exit codes).
 */
import { tmpdir } from 'node:os'
import { runCommand } from '../desktop/exec'

export async function runPowerShell(script: string, timeoutMs = 15_000, env: Record<string, string> = {}): Promise<string> {
  const r = await runCommand({ shell: 'powershell', command: script, cwd: tmpdir(), timeoutMs, env })
  if (r.status === 'exited' && r.exitCode === 0) return r.stdout.trim()
  if (r.status === 'timeout') throw new Error('PowerShell timed out')
  const msg = (r.stderr || r.stdout || r.error || '').trim().split(/\r?\n/).filter(Boolean)
  throw new Error(msg.slice(0, 3).join(' ').slice(0, 400) || `PowerShell exited with ${r.exitCode}`)
}
