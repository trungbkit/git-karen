// The toolbar's view of a repo's running git operation: a pill with the operation's icon, label, percentage and
// elapsed time (then a short "Done" once it succeeds), and a thin progress line along the toolbar's bottom edge.
import { useEffect, useState } from 'react'
import type { RepoTab } from '../state/store'
import { useProgress } from '../state/progress'
import { busyIcon, busyKind, formatElapsed } from '../util/busyKind'
import { Icon } from './Icon'
import { progressText } from './Progress'

/** Operations quicker than this get no "Done" (staging a file should not blink the toolbar). */
const DONE_MIN_MS = 700
const DONE_SHOW_MS = 1600
/** The elapsed time shows once an operation has run this long. */
const ELAPSED_AFTER_MS = 3000

/** Re-render every second while `since` is set; returns the time elapsed since it. */
function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])
  return since ? Math.max(0, now - since) : 0
}

/** True for a short while after a successful, not-instant operation ended. */
function useRecentlyDone(repo: RepoTab): boolean {
  const last = repo.lastRun
  const fresh = !repo.busy && !!last && last.ok && last.ms >= DONE_MIN_MS && Date.now() - last.at < DONE_SHOW_MS
  const [, tick] = useState(0)
  useEffect(() => {
    if (!fresh || !last) return
    const id = setTimeout(() => tick((n) => n + 1), Math.max(0, DONE_SHOW_MS - (Date.now() - last.at)))
    return () => clearTimeout(id)
  }, [fresh, last])
  return fresh
}

export function BusyPill({ repo }: { repo: RepoTab }) {
  const busy = repo.busy
  const p = useProgress((s) => (busy ? s[repo.path] : undefined))
  const elapsed = useElapsed(busy ? repo.busySince : undefined)
  const done = useRecentlyDone(repo)

  if (!busy) {
    if (!done || !repo.lastRun) return null
    return (
      <span className="busy-pill done" role="status" title={`${repo.lastRun.label}: done`}>
        <span className="busy-pill-icon">
          <Icon name="check" size={13} />
        </span>
        <span className="busy-pill-label">Done</span>
      </span>
    )
  }

  const kind = busyKind(busy)
  const phase = p ? progressText(p) : null
  const title = [busy, phase, p?.detail, elapsed >= ELAPSED_AFTER_MS ? `running for ${formatElapsed(elapsed)}` : null].filter(Boolean).join(' · ')
  return (
    <span className={`busy-pill kind-${kind}`} role="status" aria-live="polite" title={title}>
      <span className="busy-pill-icon">
        <span className="busy-ring" />
        <Icon name={busyIcon(kind)} size={11} />
      </span>
      <span className="busy-pill-text">
        <span className="busy-pill-label ellipsis">
          {busy}…{p?.overall != null && <b className="busy-pill-pct"> {p.overall}%</b>}
        </span>
        {(phase || elapsed >= ELAPSED_AFTER_MS) && (
          <span className="busy-pill-sub ellipsis">
            {phase}
            {phase && elapsed >= ELAPSED_AFTER_MS && ' · '}
            {elapsed >= ELAPSED_AFTER_MS && formatElapsed(elapsed)}
          </span>
        )}
      </span>
    </span>
  )
}

/** A 2px line under the toolbar: the operation's overall percentage, or a sliding segment when git reports none. */
export function BusyStrip({ repo }: { repo: RepoTab }) {
  const busy = repo.busy
  const overall = useProgress((s) => (busy ? (s[repo.path]?.overall ?? null) : null))
  if (!busy) return null
  return (
    <span className="busy-strip" aria-hidden>
      <span className={`busy-strip-fill ${overall === null ? 'indeterminate' : ''}`} style={overall === null ? undefined : { width: `${overall}%` }} />
    </span>
  )
}
