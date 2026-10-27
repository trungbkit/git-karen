import type { AiApi, AppApi, GitApi, TerminalApi } from '@shared/types'
import type { IntegrationsApi } from '@shared/integrations'

declare global {
  interface Window {
    git: GitApi
    app: AppApi
    ai: AiApi
    term: TerminalApi
    /** Hosting integrations (GitHub/GitLab API through the backend) */
    integrations: IntegrationsApi
  }
}

export {}
