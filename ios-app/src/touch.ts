/**
 * Touch feedback for the iOS build.
 *
 * The desktop UI leans on `:hover` for affordance (buttons, nav items, cards).
 * Touch screens have no hover, so taps can feel dead. This adds a lightweight
 * pressed state: while a finger is down on an interactive element we add a
 * `.is-pressed` class that ios.css styles like the desktop hover. It also
 * disables the iOS long-press callout and suppresses the 300ms tap delay.
 *
 * No framework, no React — a single set of passive listeners on the document.
 */
const PRESSABLE = 'button, a, [role="button"], .nav-item, .card, .toggle, .segmented button'

export function installTouchGloss(): void {
  if (typeof document === 'undefined') return

  let pressed: Element | null = null

  const release = () => {
    if (pressed) {
      pressed.classList.remove('is-pressed')
      pressed = null
    }
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      const target = (e.target as Element | null)?.closest(PRESSABLE)
      if (!target || (target as HTMLButtonElement).disabled) return
      release()
      pressed = target
      target.classList.add('is-pressed')
    },
    { passive: true }
  )

  document.addEventListener('touchend', release, { passive: true })
  document.addEventListener('touchcancel', release, { passive: true })
  // If a scroll steals the gesture, drop the pressed state too.
  document.addEventListener('touchmove', release, { passive: true })
}
