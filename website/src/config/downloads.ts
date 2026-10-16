/**
 * ─────────────────────────────────────────────────────────────────────────
 *  ZVYRA downloads: the ONE place every download CTA on the site reads from.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * To enable / change a platform, edit only its entry below. No component
 * changes are needed: buttons become real links as soon as an entry is
 * `status: 'available'` with a valid `url` ('/…' self-hosted or 'https://…').
 *
 * This file uses only erasable TypeScript syntax and has no imports, so
 * scripts/sync-downloads.mjs can import it directly with Node's type stripping.
 */

export type PlatformId = 'windows' | 'macos' | 'ios'
export type DownloadStatus = 'available' | 'coming-soon'
export type InstallerFormat = 'EXE' | 'DMG' | 'ZIP' | 'APP_STORE'

export interface PlatformDownload {
  id: PlatformId
  name: string
  ctaLabel: string
  status: DownloadStatus
  /** Visible chip while not available, e.g. "Coming soon". */
  statusLabel: string | null
  /** One honest sentence; also used as the accessible description. */
  statusNote: string
  /** null = MISSING. Relative '/…' (self-hosted from public/) or 'https://…'. */
  url: string | null
  format: InstallerFormat | null
  formatDetail: string | null
  fileName: string | null
  version: string | null
  sizeBytes: number | null
  sha256: string | null
  architecture: string | null
  /** Short verified line for the hero compatibility text. null = not shown. */
  compatibility: string | null
  requirements: string[]
}

/** Applies to every desktop build; shown once in the hero compatibility line. */
export const SHARED_REQUIREMENT = 'Needs a Google Gemini API key (free to start)'

export const DOWNLOADS = {
  windows: {
    id: 'windows',
    name: 'Windows',
    ctaLabel: 'Download for Windows',
    status: 'available',
    statusLabel: null,
    statusNote: 'Windows installer, version 0.2.0, 64-bit.',
    url: 'https://github.com/harmannijhawan/zvyra/releases/download/v0.2.0-windows/ZVYRA-Setup-0.2.0.exe',
    format: 'EXE',
    formatDetail: 'NSIS installer (.exe)',
    fileName: 'ZVYRA-Setup-0.2.0.exe',
    version: '0.2.0',
    sizeBytes: 129907055,
    sha256: 'DB8CDCDE49B29A31D6630D9949772F8895ED79ED035B9A3114900AFB1C1B86DD',
    architecture: '64-bit (x64)',
    compatibility: 'Windows · 64-bit (x64)',
    requirements: [
      'A Google Gemini API key (free to start) for voice, research, camera and the builder',
      'A microphone for voice conversations',
      'Unsigned build: Windows SmartScreen may ask you to choose More info → Run anyway'
    ]
  },

  // The release page lets Mac owners select the correct native architecture.
  macos: {
    id: 'macos',
    name: 'macOS',
    ctaLabel: 'Download for macOS',
    status: 'available',
    statusLabel: null,
    statusNote: 'macOS preview installers for Apple Silicon and Intel. Choose your Mac on the download page.',
    url: 'https://github.com/harmannijhawan/zvyra/releases/tag/v0.2.0-macos',
    format: 'DMG',
    formatDetail: 'DMG installer or ZIP',
    fileName: null,
    version: '0.2.0',
    sizeBytes: null,
    sha256: null,
    architecture: 'Apple Silicon (arm64) / Intel (x64)',
    compatibility: 'macOS · Apple Silicon / Intel',
    requirements: [
      'Choose arm64 for Apple Silicon or x64 for an Intel Mac on the download page',
      'A Google Gemini API key and a microphone for voice conversations',
      'Preview build: unsigned and not notarized',
      'Allow microphone and Accessibility permissions for voice and desktop control'
    ]
  },

  // iOS currently has preview source only. If it ships on the App Store, set
  // status: 'available', url: 'https://apps.apple.com/…', format: 'APP_STORE' and
  // update statusLabel/statusNote.
  ios: {
    id: 'ios',
    name: 'iPhone & iPad',
    ctaLabel: 'Get it on the App Store',
    status: 'coming-soon',
    statusLabel: 'Not available yet',
    statusNote: 'ZVYRA isn’t available for iPhone or iPad.',
    url: null,
    format: null,
    formatDetail: null,
    fileName: null,
    version: null,
    sizeBytes: null,
    sha256: null,
    architecture: null,
    compatibility: null,
    requirements: []
  }
} satisfies Record<PlatformId, PlatformDownload>

export const PLATFORM_ORDER: PlatformId[] = ['windows', 'macos', 'ios']

export function isDownloadable(p: PlatformDownload): p is PlatformDownload & { url: string } {
  return p.status === 'available' && typeof p.url === 'string' && /^(\/[^/]|https:\/\/)/.test(p.url)
}

export function missingDownloads(): PlatformId[] {
  return PLATFORM_ORDER.filter((id) => !isDownloadable(DOWNLOADS[id]))
}

/** Size as Windows Explorer shows it (MiB), e.g. 129886362 → "124 MB". */
export function formatBytes(n: number): string {
  return `${Math.round(n / 1_048_576)} MB`
}

export function compatibilityLine(): string {
  const parts = PLATFORM_ORDER.map((id) => DOWNLOADS[id] as PlatformDownload)
    .filter(isDownloadable)
    .map((p) => [p.compatibility, p.version && `v${p.version}`].filter(Boolean).join(' · '))
    .filter(Boolean)
  return [...parts, SHARED_REQUIREMENT].join(' · ')
}
