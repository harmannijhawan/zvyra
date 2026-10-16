import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/manrope/wght.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/hero.css'
import './styles/showcase.css'
import './styles/sections.css'
import './styles/responsive.css'
import { App } from './App'
import { missingDownloads } from './config/downloads'

if (import.meta.env.DEV) {
  const missing = missingDownloads()
  if (missing.length) console.info(`[zvyra] download URL missing for: ${missing.join(', ')} (see src/config/downloads.ts)`)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
