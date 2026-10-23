# Dev/setup helper: show or set the Windows default audio devices (playback/recording).
#   powershell -File scripts\audio-default.ps1 list
#   powershell -File scripts\audio-default.ps1 set <device-id>
# Uses the Core Audio APIs (IMMDeviceEnumerator / IPolicyConfig). Changes nothing unless "set" is used.
param([string]$Action = 'list', [string]$Id = '')
$ErrorActionPreference = 'Stop'
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
  public static List<string> List() {
    var e = (IMMDeviceEnumerator)new MMDeviceEnumerator(); var o = new List<string>();
    for (int flow = 0; flow < 2; flow++) {
      string def = ""; IMMDevice dd; if (e.GetDefaultAudioEndpoint(flow, 0, out dd) == 0) dd.GetId(out def);
      string com = ""; IMMDevice dc; if (e.GetDefaultAudioEndpoint(flow, 2, out dc) == 0) dc.GetId(out com);
      IMMDeviceCollection c; e.EnumAudioEndpoints(flow, 1, out c); int n; c.GetCount(out n);
      for (int i = 0; i < n; i++) { IMMDevice d; c.Item(i, out d); string id; d.GetId(out id); o.Add((flow == 0 ? "playback" : "recording") + "\t" + (id == def ? "default" : "") + (id == com ? ",comms" : "") + "\t" + Name(d) + "\t" + id); }
    }
    return o;
  }
  public static void Set(string id) { var p = (IPolicyConfig)new PolicyConfigClient(); for (int r = 0; r < 3; r++) p.SetDefaultEndpoint(id, r); }
}
"@
if ($Action -eq 'set') { [ZvAudio]::Set($Id); 'set' } else { [ZvAudio]::List() }
