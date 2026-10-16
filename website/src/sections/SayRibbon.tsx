/**
 * Things you can say, drifting by. Every phrase maps to a real tool in the
 * desktop app (media, research, builder, camera, weather, timers, system
 * status, launching apps, ending the conversation).
 */
const ROW_A = [
  '“Play some lofi on YouTube”',
  '“Find the best budget laptops this year”',
  '“What’s the weather like today?”',
  '“Set a timer for ten minutes”',
  '“Pause the music”',
  '“Open VS Code”'
]
const ROW_B = [
  '“Build me an e-commerce site for sneakers”',
  '“Open my camera, what am I holding?”',
  '“How’s my battery doing?”',
  '“Read this webpage for me”',
  '“Turn the volume down”',
  '“Go to sleep”'
]

function Row({ items, reverse }: { items: string[]; reverse?: boolean }) {
  // Duplicated once so the -50% loop is seamless; the copy is hidden from AT.
  return (
    <div className={`ribbon__row${reverse ? ' ribbon__row--rev' : ''}`}>
      <ul className="ribbon__track">
        {[...items, ...items].map((t, i) => (
          <li key={i} aria-hidden={i >= items.length ? true : undefined} className="ribbon__item">
            <span className="ribbon__dot" aria-hidden="true" />
            {t}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SayRibbon() {
  return (
    <section className="ribbon" aria-label="Things you can say to ZVYRA">
      <Row items={ROW_A} />
      <Row items={ROW_B} reverse />
    </section>
  )
}
