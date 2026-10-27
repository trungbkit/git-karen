// Imperative prompt/confirm dialogs: `await prompt({...})` from anywhere (event handlers, context menus).
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { Modal } from './Modal'

interface PromptField {
  name: string
  label: string
  initial?: string
  placeholder?: string
  multiline?: boolean
  /** Return an error message to block submission */
  validate?(value: string): string | null
}

interface PromptCheckbox {
  name: string
  label: string
  initial?: boolean
}

/** One consequence of the action, listed in the dialog */
export interface ImpactLine {
  text: string
  tone?: 'danger' | 'muted'
}

interface PromptOptions {
  title: string
  message?: string
  /** Consequences, computed while the dialog is open; confirming waits until they are known */
  impact?: Promise<ImpactLine[]>
  fields?: PromptField[]
  checkboxes?: PromptCheckbox[]
  confirmLabel?: string
  danger?: boolean
}

export type PromptResult = Record<string, string> & { checks: Record<string, boolean> }

interface Pending extends PromptOptions {
  resolve(value: PromptResult | null): void
}

const useDialogs = create<{ pending: Pending | null }>(() => ({ pending: null }))

/** Show a dialog with optional text fields and checkboxes. Resolves to null when cancelled. */
export function prompt(opts: PromptOptions): Promise<PromptResult | null> {
  return new Promise((resolve) => useDialogs.setState({ pending: { ...opts, resolve } }))
}

/** Yes/no confirmation. */
export async function confirm(
  title: string,
  message?: string,
  opts: { confirmLabel?: string; danger?: boolean; impact?: Promise<ImpactLine[]> } = {}
): Promise<boolean> {
  return (await prompt({ title, message, ...opts })) !== null
}

export function DialogHost() {
  const pending = useDialogs((s) => s.pending)
  if (!pending) return null
  return <PromptDialog key={pending.title + (pending.message ?? '')} pending={pending} />
}

function PromptDialog({ pending }: { pending: Pending }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((pending.fields ?? []).map((f) => [f.name, f.initial ?? '']))
  )
  const [checks, setChecks] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((pending.checkboxes ?? []).map((c) => [c.name, c.initial ?? false]))
  )
  const impact = useImpact(pending.impact)
  const errors = (pending.fields ?? []).map((f) => f.validate?.(values[f.name]) ?? null)
  const invalid = errors.some(Boolean) || impact === 'loading'

  const close = (result: PromptResult | null) => {
    useDialogs.setState({ pending: null })
    pending.resolve(result)
  }
  const submit = () => {
    if (!invalid) close({ ...values, checks } as PromptResult)
  }

  return (
    <Modal
      title={pending.title}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className={`btn ${pending.danger ? 'danger' : 'primary'}`} disabled={invalid} onClick={submit}>
            {pending.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      {pending.message && <div style={{ whiteSpace: 'pre-wrap' }}>{pending.message}</div>}
      {impact && (
        <div className="impact" aria-busy={impact === 'loading'}>
          {impact === 'loading' ? (
            <>
              <div className="skeleton" style={{ width: '70%' }} />
              <div className="skeleton" style={{ width: '45%' }} />
            </>
          ) : (
            impact.map((l, i) => (
              <div key={i} className={`impact-line ${l.tone ?? ''}`}>
                {l.text}
              </div>
            ))
          )}
        </div>
      )}
      {(pending.fields ?? []).map((f, i) => (
        <div className="field" key={f.name}>
          <label htmlFor={`prompt-${f.name}`}>{f.label}</label>
          {f.multiline ? (
            <textarea
              id={`prompt-${f.name}`}
              rows={4}
              autoFocus={i === 0}
              value={values[f.name]}
              placeholder={f.placeholder}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          ) : (
            <input
              id={`prompt-${f.name}`}
              autoFocus={i === 0}
              value={values[f.name]}
              placeholder={f.placeholder}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          )}
          {errors[i] && values[f.name] !== '' && (
            <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
              {errors[i]}
            </span>
          )}
        </div>
      ))}
      {(pending.checkboxes ?? []).map((c) => (
        <label className="check" key={c.name}>
          <input type="checkbox" checked={checks[c.name]} onChange={(e) => setChecks({ ...checks, [c.name]: e.target.checked })} />
          {c.label}
        </label>
      ))}
    </Modal>
  )
}

/** 'loading' until the impact promise settles; a failure becomes a line instead of blocking the dialog. */
function useImpact(promise: Promise<ImpactLine[]> | undefined): ImpactLine[] | 'loading' | null {
  const [state, setState] = useState<ImpactLine[] | 'loading' | null>(promise ? 'loading' : null)
  useEffect(() => {
    if (!promise) return
    let live = true
    promise.then(
      (lines) => live && setState(lines),
      (e: Error) => live && setState([{ text: `Could not work out the consequences: ${e.message}`, tone: 'muted' }])
    )
    return () => {
      live = false
    }
  }, [promise])
  return state
}

/** Validates a git ref name (subset of git check-ref-format rules). */
export function validateRefName(name: string): string | null {
  if (!name.trim()) return 'Name is required'
  if (/[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^\.|\/\.|\.$/.test(name)) return 'Invalid ref name'
  return null
}
