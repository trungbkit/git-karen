import './platform/bridge'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './styles/theme.css'
import './styles/app.css'
import './styles/macos.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary region="The window" root>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
