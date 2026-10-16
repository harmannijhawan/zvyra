/**
 * OWNER: Kiro. Runs a short, fixed PowerShell script (never user-typed text)
 * and returns stdout. Used by tools for things Node can't do directly on
 * Windows: media keys, master volume, battery.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const POWERSHELL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  // Errors go to stderr as plain text (PowerShell would otherwise serialise them as CLIXML).
  const wrapped = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'\ntry {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('PowerShell timed out'))
    }, timeoutMs)
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')))
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error((err || out).trim().split('\n').slice(-3).join(' ').slice(0, 400) || `PowerShell exited with ${code}`))
    })
  })
}
