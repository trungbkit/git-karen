// Grey placeholder rows shown while the graph or a diff loads. They appear only after a short delay so fast loads
// do not flicker; the shimmer stops under prefers-reduced-motion (styles/app.css).
import { useEffect, useState } from 'react'

/** Loads shorter than this show nothing at all. */
export const SKELETON_DELAY = 150

/** True once `active` has stayed true for `delay` ms. */
export function useDelayed(active: boolean, delay = SKELETON_DELAY): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) return setShown(false)
    const t = setTimeout(() => setShown(true), delay)
    return () => clearTimeout(t)
  }, [active, delay])
  return active && shown
}

// fixed "random" widths so the placeholder does not jump between renders
const WIDTHS = [62, 45, 78, 38, 55, 70, 30, 66, 50, 42, 74, 35, 58, 48, 68, 40]

/** Placeholder graph rows: a node and a message bar each, `label` for screen readers. */
export function GraphSkeleton({ rows = 16, label = 'Loading history' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-rows" role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton round" style={{ width: 14, height: 14, marginLeft: 16 + (i % 3) * 14 }} />
          <span className="skeleton" style={{ width: `${WIDTHS[i % WIDTHS.length] * 0.6}%` }} />
          <span className="skeleton" style={{ width: 70, marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  )
}

/** Placeholder diff: a hunk header and code lines of varying length. */
export function DiffSkeleton({ lines = 14, label = 'Loading diff' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton-diff" role="status" aria-label={label} aria-busy="true">
      <span className="skeleton" style={{ width: '35%', height: 14 }} />
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${WIDTHS[(i * 5) % WIDTHS.length]}%`, marginLeft: (i % 4) * 16 }} />
      ))}
    </div>
  )
}

/** The graph skeleton once loading has taken longer than SKELETON_DELAY. */
export function DelayedGraphSkeleton({ loading }: { loading: boolean }) {
  return useDelayed(loading) ? <GraphSkeleton /> : null
}

/** The diff skeleton once loading has taken longer than SKELETON_DELAY. */
export function DelayedDiffSkeleton({ label }: { label?: string }) {
  return useDelayed(true) ? <DiffSkeleton label={label} /> : null
}
