// Connect an AI provider without leaving the flow that needs it: pick the provider (or paste a key and let its prefix
// pick it), check the key with a tiny request, then save it. Preferences > AI has every other setting.
import { useState } from 'react'
import type { AiCredential, AiStatus } from '@shared/types'
import { useStore } from '../state/store'
import { Icon } from '../ui/Icon'
import { AI_CREDENTIALS, credentialInfo, detectCredential, keyProblem, PROVIDER_LABELS } from '../smart/aiKeys'

/** Quick setup order: the plain API keys first, the subscription token last. */
const CHOICES: AiCredential[] = ['anthropicApiKey', 'openaiApiKey', 'geminiApiKey', 'anthropicOauthToken']

export function AiQuickSetup({ why, onConnected, onDismiss }: { why: string; onConnected(status: AiStatus): void; onDismiss?(): void }) {
  const setModal = useStore((s) => s.setModal)
  const inPreferences = useStore((s) => s.modal?.kind === 'preferences')
  const [credential, setCredential] = useState<AiCredential>('anthropicApiKey')
  const [key, setKey] = useState('')
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const info = credentialInfo(credential)
  const problem = keyProblem(credential, key)
  const checking = state.kind === 'checking'

  const onKey = (value: string) => {
    setKey(value)
    setState({ kind: 'idle' })
    // a pasted key whose prefix gives it away switches the provider
    const detected = detectCredential(value)
    if (detected) setCredential(detected)
  }

  const connect = async () => {
    const secret = key.trim()
    if (!secret || checking) return
    setState({ kind: 'checking' })
    try {
      await window.ai.verify(credential, secret)
      const { settings } = await window.ai.status()
      // a provider pinned in Preferences would otherwise keep ignoring the new key
      const provider = settings.provider === 'auto' || settings.provider === info.provider ? undefined : { provider: info.provider }
      const status = await window.ai.update(provider, { [credential]: secret })
      useStore.getState().toast({ kind: 'success', title: `${PROVIDER_LABELS[info.provider]} connected`, message: status.active ? `Using ${status.active.model}.` : undefined })
      onConnected(status)
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message })
    }
  }

  return (
    <div className="ai-setup">
      <div className="ai-setup-head">
        <Icon name="sparkle" size={13} />
        <b>Connect an AI provider</b>
        <span className="muted">{why}</span>
        <span className="grow" />
        {onDismiss && (
          <button className="icon-btn" title="Not now" aria-label="Not now" onClick={onDismiss}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      <span className="seg" role="radiogroup" aria-label="Provider">
        {CHOICES.map((id) => (
          <button
            key={id}
            role="radio"
            aria-checked={credential === id}
            className={credential === id ? 'on' : ''}
            disabled={checking}
            onClick={() => {
              setCredential(id)
              setState({ kind: 'idle' })
            }}
          >
            {AI_CREDENTIALS.find((c) => c.id === id)!.choice}
          </button>
        ))}
      </span>
      <div className="ai-secret">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={info.label}
          placeholder={`Paste your ${info.label} (${info.placeholder})`}
          value={key}
          disabled={checking}
          onChange={(e) => onKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void connect()}
        />
        <button className="btn primary small" disabled={!key.trim() || checking} onClick={() => void connect()}>
          {checking ? <span className="spinner small" /> : null} {checking ? 'Checking…' : 'Connect'}
        </button>
      </div>
      {problem && <span className="field-warning">{problem}</span>}
      {state.kind === 'error' && <span className="field-error">{state.message}</span>}
      <span className="field-hint">
        {info.keyUrl ? (
          <button className="btn ghost small smart-link" onClick={() => void window.app.openExternal(info.keyUrl!)}>
            Get a key <Icon name="external" size={11} />
          </button>
        ) : (
          info.hint
        )}{' '}
        The key is checked with a tiny request, then kept on this computer in a file only you can read. Using AI sends your diffs to {PROVIDER_LABELS[info.provider]}.
        {!inPreferences && (
          <>
            {' '}
            <button className="btn ghost small smart-link" onClick={() => setModal({ kind: 'preferences', section: 'ai' })}>
              More options
            </button>
          </>
        )}
      </span>
    </div>
  )
}
