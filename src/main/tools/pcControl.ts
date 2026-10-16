/**
 * OWNER: Kiro. Direct PC control for the assistant: list open windows, close
 * apps (gracefully, like clicking X, so apps can still ask to save), minimise /
 * maximise / focus windows, send keyboard shortcuts, lock, sleep, dark mode,
 * brightness, settings pages.
 *
 * Speed: one long-lived PowerShell helper with the user32 bindings compiled
 * once, so each action takes milliseconds instead of starting PowerShell and
 * compiling C# every time.
 * Safety: requests are JSON lines (values are never spliced into script text),
 * core Windows processes and ZVYRA itself are never touched, and forced kills
 * go through the normal command approval (see desktopTools `close_app`).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POWERSHELL_EXE } from '../desktop/exec'

export interface WinInfo {
  hwnd: number
  pid: number
  process: string
  title: string
  cls: string
  minimized: boolean
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class ZvyraPc {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool LockWorkStation();
  public static List<string> List() {
    var o = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512); if (t.Length == 0) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      o.Add(h.ToInt64() + "\t" + pid + "\t" + (IsIconic(h) ? "1" : "0") + "\t" + c.ToString() + "\t" + t.ToString().Replace("\t", " "));
      return true; }, IntPtr.Zero);
    return o;
  }
  public static void Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }
}
"@
$names = @{}
function ProcName([int]$id) { if (-not $names.ContainsKey($id)) { try { $names[$id] = (Get-Process -Id $id).ProcessName } catch { $names[$id] = '' } }; $names[$id] }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $id = ''
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $out = $null
    switch ($req.op) {
      'windows' {
        $names = @{}
        $out = @([ZvyraPc]::List() | ForEach-Object {
          $p = $_ -split "\t", 5
          @{ hwnd = [int64]$p[0]; pid = [int]$p[1]; minimized = ($p[2] -eq '1'); cls = $p[3]; title = $p[4]; process = (ProcName ([int]$p[1])) }
        })
      }
      'close' { foreach ($h in $req.hwnds) { [void][ZvyraPc]::PostMessage([IntPtr][int64]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }; $out = $true }
      'alive' { $out = @($req.hwnds | Where-Object { [ZvyraPc]::IsWindow([IntPtr][int64]$_) }) }
      'show' {
        $h = [IntPtr][int64]$req.hwnd
        if ($req.cmd -eq 'focus') { [ZvyraPc]::Focus($h) } else { [void][ZvyraPc]::ShowWindow($h, [int]$req.cmd) }
        $out = $true
      }
      'minimizeAll' { (New-Object -ComObject Shell.Application).MinimizeAll(); $out = $true }
      'undoMinimizeAll' { (New-Object -ComObject Shell.Application).UndoMinimizeALL(); $out = $true }
      'keys' {
        $vks = @($req.vks | ForEach-Object { [byte]$_ })
        for ($n = 0; $n -lt [int]$req.times; $n++) {
          foreach ($k in $vks) { [ZvyraPc]::keybd_event($k, 0, 0, [UIntPtr]::Zero) }
          [array]::Reverse($vks); foreach ($k in $vks) { [ZvyraPc]::keybd_event($k, 0, 2, [UIntPtr]::Zero) }; [array]::Reverse($vks)
          Start-Sleep -Milliseconds 60
        }
        $out = $true
      }
      'lock' { $out = [ZvyraPc]::LockWorkStation() }
      'sleep' { Add-Type -AssemblyName System.Windows.Forms; $out = [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) }
      'theme' {
        $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
        $v = if ($req.dark) { 0 } else { 1 }
        Set-ItemProperty -Path $k -Name AppsUseLightTheme -Value $v -Type DWord
        Set-ItemProperty -Path $k -Name SystemUsesLightTheme -Value $v -Type DWord
        $out = $true
      }
      'brightness' {
        $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $m) { throw 'This display does not support brightness control from Windows (external monitors usually don''t).' }
        [void](Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]$req.value })
        $out = [int]$req.value
      }
      default { throw "Unknown operation $($req.op)" }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $out } | ConvertTo-Json -Compress -Depth 4))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`

/** Never closed or touched, whatever the request says. */
const PROTECTED = new Set([
  'dwm', 'csrss', 'winlogon', 'lsass', 'svchost', 'services', 'smss', 'wininit', 'system', 'fontdrvhost', 'sihost', 'ctfmon',
  'textinputhost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchapp', 'searchui', 'lockapp', 'zvyra', 'electron',
  'securityhealthsystray', 'runtimebroker', 'widgets', 'msmpeng'
])
/** Desktop / taskbar windows that must never get a close message (closing Progman opens the shutdown dialog). */
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow'])

const BROWSERS = ['chrome', 'msedge', 'brave', 'firefox', 'opera', 'opera_gx', 'vivaldi', 'arc', 'iexplore', 'yandex', 'chromium']

/** Friendly names → process names. */
const ALIASES: Record<string, string[]> = {
  browser: BROWSERS, browsers: BROWSERS, 'web browser': BROWSERS, tabs: BROWSERS, 'all tabs': BROWSERS, 'browser tabs': BROWSERS, internet: BROWSERS,
  chrome: ['chrome'], 'google chrome': ['chrome'], edge: ['msedge'], 'microsoft edge': ['msedge'], brave: ['brave'], firefox: ['firefox'], opera: ['opera', 'opera_gx'],
  notepad: ['notepad'], 'notepad++': ['notepad++'], word: ['winword'], 'microsoft word': ['winword'], excel: ['excel'], powerpoint: ['powerpnt'],
  outlook: ['outlook', 'olk'], onenote: ['onenote'], 'vs code': ['code'], vscode: ['code'], 'visual studio code': ['code'], code: ['code'],
  'visual studio': ['devenv'], explorer: ['explorer'], 'file explorer': ['explorer'], folders: ['explorer'], 'folder windows': ['explorer'],
  teams: ['ms-teams', 'teams'], 'microsoft teams': ['ms-teams', 'teams'], spotify: ['spotify'], discord: ['discord'], whatsapp: ['whatsapp', 'whatsapp.root'],
  telegram: ['telegram'], slack: ['slack'], zoom: ['zoom'], steam: ['steam', 'steamwebhelper'], obs: ['obs64', 'obs'], vlc: ['vlc'],
  calculator: ['calculatorapp', 'calculator'], settings: ['systemsettings'], 'task manager': ['taskmgr'], paint: ['mspaint'], photos: ['photos', 'microsoft.photos'],
  terminal: ['windowsterminal', 'wt'], 'windows terminal': ['windowsterminal'], cmd: ['cmd'], 'command prompt': ['cmd'], powershell: ['powershell', 'pwsh'],
  'media player': ['microsoft.media.player', 'wmplayer'], 'snipping tool': ['snippingtool'], camera: ['windowscamera'], mail: ['olk', 'hxoutlook'],
  'epic games': ['epicgameslauncher'], 'adobe reader': ['acrord32', 'acrobat'], acrobat: ['acrobat', 'acrord32']
}
const ALL = new Set(['all', 'all apps', 'everything', 'all windows', 'every app', 'all programs', 'all open apps'])

const norm = (s: string) => s.toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9+]+/g, ' ').trim()

/** Which windows a request like "notepad", "all tabs" or "the budget spreadsheet" refers to. */
export function matchWindows(target: string, wins: WinInfo[], selfPids: Set<number>): { matched: WinInfo[]; all: boolean } {
  const usable = wins.filter((w) => !PROTECTED.has(w.process.toLowerCase()) && !selfPids.has(w.pid) && !SHELL_CLASSES.has(w.cls) && w.title !== 'Program Manager')
  const t = norm(target.replace(/^(the|my|all( of)?( the)?|every)\s+/i, (m) => (/^all|every/i.test(m) ? 'all ' : '')).replace(/\s+(app|apps|application|applications|window|windows|program|programs)$/i, ''))
  if (ALL.has(t) || t === 'all' || t === '') return { matched: usable, all: true }
  const bare = t.replace(/^all\s+/, '')
  const procs = ALIASES[bare] ?? ALIASES[t]
  if (procs) {
    const m = usable.filter((w) => procs.includes(w.process.toLowerCase()) || (w.process.toLowerCase() === 'applicationframehost' && norm(w.title).includes(bare)))
    // File Explorer: only folder windows (never the taskbar / desktop).
    return { matched: procs.includes('explorer') ? m.filter((w) => w.cls === 'CabinetWClass') : m, all: false }
  }
  const byProc = usable.filter((w) => {
    const p = norm(w.process)
    return p === bare || p.replace(/ /g, '') === bare.replace(/ /g, '') || (bare.length >= 3 && p.startsWith(bare))
  })
  if (byProc.length) return { matched: byProc.filter((w) => w.process.toLowerCase() !== 'explorer' || w.cls === 'CabinetWClass'), all: false }
  return { matched: usable.filter((w) => bare.length >= 3 && norm(w.title).includes(bare)), all: false }
}

/* ---------------------------------------------------------------- keys */

const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b, tab: 0x09, enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b,
  space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25,
  right: 0x27, insert: 0x2d, printscreen: 0x2c, f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78,
  f10: 0x79, f11: 0x7a, f12: 0x7b, plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe
}

/** "ctrl+shift+t" → virtual-key codes. Throws for unknown keys. */
export function parseKeys(combo: string): number[] {
  const parts = combo.toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean)
  if (!parts.length || parts.length > 4) throw new Error('Give a shortcut like "ctrl+w" or "alt+tab".')
  return parts.map((p) => {
    if (VK[p] !== undefined) return VK[p]
    if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0)
    throw new Error(`Unknown key “${p}”.`)
  })
}

/* ---------------------------------------------------------------- host */

export class PcControl {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private buffer = ''
  private scriptPath: string | null = null

  private ensure() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    if (process.platform !== 'win32') throw new Error('PC control is available on Windows only.')
    if (!this.scriptPath) {
      const dir = join(tmpdir(), 'zvyra-commands')
      mkdirSync(dir, { recursive: true })
      this.scriptPath = join(dir, 'pc-control-host.ps1')
      writeFileSync(this.scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SCRIPT, 'utf8')]))
    }
    const child = spawn(POWERSHELL_EXE, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], { windowsHide: true })
    child.stdout.on('data', (b: Buffer) => {
      this.buffer += b.toString('utf8')
      let i: number
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim()
        this.buffer = this.buffer.slice(i + 1)
        if (!line.startsWith('{')) continue
        try {
          const msg = JSON.parse(line) as { id: string; ok: boolean; result?: unknown; error?: string }
          const p = this.pending.get(msg.id)
          if (!p) continue
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(new Error(msg.error ?? 'PC control failed'))
        } catch {
          /* ignore partial / non-JSON lines */
        }
      }
    })
    const fail = () => {
      this.child = null
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('The PC control helper stopped'))
        this.pending.delete(id)
      }
    }
    child.on('exit', fail)
    child.on('error', fail)
    this.child = child
    return child
  }

  private ask<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const child = this.ensure()
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The PC didn’t respond in time'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n')
    })
  }

  /** Starts the helper ahead of time so the first request is fast. */
  warm() {
    if (process.platform === 'win32') void this.ask('windows', {}, 30_000).catch(() => undefined)
  }

  async windows(): Promise<WinInfo[]> {
    const r = await this.ask<WinInfo[] | WinInfo | null>('windows', {}, 30_000)
    return !r ? [] : Array.isArray(r) ? r : [r]
  }

  /** Graceful close (WM_CLOSE, like clicking X). Returns windows still open after `waitMs` (often a "save changes?" prompt). */
  async close(wins: WinInfo[], waitMs = 2500): Promise<WinInfo[]> {
    if (!wins.length) return []
    await this.ask('close', { hwnds: wins.map((w) => w.hwnd) })
    const deadline = Date.now() + waitMs
    let alive = wins
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      const r = await this.ask<number[] | number | null>('alive', { hwnds: alive.map((w) => w.hwnd) })
      const leftSet = new Set(r == null ? [] : Array.isArray(r) ? r : [r])
      alive = alive.filter((w) => leftSet.has(w.hwnd))
      if (!alive.length) break
    }
    return alive
  }

  show(win: WinInfo, action: 'minimize' | 'maximize' | 'restore' | 'focus') {
    const cmd = action === 'focus' ? 'focus' : action === 'minimize' ? 6 : action === 'maximize' ? 3 : 9
    return this.ask('show', { hwnd: win.hwnd, cmd })
  }

  minimizeAll() {
    return this.ask('minimizeAll')
  }
  undoMinimizeAll() {
    return this.ask('undoMinimizeAll')
  }
  keys(combo: string, times = 1) {
    return this.ask('keys', { vks: parseKeys(combo), times: Math.max(1, Math.min(20, Math.round(times))) })
  }
  lock() {
    return this.ask('lock')
  }
  sleep() {
    return this.ask('sleep')
  }
  theme(dark: boolean) {
    return this.ask('theme', { dark })
  }
  brightness(value: number) {
    return this.ask<number>('brightness', { value: Math.max(0, Math.min(100, Math.round(value))) })
  }

  dispose() {
    this.child?.kill()
    this.child = null
  }
}

export const pcControl = new PcControl()
