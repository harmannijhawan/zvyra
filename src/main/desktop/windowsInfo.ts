/**
 * OWNER: Kiro. Foreground window + visible window list via one long-lived
 * PowerShell helper (user32 P/Invoke compiled once). Read-only.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { ActiveWindowInfo } from '../../shared/contract'

const POWERSHELL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class ZvyraWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    if ($line -eq 'fg') {
      $h = [ZvyraWin]::GetForegroundWindow(); $sb = New-Object Text.StringBuilder 512
      [void][ZvyraWin]::GetWindowText($h, $sb, 512); $p = 0; [void][ZvyraWin]::GetWindowThreadProcessId($h, [ref]$p)
      $name = ''; try { $name = (Get-Process -Id $p).ProcessName } catch {}
      [Console]::Out.WriteLine((@{ ok = $true; title = $sb.ToString(); processName = $name; pid = [int]$p } | ConvertTo-Json -Compress))
    } elseif ($line -eq 'list') {
      $items = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{ title = $_.MainWindowTitle; processName = $_.ProcessName; pid = $_.Id } })
      [Console]::Out.WriteLine((@{ ok = $true; items = $items } | ConvertTo-Json -Compress -Depth 3))
    }
  } catch { [Console]::Out.WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
}
`

export class WindowsInfo {
  private child: ChildProcessWithoutNullStreams | null = null
  private queue: ((line: string | null) => void)[] = []
  private buffer = ''
  private chain: Promise<unknown> = Promise.resolve()

  private ensure() {
    if (this.child && !this.child.killed) return this.child
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true })
    child.stdout.on('data', (b: Buffer) => {
      this.buffer += b.toString('utf8')
      let i: number
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim()
        this.buffer = this.buffer.slice(i + 1)
        if (line) this.queue.shift()?.(line)
      }
    })
    const fail = () => {
      this.child = null
      for (const q of this.queue.splice(0)) q(null)
    }
    child.on('exit', fail)
    child.on('error', fail)
    this.child = child
    return child
  }

  private ask(cmd: 'fg' | 'list'): Promise<Record<string, unknown> | null> {
    const next = this.chain.then(
      () =>
        new Promise<Record<string, unknown> | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 8000)
          this.queue.push((line) => {
            clearTimeout(timer)
            try {
              resolve(line ? (JSON.parse(line) as Record<string, unknown>) : null)
            } catch {
              resolve(null)
            }
          })
          try {
            this.ensure().stdin.write(cmd + '\n')
          } catch {
            resolve(null)
          }
        })
    )
    this.chain = next.catch(() => undefined)
    return next
  }

  async active(): Promise<ActiveWindowInfo | null> {
    if (process.platform !== 'win32') return null
    const r = await this.ask('fg')
    if (!r?.ok) return null
    return { title: String(r.title ?? ''), processName: String(r.processName ?? ''), pid: Number(r.pid) || undefined }
  }

  async list(): Promise<ActiveWindowInfo[]> {
    if (process.platform !== 'win32') return []
    const r = await this.ask('list')
    const items = (r?.items ?? []) as { title: string; processName: string; pid: number }[]
    return (Array.isArray(items) ? items : [items]).map((x) => ({ title: x.title, processName: x.processName, pid: x.pid }))
  }

  dispose() {
    this.child?.kill()
    this.child = null
  }
}
