// What the app knows about each AI credential: where to get one, what it looks like, and which provider it unlocks.
// Pure: no React, no IPC.
import type { AiCredential, AiProvider } from '@shared/types'

export const PROVIDER_LABELS: Record<AiProvider, string> = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini' }

export interface CredentialInfo {
  id: AiCredential
  provider: AiProvider
  label: string
  /** Name in the quick setup's provider switch */
  choice: string
  envVar: string
  placeholder: string
  /** Where to create one; absent when it comes from a command instead */
  keyUrl?: string
  hint?: string
}

/** In the backend's priority order. */
export const AI_CREDENTIALS: CredentialInfo[] = [
  {
    id: 'anthropicOauthToken',
    provider: 'anthropic',
    label: 'Claude OAuth token',
    choice: 'Claude subscription',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    placeholder: 'sk-ant-oat01-…',
    hint: 'Subscription billing. Run `claude setup-token` in a terminal and paste the token it prints.'
  },
  {
    id: 'anthropicApiKey',
    provider: 'anthropic',
    label: 'Anthropic API key',
    choice: 'Claude API',
    envVar: 'ANTHROPIC_API_KEY',
    placeholder: 'sk-ant-api03-…',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  { id: 'openaiApiKey', provider: 'openai', label: 'OpenAI API key', choice: 'OpenAI', envVar: 'OPENAI_API_KEY', placeholder: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'geminiApiKey', provider: 'gemini', label: 'Gemini API key', choice: 'Gemini', envVar: 'GEMINI_API_KEY', placeholder: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' }
]

export const credentialInfo = (id: AiCredential) => AI_CREDENTIALS.find((c) => c.id === id)!

/** The credential a pasted key is for, from its well-known prefix; null when it can't be told. */
export function detectCredential(key: string): AiCredential | null {
  const k = key.trim()
  if (k.startsWith('sk-ant-oat')) return 'anthropicOauthToken'
  if (k.startsWith('sk-ant-')) return 'anthropicApiKey'
  if (k.startsWith('AIza')) return 'geminiApiKey'
  if (k.startsWith('sk-')) return 'openaiApiKey'
  return null
}

/** Why a key typed for `credential` is probably wrong, or null. Empty input is not a problem. */
export function keyProblem(credential: AiCredential, key: string): string | null {
  const k = key.trim()
  if (!k) return null
  if (/\s/.test(k)) return 'The key contains spaces; paste it again without line breaks.'
  const detected = detectCredential(k)
  if (!detected || detected === credential) return null
  const label = credentialInfo(detected).label
  return `This looks like ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}.`
}
