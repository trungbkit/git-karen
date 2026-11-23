import './platform/bridge'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { installTextInputDefaults } from './ui/textInputDefaults'
import './styles/theme.css'
import './styles/app.css'
import './styles/macos.css'

installTextInputDefaults()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary region="The window" root>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
