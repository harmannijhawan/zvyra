/**
 * OWNER: Kiro. Windows default audio devices (Core Audio, via a PowerShell helper).
 *
 * Used only around an assisted WhatsApp call: the default microphone is switched
 * to "CABLE Output" (ZVYRA's voice) right before dialling and restored right
 * after, so the user's own calls keep using their real microphone. The previous
 * defaults are written to disk first and restored on the next start if ZVYRA
 * was closed mid-call.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { POWERSHELL_EXE } from '../desktop/exec'

const SCRIPT = String.raw`
param([string]$Action = 'list', [string]$Id = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection d); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection { int GetCount(out int n); int Item(int i, out IMMDevice d); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid i, int c, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); int OpenPropertyStore(int a, out IPropertyStore s); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); }
[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore { int GetCount(out int c); int GetAt(int i, out PKEY k); int GetValue(ref PKEY k, out PROPVARIANT v); }
[StructLayout(LayoutKind.Sequential)] struct PKEY { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig { int a(); int b(); int c(); int d(); int e(); int f(); int g(); int h(); int i(); int j(); int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient {}
public static class ZvAudio {
  static string Name(IMMDevice d) { IPropertyStore s; d.OpenPropertyStore(0, out s); var k = new PKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 }; PROPVARIANT v; s.GetValue(ref k, out v); return Marshal.PtrToStringUni(v.p); }
  static string Def(IMMDeviceEnumerator e, int flow, int role) { IMMDevice d; string id = ""; if (e.GetDefaultAudioEndpoint(flow, role, out d) == 0) d.GetId(out id); return id; }
  public static List<string> List() {
    var e = (IMMDeviceEnumerator)new MMDeviceEnumerator(); var o = new List<string>();
    for (int flow = 0; flow < 2; flow++) {
      IMMDeviceCollection c; e.EnumAudioEndpoints(flow, 1, out c); int n; c.GetCount(out n);
      for (int i = 0; i < n; i++) { IMMDevice d; c.Item(i, out d); string id; d.GetId(out id); o.Add(flow + "\t" + id + "\t" + Name(d)); }
      o.Add("D" + flow + "\t" + Def(e, flow, 0) + "\t" + Def(e, flow, 1) + "\t" + Def(e, flow, 2));
    }
    return o;
  }
  public static void Set(string id, int role) { var p = (IPolicyConfig)new PolicyConfigClient(); p.SetDefaultEndpoint(id, role); }
}
"@
if ($Action -eq 'set') { foreach ($pair in ($Id -split ';')) { $r, $d = $pair -split '=', 2; if ($d) { [ZvAudio]::Set($d, [int]$r) } }; 'ok' } else { [ZvAudio]::List() }
`

export interface AudioDevice {
  id: string
  name: string
  flow: 'playback' | 'recording'
}
export interface AudioState {
  devices: AudioDevice[]
  /** Default device ids per role: [console, multimedia, communications]. */
  defaultPlayback: [string, string, string]
  defaultRecording: [string, string, string]
}

let scriptPath: string | null = null
function run(args: string[]): Promise<string> {
  if (!scriptPath) {
    const dir = join(tmpdir(), 'zvyra-commands')
    mkdirSync(dir, { recursive: true })
    scriptPath = join(dir, 'audio-devices.ps1')
    writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SCRIPT, 'utf8')]))
  }
  return new Promise((resolve, reject) =>
    execFile(POWERSHELL_EXE, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath!, ...args], { windowsHide: true, timeout: 30_000 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().slice(0, 300))) : resolve(out)
    )
  )
}

export async function audioState(): Promise<AudioState> {
  const out = await run(['list'])
  const s: AudioState = { devices: [], defaultPlayback: ['', '', ''], defaultRecording: ['', '', ''] }
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const p = line.split('\t')
    if (p[0] === 'D0') s.defaultPlayback = [p[1] ?? '', p[2] ?? '', p[3] ?? '']
    else if (p[0] === 'D1') s.defaultRecording = [p[1] ?? '', p[2] ?? '', p[3] ?? '']
    else if (p[0] === '0' || p[0] === '1') s.devices.push({ flow: p[0] === '0' ? 'playback' : 'recording', id: p[1], name: p[2] ?? '' })
  }
  return s
}

/** Sets defaults per role (0 console, 1 multimedia, 2 communications) and waits until Windows reports them. */
export async function setDefaults(roles: [string, string, string]) {
  await run(['set', roles.map((id, r) => `${r}=${id}`).filter((x) => !x.endsWith('=')).join(';')])
  // Windows applies default-device changes asynchronously.
  for (let i = 0; i < 10; i++) {
    const s = await audioState()
    if (roles.every((id, r) => !id || s.defaultRecording[r] === id || s.defaultPlayback[r] === id)) return
    await new Promise((res) => setTimeout(res, 300))
  }
}

export class MicSwap {
  private saved: [string, string, string] | null = null
  constructor(private readonly stateFile: string) {}

  get active() {
    return !!this.saved
  }

  /** Restores a microphone left switched by a previous run (crash or quit mid-call). */
  async recover() {
    if (!existsSync(this.stateFile)) return
    try {
      const prev = JSON.parse(readFileSync(this.stateFile, 'utf8')) as [string, string, string]
      await setDefaults(prev)
    } finally {
      rmSync(this.stateFile, { force: true })
    }
  }

  /** Makes "CABLE Output" the default microphone for every role; returns its name. */
  async toCable(): Promise<string> {
    const s = await audioState()
    const cable = s.devices.find((d) => d.flow === 'recording' && /CABLE Output/i.test(d.name))
    if (!cable) throw new Error('The “CABLE Output” microphone is missing (VB-CABLE not installed).')
    if (!this.saved) {
      this.saved = s.defaultRecording
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify(this.saved))
    }
    await setDefaults([cable.id, cable.id, cable.id])
    const after = await audioState()
    if (after.defaultRecording[2] !== cable.id) throw new Error('Windows did not switch the default microphone to CABLE Output.')
    return cable.name
  }

  async restore() {
    if (!this.saved) return
    const prev = this.saved
    this.saved = null
    await setDefaults(prev)
    rmSync(this.stateFile, { force: true })
  }
}
