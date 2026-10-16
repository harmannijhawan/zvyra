/**
 * OWNER: Kiro. Media playback tools (ported from E.D.I.T.H. youtube_video and
 * the volume part of computer_settings): system media keys, master volume via
 * Core Audio, and “play X” on YouTube (first real video, not Shorts) or Spotify.
 */
import { runPowerShell } from './ps'
import { decodeEntities } from './research'

export type MediaAction = 'play_pause' | 'next' | 'previous' | 'stop' | 'volume_up' | 'volume_down' | 'mute' | 'set_volume' | 'get_volume'

const VK: Record<string, number> = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2, volume_up: 0xaf, volume_down: 0xae, mute: 0xad }

/** Core Audio master volume (IAudioEndpointVolume) — compiled once per PowerShell call. */
const AUDIO_CS = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class ZvyraAudio {
  static IAudioEndpointVolume Vol() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume v = null;
    var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out v));
    return v;
  }
  public static int Get() { float f; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out f)); return (int)Math.Round(f * 100); }
  public static bool Muted() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void Set(int p) { var v = Vol(); Marshal.ThrowExceptionForHR(v.SetMute(false, Guid.Empty)); Marshal.ThrowExceptionForHR(v.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, p)) / 100f, Guid.Empty)); }
}
`

const audio = (body: string) => `Add-Type -TypeDefinition @'\n${AUDIO_CS}\n'@\n${body}`

async function pressKey(vk: number, times = 1) {
  const n = Math.max(1, Math.min(50, Math.round(times)))
  await runPowerShell(
    `Add-Type -Name K -Namespace ZvyraKeys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);'; ` +
      `1..${n} | ForEach-Object { [ZvyraKeys.K]::keybd_event(${vk},0,1,[UIntPtr]::Zero); [ZvyraKeys.K]::keybd_event(${vk},0,3,[UIntPtr]::Zero); Start-Sleep -Milliseconds 15 }`
  )
}

export async function getVolume(): Promise<{ volume: number; muted: boolean }> {
  const out = await runPowerShell(audio('"$([ZvyraAudio]::Get())|$([ZvyraAudio]::Muted())"'))
  const [v, m] = out.split('|')
  return { volume: Number(v), muted: /true/i.test(m ?? '') }
}

export async function setVolume(percent: number): Promise<number> {
  const p = Math.max(0, Math.min(100, Math.round(percent)))
  await runPowerShell(audio(`[ZvyraAudio]::Set(${p})`))
  return p
}

const NO_OUTPUT = /0x80070490|Element not found/i
const friendlyAudio = (err: unknown) =>
  NO_OUTPUT.test(err instanceof Error ? err.message : String(err))
    ? 'Windows has no default playback device right now. Pick speakers or headphones in Settings → System → Sound → Output.'
    : `Couldn’t change the volume: ${err instanceof Error ? err.message : String(err)}`

export async function mediaControl(action: MediaAction, value?: number): Promise<Record<string, unknown>> {
  switch (action) {
    case 'get_volume':
      try {
        return { ok: true, ...(await getVolume()) }
      } catch (err) {
        return { error: friendlyAudio(err) }
      }
    case 'set_volume': {
      if (value === undefined || !Number.isFinite(value)) return { error: 'Say which level (0–100).' }
      try {
        return { ok: true, volume: await setVolume(value) }
      } catch (err) {
        return { error: friendlyAudio(err) }
      }
    }
    case 'volume_up':
    case 'volume_down': {
      const step = value && Number.isFinite(value) ? Math.abs(value) : 10
      try {
        const cur = await getVolume()
        const next = await setVolume(cur.volume + (action === 'volume_up' ? step : -step))
        return { ok: true, volume: next }
      } catch {
        await pressKey(VK[action], step / 2) // each key press is 2%
        return { ok: true }
      }
    }
    default: {
      const vk = VK[action]
      if (!vk) return { error: `Unknown media action ${action}` }
      await pressKey(vk)
      return { ok: true, action }
    }
  }
}

/* ---------------------------------------------------------------- YouTube */

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+cb; SOCS=CAI'
}

const unescapeJson = (s: string) => {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return decodeEntities(s)
  }
}

export interface VideoHit {
  id: string
  url: string
  title?: string
  channel?: string
  length?: string
}

/** First real video (Shorts skipped) for a search, scraped from the results page — no API key. */
export async function youtubeSearch(query: string, max = 5): Promise<VideoHit[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`
  const r = await fetch(url, { headers: YT_HEADERS, signal: AbortSignal.timeout(12_000) })
  if (!r.ok) throw new Error(`YouTube answered ${r.status}`)
  const html = await r.text()
  const hits: VideoHit[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"/g)) {
    const id = m[1]
    if (seen.has(id) || html.includes(`/shorts/${id}`)) continue
    seen.add(id)
    const chunk = html.slice(m.index ?? 0, (m.index ?? 0) + 6000)
    const str = (re: RegExp) => {
      const v = re.exec(chunk)?.[1]
      return v ? unescapeJson(v) : undefined
    }
    hits.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: str(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/),
      channel: str(/"ownerText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/),
      length: str(/"lengthText":\{[^}]*?"simpleText":"((?:[^"\\]|\\.)*)"/)
    })
    if (hits.length >= max) break
  }
  if (!hits.length) {
    for (const m of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
      if (seen.has(m[1]) || html.includes(`/shorts/${m[1]}`)) continue
      hits.push({ id: m[1], url: `https://www.youtube.com/watch?v=${m[1]}` })
      break
    }
  }
  return hits
}

export const spotifySearchUri = (query: string) => `spotify:search:${encodeURIComponent(query)}`
export const youtubeResultsUrl = (query: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`
