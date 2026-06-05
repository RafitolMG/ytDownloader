import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppProviders } from './app/providers'
import { AppRouter } from './app/router'
import { PlayerBar } from './features/player/PlayerBar'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders>
      <AppRouter />
      <PlayerBar />
    </AppProviders>
  </StrictMode>,
)
