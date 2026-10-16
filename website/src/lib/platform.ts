import { useEffect, useState } from 'react'

export type VisitorPlatform = 'windows' | 'macos' | 'mobile' | 'other'

/** Pure UA sniffing. Only used to highlight a suggestion; never hides options. */
export function detectPlatform(ua: string, uaPlatform = '', touchPoints = 0): VisitorPlatform {
  const s = `${uaPlatform} ${ua}`.toLowerCase()
  if (/iphone|ipad|ipod|android/.test(s)) return 'mobile'
  // iPadOS reports as Mac; touch points give it away.
  if (/mac/.test(s)) return touchPoints > 1 ? 'mobile' : 'macos'
  if (/win/.test(s)) return 'windows'
  return 'other'
}

export function usePlatform(): VisitorPlatform {
  const [p, setP] = useState<VisitorPlatform>('other')
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    setP(detectPlatform(nav.userAgent, nav.userAgentData?.platform ?? '', nav.maxTouchPoints ?? 0))
  }, [])
  return p
}
