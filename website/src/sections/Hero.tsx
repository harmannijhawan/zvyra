import { compatibilityLine, DOWNLOADS } from '../config/downloads'
import { DownloadButton } from '../components/DownloadButton'
import { HeroShowcase } from '../components/HeroShowcase'
import type { VisitorPlatform } from '../lib/platform'

const HINTS: Partial<Record<VisitorPlatform, string>> = {
  macos: 'On a Mac? The macOS version is coming soon. ZVYRA is available for Windows today.',
  mobile: 'ZVYRA runs on Windows PCs. Open this page on your computer to download.'
}

export function Hero({ platform }: { platform: VisitorPlatform }) {
  const winVersion = DOWNLOADS.windows.version
  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <div className="hero__copy">
        <p className="badge glass enter" style={{ ['--i' as string]: 0 }}>
          <span className="badge__dot" aria-hidden="true" />
          Now available for Windows
          {winVersion && <span className="badge__ver">v{winVersion}</span>}
        </p>

        <h1 id="hero-title" className="hero__title">
          <span className="line enter" style={{ ['--i' as string]: 1 }}>Just say</span>{' '}
          <span className="line enter" style={{ ['--i' as string]: 2 }}>
            <span className="hero__accent">“Hey&nbsp;Zvyra.”</span>
          </span>
        </h1>

        <p className="hero__lede enter" style={{ ['--i' as string]: 3 }}>
          Your AI operating system. Talk to your PC and it researches, builds, plays and opens things for you, from a
          Dynamic Island that’s always one glance away.
        </p>

        <div className="hero__ctas enter" style={{ ['--i' as string]: 4 }}>
          <DownloadButton platform="windows" context="hero" showMeta recommended={platform === 'windows'} />
          <DownloadButton platform="macos" context="hero" />
        </div>

        <div className="hero__fine enter" style={{ ['--i' as string]: 5 }}>
          <p className="hero__compat">{compatibilityLine()}</p>
          <DownloadButton platform="ios" context="hero" variant="quiet" size="sm" />
          {HINTS[platform] && (
            <p className="hero__hint glass" role="note">
              {HINTS[platform]}
            </p>
          )}
        </div>
      </div>

      <div className="hero__visual enter enter--visual" style={{ ['--i' as string]: 4 }}>
        <HeroShowcase />
      </div>
    </section>
  )
}
