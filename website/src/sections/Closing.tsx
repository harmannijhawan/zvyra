import { Brand } from '../components/brand'
import { DownloadButton } from '../components/DownloadButton'
import { ZMark } from '../components/brand'
import { compatibilityLine } from '../config/downloads'
import { useReveal } from '../lib/motion'
import type { VisitorPlatform } from '../lib/platform'

export function FinalCta({ platform }: { platform: VisitorPlatform }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <section className="final" aria-labelledby="final-title">
      <div className="final__inner reveal" ref={ref}>
        <div className="final__pet" aria-hidden="true">
          <span className="final__halo" />
          <span className="final__ring" />
          <ZMark size={96} className="final__z" glow />
        </div>
        <h2 id="final-title" className="final__title">
          Say hello to <span className="hero__accent">ZVYRA.</span>
        </h2>
        <p className="final__sub">Your AI operating system is one download away.</p>
        <div className="final__ctas">
          <DownloadButton platform="windows" context="final" showMeta recommended={platform === 'windows'} />
          <DownloadButton platform="macos" context="final" />
        </div>
        <p className="hero__compat final__compat">{compatibilityLine()}</p>
      </div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot__inner">
        <a href="#top" className="nav__brand" aria-label="ZVYRA, back to top">
          <Brand wordHeight={13} />
        </a>
        <nav className="foot__links" aria-label="Footer">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#download">Download</a>
        </nav>
        <p className="foot__copy">© {new Date().getFullYear()} ZVYRA</p>
      </div>
    </footer>
  )
}
