// Lazily loaded per-commit change stats for the graph's Changes column.
import { useEffect, useMemo, useReducer } from 'react'
import type { CommitStats } from '@shared/types'

const cache = new Map<string, Map<string, CommitStats>>()
const inflight = new Map<string, Set<string>>()

function repoCache(repo: string): Map<string, CommitStats> {
  let c = cache.get(repo)
  if (!c) cache.set(repo, (c = new Map()))
  return c
}

/**
 * Returns the stats known so far for the repo, fetching `shas` that are missing (batched, after a
 * short debounce so fast scrolling doesn't flood git).
 */
export function useCommitStats(repo: string, shas: string[], enabled: boolean): { stats: Map<string, CommitStats>; version: number } {
  const [version, bump] = useReducer((n: number) => n + 1, 0)
  const key = shas.join(',')
  useEffect(() => {
    if (!enabled) return
    const known = repoCache(repo)
    const busy = inflight.get(repo) ?? new Set<string>()
    inflight.set(repo, busy)
    const missing = shas.filter((s) => !known.has(s) && !busy.has(s))
    if (missing.length === 0) return
    const timer = setTimeout(() => {
      missing.forEach((s) => busy.add(s))
      window.git
        .commitStats(repo, missing)
        .then((res) => {
          for (const [sha, st] of Object.entries(res)) known.set(sha, st)
          // Commits git returned nothing for (e.g. empty) count as zero so they aren't refetched.
          for (const s of missing) if (!known.has(s)) known.set(s, { additions: 0, deletions: 0, files: 0 })
          bump()
        })
        .catch(() => undefined)
        .finally(() => missing.forEach((s) => busy.delete(s)))
    }, 120)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, key, enabled])
  return { stats: repoCache(repo), version }
}

/**
 * Upper bound used to scale change bars: ignores outliers (Tukey fence over the loaded stats)
 * so one huge commit doesn't flatten every other bar.
 */
export function useStatsScale(stats: Map<string, CommitStats>, version: number): number {
  return useMemo(() => {
    const totals = [...stats.values()].map((s) => s.additions + s.deletions).sort((a, b) => a - b)
    if (totals.length === 0) return 1
    if (totals.length < 4) return Math.max(1, totals[totals.length - 1])
    const q = (p: number) => totals[Math.floor(p * (totals.length - 1))]
    const iqr = q(0.75) - q(0.25)
    return Math.max(1, Math.min(totals[totals.length - 1], q(0.5) + 1.5 * iqr))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, version])
}
