// Paging of the graph's history. The log is always loaded from the newest commit with a growing limit (`git log
// -n <limit>`) rather than fetching the next page with `--skip`: history can change between two loads (a commit, a
// fetch, a rebase), and a skipped page would then repeat or miss commits, needing de-duplication by sha and still
// leaving gaps. Reloading from the top is one git call, always consistent with the refs, and measured fast enough:
// laying out 20,000 commits takes about 13 ms (Node), so the cost is git's and the IPC's, linear in what is shown.

/** Commits the next log load asks for: the first page (`prefs.commitLimit`), or more once the user scrolled. */
export function logLimit(pageSize: number, requested: number | undefined): number {
  return Math.max(pageSize, requested ?? 0)
}

/** The limit that loads one more page after what is loaded now. */
export function nextPageLimit(pageSize: number, requested: number | undefined): number {
  return logLimit(pageSize, requested) + pageSize
}

/** git returned fewer commits than asked for: every commit reachable from the refs is loaded. */
export function reachedEnd(returned: number, requested: number): boolean {
  return returned < requested
}

/** Most commits loaded while looking for one that is not in the graph yet (the highest `commitLimit` allowed). */
export const REVEAL_CAP = 100_000

/**
 * Limits to load, one after the other, while looking for a commit older than those loaded: doubling, so a commit
 * far back takes a few loads rather than one per page, and never past `cap`.
 */
export function revealLimits(current: number, pageSize: number, cap = REVEAL_CAP): number[] {
  const out: number[] = []
  let limit = current
  while (limit < cap) {
    limit = Math.min(cap, Math.max(limit * 2, limit + pageSize))
    out.push(limit)
  }
  return out
}

/** Rows from the end of the graph at which the next page starts loading, so it is usually there before it is seen. */
export const LOAD_AHEAD_ROWS = 200

export interface LoadMoreState {
  /** Index just past the last row on screen */
  lastVisible: number
  rowCount: number
  complete: boolean
  loading: boolean
  /** Row count when the previous page was asked for: no new row since (all hidden by a filter) stops the scrolling trigger */
  rowsAtLastLoad: number | null
}

/** Whether scrolling near the end of the graph should load the next page. */
export function shouldLoadMore(s: LoadMoreState): boolean {
  if (s.complete || s.loading || s.rowCount === 0) return false
  if (s.rowsAtLastLoad !== null && s.rowCount <= s.rowsAtLastLoad) return false
  return s.lastVisible >= s.rowCount - LOAD_AHEAD_ROWS
}
