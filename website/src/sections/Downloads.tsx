import { DOWNLOADS, formatBytes, isDownloadable, PLATFORM_ORDER, type PlatformDownload } from '../config/downloads'
import { DownloadButton } from '../components/DownloadButton'
import { AppleIcon, PhoneIcon, WindowsIcon } from '../components/icons'
import { useReveal } from '../lib/motion'
import type { VisitorPlatform } from '../lib/platform'

const ICON = { windows: WindowsIcon, macos: AppleIcon, ios: PhoneIcon }

function Tile({ p, recommended }: { p: PlatformDownload; recommended: boolean }) {
  const ref = useReveal<HTMLLIElement>()
  const live = isDownloadable(p)
  const Icon = ICON[p.id]
  const facts = live
    ? ([
        ['Version', p.version],
        ['Format', p.formatDetail ?? p.format],
        ['Size', p.sizeBytes ? formatBytes(p.sizeBytes) : null],
        ['System', p.architecture]
      ].filter(([, v]) => v) as [string, string][])
    : []

  return (
    <li className={`plat reveal plat--${p.id}${live ? ' plat--live' : ' plat--soon'}`} ref={ref}>
      <div className="plat__head">
        <span className="plat__icon" aria-hidden="true"><Icon size={22} /></span>
        <h3 className="plat__name">{p.name}</h3>
        {live ? (
          <span className="plat__status plat__status--live">{recommended ? 'Available · for this PC' : 'Available now'}</span>
        ) : (
          <span className="plat__status">{p.statusLabel}</span>
        )}
      </div>

      {live ? (
        <>
          <dl className="plat__facts">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {p.requirements.length > 0 && (
            <ul className="plat__req">
              {p.requirements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <DownloadButton platform={p.id} context="downloads" showMeta recommended={recommended} />
          {p.sha256 && (
            <p className="plat__sha">
              SHA-256 <code>{p.sha256}</code>
            </p>
          )}
        </>
      ) : (
        // No download yet: the status chip + note say so; a real button appears
        // automatically once the entry in src/config/downloads.ts is made available.
        <p className="plat__note">{p.statusNote}</p>
      )}
    </li>
  )
}

export function Downloads({ platform }: { platform: VisitorPlatform }) {
  const head = useReveal<HTMLDivElement>()
  return (
    <section className="section dls" id="download" aria-labelledby="download-title">
      <div className="section__head reveal" ref={head}>
        <p className="eyebrow">Download</p>
        <h2 id="download-title" className="section__title">
          Get ZVYRA <span className="soft">on your computer.</span>
        </h2>
        <p className="section__sub">Setup takes about two minutes.</p>
      </div>
      <ul className="dls__grid">
        {PLATFORM_ORDER.map((id) => (
          <Tile key={id} p={DOWNLOADS[id] as PlatformDownload} recommended={id === platform} />
        ))}
      </ul>
    </section>
  )
}
