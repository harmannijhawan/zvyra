/**
 * OWNER: Kiro. Windows UI Automation (accessibility tree) for screen
 * understanding and reliable desktop actions.
 *
 *  - foreground: the active window (process, title, bounds) and, for browsers,
 *    the address-bar URL,
 *  - tree: visible controls (buttons, fields, links, menu items…) with names
 *    and physical-pixel bounds,
 *  - invoke / setValue / getValue: act on a control by its accessible name
 *    (Invoke/Toggle/Select patterns first; a click at the element centre only
 *    as a fallback), and read values back for verification.
 *
 * Same safety model as pcControl: one long-lived PowerShell helper, JSON-line
 * requests (values never spliced into script text), per-monitor DPI aware.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POWERSHELL_EXE } from '../desktop/exec'

export interface UiRect {
  x: number
  y: number
  w: number
  h: number
}
export interface UiElement {
  runtimeId?: string
  password?: boolean
  name: string
  type: string
  id?: string
  enabled: boolean
  rect: UiRect | null
  value?: string
}
export interface ForegroundInfo {
  hwnd: number
  pid: number
  process: string
  title: string
  rect: UiRect | null
  browserUrl?: string
}
export interface WindowTarget {
  hwnd?: number
  /** Process name without .exe, e.g. "WhatsApp.Root", "chrome". */
  process?: string
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class ZvU {
  [StructLayout(LayoutKind.Sequential)] public struct POINT {public int x,y;}
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
  public static bool IsTargetWindowAtPoint(long hwnd,int x,int y) {return GetAncestor(WindowFromPoint(new POINT{x=x,y=y}),2)==GetAncestor(new IntPtr(hwnd),2);}
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public static void Focus(IntPtr h) { if (IsIconic(h)) ShowWindow(h, 9); keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); SetForegroundWindow(h); }
  public static void Click(int x, int y) { SetCursorPos(x, y); mouse_event(0x02, 0, 0, 0, UIntPtr.Zero); mouse_event(0x04, 0, 0, 0, UIntPtr.Zero); }
}
"@
try { [void][ZvU]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
$AE = [System.Windows.Automation.AutomationElement]
function Rect($e) { $r = $e.Current.BoundingRectangle; if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { return $null }; @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }
function TypeOf($c) { $c.ControlType.ProgrammaticName -replace '^ControlType\.', '' }
function Info($e) {
  $c = $e.Current
  $o = @{ name = $c.Name; type = (TypeOf $c); id = $c.AutomationId; runtimeId = ($e.GetRuntimeId() -join '.'); enabled = $c.IsEnabled; rect = (Rect $e); password = $c.IsPassword }
  if (-not $c.IsPassword -and ($c.Name + $c.AutomationId) -notmatch '(?i)password|secret|token|credential|api.?key') { try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($vp) { $o.value = [string]$vp.Current.Value } } catch {} }
  $o
}
function WindowEl($req) {
  if ($req.hwnd) { return $AE::FromHandle([IntPtr][int64]$req.hwnd) }
  if ($req.process) {
    $p = Get-Process -Name $req.process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { throw "No open window for $($req.process)" }
    return $AE::FromHandle($p.MainWindowHandle)
  }
  return $AE::FromHandle([ZvU]::GetForegroundWindow())
}
function Walk($root, [int]$max, [int]$depth, $types, $nameRe, [int]$ms) {
  $out = New-Object System.Collections.ArrayList
  $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($root, 0))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($stack.Count -gt 0 -and $out.Count -lt $max -and $sw.ElapsedMilliseconds -lt $ms) {
    $item = $stack.Pop(); $e = $item[0]; $d = [int]$item[1]
    try { $c = $e.Current } catch { throw "Accessibility element unavailable: $($_.Exception.Message)" }
    if ($d -gt 0 -and -not $c.IsOffscreen) {
      $t = TypeOf $c
      $okType = (-not $types) -or ($types -contains $t)
      $okName = if ($nameRe) { ($c.Name -match $nameRe) -or ($c.AutomationId -and $c.AutomationId -match $nameRe) } else { [bool]$c.Name -or $t -eq 'Edit' }
      if ($okType -and $okName) { [void]$out.Add($e) }
    }
    if ($d -lt $depth) {
      try { $ch = $w.GetLastChild($e); while ($ch -ne $null) { $stack.Push(@($ch, ($d + 1))); $ch = $w.GetPreviousSibling($ch) } } catch { throw "Accessibility traversal failed: $($_.Exception.Message)" }
    }
  }
  ,$out
}
function Fg() {
  $h = [ZvU]::GetForegroundWindow(); [uint32]$pid2 = 0; [void][ZvU]::GetWindowThreadProcessId($h, [ref]$pid2)
  $sb = New-Object System.Text.StringBuilder 512; [void][ZvU]::GetWindowText($h, $sb, 512)
  $pn = ''; try { $pn = (Get-Process -Id $pid2).ProcessName } catch {}
  $el = $AE::FromHandle($h)
  $o = @{ hwnd = $h.ToInt64(); pid = [int]$pid2; process = $pn; title = $sb.ToString(); rect = (Rect $el) }
  if ($pn -match '^(chrome|msedge|brave|vivaldi|opera|firefox|arc)$') {
    $re = '^(Address and search bar|Address bar|Search or enter address|Search with .* or enter address|urlbar-input)$'
    $hit = Walk $el 1 14 @('Edit') $re 2500
    if ($hit.Count) { try { $o.browserUrl = [string]$hit[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {} }
  }
  $o
}
function Candidates($root, $req, $types) {
  if ($req.runtimeId) { $found = Walk $root 400 35 $types $null 5000; $hits=New-Object System.Collections.ArrayList; foreach($e in $found) { if(($e.GetRuntimeId() -join '.') -eq $req.runtimeId) { [void]$hits.Add($e) } }; ,$hits }
  else { $found=Walk $root 12 30 $types $req.name 5000; ,$found }
}
function Act($e, [string]$how) {
  $c = $e.Current
  if (-not $c.IsEnabled) { throw "'$($c.Name)' is disabled" }
  if ($how -ne 'click') {
    foreach ($p in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.ExpandCollapsePattern]::Pattern)) {
      $obj = $null
      if ($e.TryGetCurrentPattern($p, [ref]$obj)) {
        if ($obj -is [System.Windows.Automation.InvokePattern]) { $obj.Invoke(); return 'invoke' }
        if ($obj -is [System.Windows.Automation.TogglePattern]) { $obj.Toggle(); return 'toggle' }
        if ($obj -is [System.Windows.Automation.SelectionItemPattern]) { $obj.Select(); return 'select' }
        if ($obj -is [System.Windows.Automation.ExpandCollapsePattern]) { $obj.Expand(); return 'expand' }
      }
    }
  }
  $r = Rect $e
  if (-not $r) { throw "'$($c.Name)' has no on-screen position" }
  [ZvU]::Click([int]($r.x + $r.w / 2), [int]($r.y + $r.h / 2))
  'click'
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $id = ''
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $out = $null
    switch ($req.op) {
      'foreground' { $out = Fg }
      'focused' { $out = Info $AE::FocusedElement }
      'atPoint' { $p = New-Object System.Windows.Point([double]$req.x,[double]$req.y); $out = Info ($AE::FromPoint($p)) }
      'tree' {
        $root = WindowEl $req
        $types = if ($req.types) { @($req.types) } else { @('Button','Edit','Hyperlink','MenuItem','ListItem','TabItem','CheckBox','RadioButton','ComboBox','Document','Text','Image','SplitButton') }
        $els = Walk $root ([int]$req.max) ([int]$req.depth) $types $req.name 5000
        $out = @($els | ForEach-Object { Info $_ })
      }
      'invoke' {
        $root = WindowEl $req
        if ($req.focus) { [ZvU]::Focus([IntPtr]$root.Current.NativeWindowHandle); Start-Sleep -Milliseconds 200 }
        $els = Candidates $root $req $req.types
        $usable = @($els | Where-Object { $_.Current.IsEnabled })
        if ($usable.Count -ne 1) { throw "Control must match exactly one enabled element; found $($usable.Count). Observe again or specify the control type." }
        $pick = $usable[0]
        if (-not $pick) { throw "No control matching '$($req.name)'" }
        $how = Act $pick $req.how
        $out = @{ element = (Info $pick); how = $how; matches = $els.Count }
      }
      'setValue' {
        $root = WindowEl $req
        if ($req.focus) { [ZvU]::Focus([IntPtr]$root.Current.NativeWindowHandle); Start-Sleep -Milliseconds 200 }
        $els = Candidates $root $req @('Edit','Document','ComboBox')
        if ($els.Count -ne 1) { throw "Text field must resolve uniquely; found $($els.Count)." }
        $pick = $els | Select-Object -First 1
        if (-not $pick) { throw "No text field matching '$($req.name)'" }
        if ($pick.Current.IsPassword -or ($pick.Current.Name + $pick.Current.AutomationId) -match '(?i)password|secret|token|credential|api.?key') { throw 'Sensitive text fields require the user' }
        $vp = $null
        if ($pick.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and -not $vp.Current.IsReadOnly) { $vp.SetValue([string]$req.value); $how = 'value' }
        else { $pick.SetFocus(); Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait(($req.value -replace '([+^%~(){}\[\]])', '{$1}')); $how = 'keys' }
        $out = @{ element = (Info $pick); how = $how }
      }
      'getValue' {
        $root = WindowEl $req
        $els = Walk $root 3 30 $req.types $req.name 4000
        $out = @($els | ForEach-Object { Info $_ })
      }
      'focusControl' { $root = WindowEl $req; $els = Candidates $root $req $null; if ($els.Count -ne 1) { throw 'Control must resolve uniquely' }; $els[0].SetFocus(); $out = Info $els[0] }
      'resolve' {
        $root = WindowEl $req; $els = Candidates $root $req $req.types
        if ($els.Count -ne 1) { throw 'Control must resolve uniquely' }
        $pick=$els[0];if (-not $pick.Current.IsEnabled) { throw 'Control is disabled' }
        if ($null -ne $req.x -and $null -ne $req.y) {
          $p=New-Object System.Windows.Point([double]$req.x,[double]$req.y);$node=$AE::FromPoint($p);$hit=$false;$identity=$pick.GetRuntimeId() -join '.';$hitType=TypeOf $node.Current
          for($depth=0;$depth -lt 40 -and $null -ne $node;$depth++) {
            if(($node.GetRuntimeId() -join '.') -eq $identity){$hit=$true;break}
            $node=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($node)
          }
          # Some Chromium modal providers return only their host pane for hit
          # tests. A real HWND hit must still belong to the intended window.
          if(-not $hit -and $hitType -in @('Pane','Window','Document') -and [ZvU]::IsTargetWindowAtPoint([int64]$req.hwnd,[int]$req.x,[int]$req.y)){$hit=$true}
          if(-not $hit){throw "Target is covered by another control ($hitType at $($req.x),$($req.y)); observe again"}
        }
        $out = Info $pick
      }
      'focus' { $root = WindowEl $req; [ZvU]::Focus([IntPtr]$root.Current.NativeWindowHandle); $out = $true }
      'click' { [ZvU]::Click([int]$req.x, [int]$req.y); $out = $true }
      'typeText' { [System.Windows.Forms.SendKeys]::SendWait(([string]$req.text -replace '([+^%~(){}\[\]])', '{$1}')); $out = $true }
      default { throw "Unknown operation $($req.op)" }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $out } | ConvertTo-Json -Compress -Depth 6))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`

class UiaHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private buffer = ''
  private scriptPath: string | null = null

  private ensure() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    if (process.platform !== 'win32') throw new Error('UI Automation is available on Windows only.')
    if (!this.scriptPath) {
      const dir = join(tmpdir(), 'zvyra-commands')
      mkdirSync(dir, { recursive: true })
      this.scriptPath = join(mkdtempSync(join(dir, 'uia-')), 'host.ps1')
      writeFileSync(this.scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SCRIPT, 'utf8')]))
    }
    const child = spawn(POWERSHELL_EXE, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], { windowsHide: true })
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
          else p.reject(new Error(msg.error ?? 'UI Automation failed'))
        } catch {
          /* partial line */
        }
      }
    })
    const fail = () => {
      if (this.child !== child) return
      this.child = null
      this.buffer = ''
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('The UI Automation helper stopped'))
        this.pending.delete(id)
      }
    }
    child.on('exit', fail)
    child.on('error', fail)
    this.child = child
    return child
  }

  ask<T>(op: string, args: object = {}, timeoutMs = 20_000): Promise<T> {
    const child = this.ensure()
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('The window did not respond to UI Automation in time'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n')
    })
  }

  dispose() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('UI Automation stopped')) }
    this.pending.clear()
    this.child?.kill()
    this.child = null
  }
}

const host = new UiaHost()
const list = <T>(r: T | T[] | null | undefined): T[] => (!r ? [] : Array.isArray(r) ? r : [r])

/** Escapes text for use as an exact-match pattern in name searches. */
export const exactName = (s: string) => `^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`

export const uia = {
  resolve: (t:WindowTarget & {name?:string;runtimeId?:string;types?:string[];x?:number;y?:number})=>host.ask<UiElement>('resolve',t),
  focused: () => host.ask<UiElement>('focused'),
  atPoint: (x: number,y: number) => host.ask<UiElement>('atPoint',{x,y}),
  focusControl: (t: WindowTarget & {name?:string;runtimeId?:string}) => host.ask<UiElement>('focusControl',t),
  foreground: () => host.ask<ForegroundInfo>('foreground', {}, 15_000),
  tree: async (t: WindowTarget & { max?: number; depth?: number; types?: string[]; name?: string } = {}) =>
    list(await host.ask<UiElement | UiElement[]>('tree', { ...t, max: Math.min(400, t.max ?? 150), depth: Math.min(40, t.depth ?? 25) }, 20_000)),
  invoke: (t: WindowTarget & { name: string; runtimeId?: string; types?: string[]; focus?: boolean; how?: 'auto' | 'click' }) => host.ask<{ element: UiElement; how: string; matches: number }>('invoke', t, 20_000),
  setValue: (t: WindowTarget & { name: string; runtimeId?: string; value: string; focus?: boolean }) => host.ask<{ element: UiElement; how: string }>('setValue', t, 20_000),
  getValue: async (t: WindowTarget & { name: string; types?: string[] }) => list(await host.ask<UiElement | UiElement[]>('getValue', t, 15_000)),
  focus: (t: WindowTarget) => host.ask<boolean>('focus', t, 10_000),
  /** Left click at physical screen pixels (fallback when a control has no accessible name). */
  click: (x: number, y: number) => host.ask<boolean>('click', { x: Math.round(x), y: Math.round(y) }, 10_000),
  /** Types text into the focused control (keyboard input). */
  typeText: (text: string) => host.ask<boolean>('typeText', { text }, 20_000),
  dispose: () => host.dispose()
}
