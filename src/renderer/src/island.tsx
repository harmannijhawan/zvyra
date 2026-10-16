import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './styles/app.css'
import './styles/island.css'
import { IslandApp } from './island/IslandApp'
import { bootstrap } from './lib/store'
import { ErrorBoundary } from './components/ErrorBoundary'

void bootstrap('island')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="island">
      <IslandApp />
    </ErrorBoundary>
  </StrictMode>
)
