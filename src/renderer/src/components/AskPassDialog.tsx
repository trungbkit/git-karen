// Asks the user what git or ssh needs to reach a remote: a username, password, key passphrase or whether to trust a
// server's host key. The typed value goes straight to the backend; it is not kept in any store.
import { useState } from 'react'
import type { AskPassPrompt } from '@shared/types'
import { answerPrompt, useAskPass } from '../state/askpass'
import { describePrompt } from '../util/askpass'
import { Modal } from '../ui/Modal'
import { basename } from '../util/format'

export function AskPassDialog() {
  const prompt = useAskPass((s) => s.queue[0])
  if (!prompt) return null
  // keyed by id: a new prompt starts with an empty field
  return <PromptForm key={prompt.id} prompt={prompt} />
}

const OPERATIONS: Record<string, string> = {
  fetch: 'Fetching',
  pull: 'Pulling',
  push: 'Pushing',
  clone: 'Cloning',
  submodule: 'Updating submodules'
}

function PromptForm({ prompt }: { prompt: AskPassPrompt }) {
  const view = describePrompt(prompt.prompt, prompt.sshPrompt)
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const cancel = () => answerPrompt(prompt.id, null)
  const submit = (answer: string) => answerPrompt(prompt.id, answer)
  const doing = OPERATIONS[prompt.operation] ?? `Running git ${prompt.operation}`
  const context = `${doing} in ${basename(prompt.repo)}`

  if (view.kind === 'hostKey' || view.kind === 'confirm' || view.kind === 'notice') {
    const hostKey = view.kind === 'hostKey'
    return (
      <Modal
        title={view.title}
        onClose={cancel}
        width={560}
        footer={
          view.kind === 'notice' ? (
            <button className="btn primary" onClick={() => submit('')}>
              OK
            </button>
          ) : (
            <>
              <button className="btn" onClick={cancel}>
                {hostKey ? 'Do not connect' : 'No'}
              </button>
              <button className="btn primary" onClick={() => submit('yes')}>
                {hostKey ? 'Trust and connect' : 'Yes'}
              </button>
            </>
          )
        }
      >
        <div className="muted modal-note">{context}</div>
        <pre className="askpass-prompt mono">{prompt.prompt.trim()}</pre>
        {hostKey && (
          <div className="muted askpass-hint">
            SSH has not connected to this server before. Compare the fingerprint with the one the host publishes before you trust it; SSH then remembers it in
            ~/.ssh/known_hosts.
          </div>
        )}
      </Modal>
    )
  }

  const hint =
    view.kind === 'password'
      ? 'Karen does not store it. To have git remember it, set up a credential helper (git config --global credential.helper).'
      : view.kind === 'passphrase'
        ? 'Karen does not store it. Add the key to ssh-agent (ssh-add) to skip this next time.'
        : null
  return (
    <Modal
      title={view.title}
      onClose={cancel}
      width={480}
      footer={
        <>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form={`askpass-${prompt.id}`}>
            {view.kind === 'username' ? 'Continue' : 'OK'}
          </button>
        </>
      }
    >
      <form
        id={`askpass-${prompt.id}`}
        onSubmit={(e) => {
          e.preventDefault()
          submit(value)
        }}
      >
        <div className="muted modal-note">{context}</div>
        <div className="field">
          <label htmlFor={`askpass-input-${prompt.id}`} className="askpass-label mono">
            {prompt.prompt.trim()}
          </label>
          <div className="askpass-input">
            <input
              id={`askpass-input-${prompt.id}`}
              autoFocus
              type={view.secret && !reveal ? 'password' : 'text'}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            {view.secret && (
              <button type="button" className="btn ghost small" onClick={() => setReveal((r) => !r)} aria-pressed={reveal}>
                {reveal ? 'Hide' : 'Show'}
              </button>
            )}
          </div>
        </div>
        {hint && <div className="muted askpass-hint">{hint}</div>}
      </form>
    </Modal>
  )
}
