/**
 * Standalone iOS entry point.
 *
 * It installs the in-browser `window.zvyra` bridge BEFORE anything from the
 * renderer loads, then reuses the exact same App, pages, components, styles
 * and animations as the desktop build. The only additions are:
 *  - iOS CSS polish (safe areas, momentum scroll, 44pt touch targets).
 *  - a touch gloss layer that gives tap feedback where the desktop relies on
 *    mouse hover (which does not exist on a touch screen).
 */
import { installBridge } from './adapter/bridge'

// Install the bridge first so bootstrap() finds window.zvyra on first call.
installBridge()

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Reuse the desktop renderer's design system and app shell verbatim.
import '@renderer/styles/base.css'
import '@renderer/styles/app.css'
// iOS-only polish layered on top (loaded last so it can refine desktop rules).
import './styles/ios.css'
import { App } from '@renderer/app/App'
import { bootstrap } from '@renderer/lib/store'
import { installTouchGloss } from './touch'

void bootstrap('main')
installTouchGloss()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
