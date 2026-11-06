// Model picker and "your instructions" box shown before an AI task runs (conflict resolution, pull request review).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AiStatus } from '@shared/types'
import { initialModel, modelOptions, rememberedModel, rememberModel } from '../smart/aiTask'

const CUSTOM = '\0custom'

export interface AiTaskChoice {
  status: AiStatus | null
  /** Empty until the AI status is known (or when no provider is connected): the backend then uses the configured model */
  model: string
  setModel(model: string): void
  notes: string
  setNotes(notes: string): void
  /** Read the AI status again, e.g. after a provider was connected */
  refresh(): Promise<AiStatus | null>
}

export function useAiTaskChoice(): AiTaskChoice {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [model, setModelState] = useState('')
  const [notes, setNotes] = useState('')
  /** The provider `model` was picked for; another provider (changed in Preferences) starts over */
  const provider = useRef<string | null>(null)

  const refresh = useCallback(
    () =>
      window.ai.status().then(
        (s) => {
          setStatus(s)
          const next = s.active?.provider ?? null
          const switched = next !== provider.current
          provider.current = next
          setModelState((m) => (m && !switched ? m : initialModel(s, rememberedModel(s.active?.provider))))
          return s
        },
        () => null
      ),
    []
  )
  useEffect(() => {
    void refresh()
  }, [refresh])

  const setModel = (m: string) => {
    setModelState(m)
    rememberModel(status?.active?.provider, m)
  }
  return { status, model, setModel, notes, setNotes, refresh }
}

export function AiTaskOptions({
  choice,
  disabled,
  placeholder,
  onSubmit,
  children
}: {
  choice: AiTaskChoice
  disabled?: boolean
  placeholder: string
  /** Cmd/Ctrl+Enter in the instructions box */
  onSubmit?(): void
  /** Action buttons, shown next to the model picker */
  children?: ReactNode
}) {
  const options = modelOptions(choice.status)
  const known = options.some((o) => o.id === choice.model)
  const [custom, setCustom] = useState(false)
  const showCustom = custom || (!!choice.model && !known)

  return (
    <div className="ai-options">
      <div className="ai-options-row">
        <label className="ai-options-model">
          Model
          <select
            value={showCustom ? CUSTOM : choice.model}
            disabled={disabled || !choice.status?.active}
            onChange={(e) => {
              const v = e.target.value
              setCustom(v === CUSTOM)
              if (v !== CUSTOM) choice.setModel(v)
            }}
          >
            {!choice.status?.active && <option value="">Configured model</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            <option value={CUSTOM}>Other model…</option>
          </select>
        </label>
        {showCustom && (
          <input
            className="ai-options-custom"
            value={choice.model}
            disabled={disabled}
            placeholder="Model id"
            spellCheck={false}
            autoFocus={custom}
            onChange={(e) => choice.setModel(e.target.value.trim())}
          />
        )}
        <span className="grow" />
        {children}
      </div>
      <textarea
        rows={2}
        value={choice.notes}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => choice.setNotes(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
    </div>
  )
}
