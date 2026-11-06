// Per-task AI options for the heavier jobs (resolving conflicts, reviewing a pull request): which model answers, and
// the user's own instructions added to the prompt. Pure helpers; components/AiTaskOptions.tsx is the UI.
import type { AiProvider, AiStatus } from '@shared/types'

/** The model these tasks start with when the active provider is Anthropic. */
export const DEFAULT_TASK_MODEL = 'claude-opus-5-5'

export interface ModelOption {
  id: string
  label: string
}

const ANTHROPIC_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' }
]

/** Models offered for the active provider: the known ones, plus the model set in Preferences when it isn't one of them. */
export function modelOptions(status: AiStatus | null): ModelOption[] {
  const active = status?.active
  if (!active) return []
  const known = active.provider === 'anthropic' ? ANTHROPIC_MODELS : []
  if (known.some((m) => m.id === active.model)) return known
  return [...known, { id: active.model, label: `${active.model} (from Preferences)` }]
}

/** Opus 5.5 on Anthropic, else the provider's configured model; a model remembered for the provider wins. */
export function initialModel(status: AiStatus | null, remembered: string | null): string {
  const active = status?.active
  if (!active) return ''
  if (remembered?.trim()) return remembered.trim()
  return active.provider === 'anthropic' ? DEFAULT_TASK_MODEL : active.model
}

export function modelLabel(id: string): string {
  return ANTHROPIC_MODELS.find((m) => m.id === id)?.label ?? id
}

const storeKey = (provider: AiProvider) => `karen.aiTaskModel.${provider}`

export function rememberedModel(provider: AiProvider | undefined): string | null {
  if (!provider) return null
  try {
    return localStorage.getItem(storeKey(provider))
  } catch {
    return null
  }
}

export function rememberModel(provider: AiProvider | undefined, model: string) {
  if (!provider) return
  try {
    if (model.trim()) localStorage.setItem(storeKey(provider), model.trim())
    else localStorage.removeItem(storeKey(provider))
  } catch {
    // a per-viewer convenience; nothing to do when storage is unavailable
  }
}

/** The prompt with the user's own instructions after it; unchanged when there are none. */
export function withUserNotes(prompt: string, notes: string): string {
  const text = notes.trim()
  if (!text) return prompt
  return `${prompt}

## Additional instructions from the user
${text}

Follow these instructions where they apply, but keep the reply format required above.`
}
