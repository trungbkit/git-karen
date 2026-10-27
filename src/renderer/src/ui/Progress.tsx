// Progress bar and the "Pushing… Writing objects 45%" readout of a repo's running git operation.
import { useProgress } from '../state/progress'
import type { OperationProgress } from '../util/progress'

/** `value` null shows an indeterminate bar. */
export function ProgressBar({ value, label, className = '' }: { value: number | null; label: string; className?: string }) {
  return (
    <span
      className={`progress-bar ${className}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
    >
      <span className={`progress-fill ${value === null ? 'indeterminate' : ''}`} style={value === null ? undefined : { width: `${value}%` }} />
    </span>
  )
}

/** "Receiving objects 45%" (phase and its percentage), or the latest message. */
export function progressText(p: OperationProgress): string {
  return p.percent === null ? p.label : `${p.label} ${p.percent}%`
}

/** The busy label of a repo with a bar and the current phase while git reports progress, a spinner otherwise. */
export function BusyProgress({ repo, busy }: { repo: string; busy: string }) {
  const p = useProgress((s) => s[repo])
  if (!p) {
    return (
      <>
        <span className="spinner small" /> {busy}…
      </>
    )
  }
  return (
    <span className="busy-progress" title={p.detail ? `${progressText(p)} · ${p.detail}` : progressText(p)}>
      <ProgressBar value={p.overall} label={busy} />
      <span>
        {busy}…{p.overall !== null && ` ${p.overall}%`}
      </span>
      <span className="muted ellipsis busy-phase">{progressText(p)}</span>
    </span>
  )
}
