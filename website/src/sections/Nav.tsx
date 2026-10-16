import { useEffect, useState } from 'react'
import { Brand } from '../components/brand'
import { DownloadButton } from '../components/DownloadButton'
import { ArrowDownIcon } from '../components/icons'
import type { VisitorPlatform } from '../lib/platform'

export function Nav({ platform }: { platform: VisitorPlatform }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])

  return (
    <header className={`nav${scrolled ? ' nav--scrolled' : ''}`}>
      <div className="nav__capsule glass">
        <a className="nav__brand" href="#top" aria-label="ZVYRA home">
          <Brand />
        </a>
        <nav className="nav__links" aria-label="Primary">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#download">Download</a>
        </nav>
        {platform === 'windows' || platform === 'other' ? (
          <DownloadButton platform="windows" context="nav" variant="dark" size="sm" label="Download" />
        ) : (
          // On a Mac or phone, a direct .exe would be the wrong file: go to the download area.
          <a className="dl dl--dark dl--sm dl--live" href="#download">
            <span className="dl__icon"><ArrowDownIcon size={15} /></span>
            <span className="dl__text"><span className="dl__label">Get ZVYRA</span></span>
          </a>
        )}
      </div>
    </header>
  )
}
