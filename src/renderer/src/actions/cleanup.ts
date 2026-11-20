// Clean up merged branches: what the dialog shows and selects, kept apart from React so it can be tested.
import type { MergedBranch, Ref, SquashCheck } from '@shared/types'
import type { RepoTab } from '../state/store'

/** Branches sent to one squash check, so results show up while the rest are still being checked. */
export const SQUASH_BATCH = 8

/** What is known about a listed branch: merged, squash merged, upstream deleted with work not in the base, or not known yet. */
export type CleanupStatus = 'merged' | 'squashed' | 'gone' | 'checking'

export interface CleanupRow {
  branch: MergedBranch
  status: CleanupStatus
  /** The branch checked out in this worktree */
  current: boolean
  /** Why it cannot be selected */
  locked?: string
  check?: SquashCheck
}

export const DIRTY_CURRENT = 'Commit or stash your changes before deleting the current branch'

/** Remote branches to compare with: each remote's default branch first, then the rest by name. */
export function baseCandidates(repo: RepoTab): Ref[] {
  return repo.refs
    .filter((r) => r.type === 'remote')
    .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name))
}

export function defaultBase(repo: RepoTab, candidates: Ref[]): string | null {
  const origin = repo.remotes.find((r) => r.name === 'origin')?.name ?? repo.remotes[0]?.name
  const pick =
    candidates.find((r) => r.isDefault && r.remote === origin) ??
    candidates.find((r) => r.isDefault) ??
    candidates.find((r) => r.name === `${origin}/main` || r.name === `${origin}/master`)
  return pick?.fullName ?? null
}

/** The remote an upstream such as "refs/remotes/origin/feature/x" belongs to, and its branch name there. */
export function splitUpstream(repo: Pick<RepoTab, 'remotes'>, upstream: string): { remote: string; branch: string } | null {
  const short = upstream.replace(/^refs\/remotes\//, '')
  const remote = repo.remotes
    .map((r) => r.name)
    .filter((r) => short.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0]
  return remote ? { remote, branch: short.slice(remote.length + 1) } : null
}

/** What the dialog shows for a branch, or null to leave it out (not merged as far as anyone can tell). */
export function cleanupStatus(b: MergedBranch, check: SquashCheck | undefined, checking: boolean): CleanupStatus | null {
  if (b.reason === 'merged') return 'merged'
  if (check?.squashed) return 'squashed'
  if (b.reason === 'gone') return check || !checking ? 'gone' : 'checking'
  return null
}

/** The listed branches in scan order. `dirty` is the number of tracked files with uncommitted changes. */
export function cleanupRows(
  branches: MergedBranch[],
  checks: Record<string, SquashCheck>,
  opts: { checking: boolean; currentBranch: string | null; dirty: number }
): CleanupRow[] {
  return branches.flatMap((branch) => {
    const check = checks[branch.name]
    const status = cleanupStatus(branch, check, opts.checking)
    if (!status) return []
    const current = branch.name === opts.currentBranch
    const locked = current ? (opts.dirty > 0 ? DIRTY_CURRENT : undefined) : branch.worktree
    return [{ branch, status, current, locked, check }]
  })
}

/** Ticked until the user says otherwise: merged and squash merged branches, but never the checked-out one. */
export function selectedByDefault(row: CleanupRow): boolean {
  return !row.locked && !row.current && (row.status === 'merged' || row.status === 'squashed')
}

export function isSelected(row: CleanupRow, picked: Record<string, boolean>): boolean {
  return !row.locked && (picked[row.branch.name] ?? selectedByDefault(row))
}

/** Of the selected rows, those whose upstream can go too: it holds nothing the base lacks, or it is the squash-merged branch itself. */
export function remoteDeletions(rows: CleanupRow[]): CleanupRow[] {
  return rows.filter((r) => r.branch.upstream && (r.branch.upstreamMerged || (r.status === 'squashed' && r.branch.upstreamMatches)))
}

/** Branch names to check for squash merges, upstream-deleted ones first, in batches. */
export function squashBatches(branches: MergedBranch[], size = SQUASH_BATCH): string[][] {
  const names = [...branches.filter((b) => b.reason === 'gone'), ...branches.filter((b) => b.reason === 'unknown')].map((b) => b.name)
  const res: string[][] = []
  for (let i = 0; i < names.length; i += size) res.push(names.slice(i, i + size))
  return res
}

/**
 * Where to go before deleting the checked-out branch: the local branch tracking the base, else the local branch named
 * like it ("main" for "origin/main"), else a new tracking branch for the base (`remoteRef`).
 */
export function checkoutTarget(repo: Pick<RepoTab, 'refs' | 'remotes'>, base: string): { name: string; remoteRef?: string } {
  if (base.startsWith('refs/heads/')) return { name: base.slice('refs/heads/'.length) }
  const locals = repo.refs.filter((r) => r.type === 'local')
  const tracking = locals.find((r) => r.upstream === base)
  if (tracking) return { name: tracking.name }
  const name = splitUpstream(repo, base)?.branch ?? base.replace(/^refs\/remotes\//, '')
  return locals.some((r) => r.name === name) ? { name } : { name, remoteRef: base }
}

// Squash checks by repo, base commit and branch commit: the answer cannot change while neither moves, so reopening
// the dialog or switching between bases does not run them again.
const squashCache = new Map<string, SquashCheck>()
const SQUASH_CACHE_SIZE = 2000
const cacheKey = (repo: string, baseSha: string, sha: string) => `${repo}\n${baseSha}\n${sha}`

export function cachedChecks(repo: string, baseSha: string | undefined, branches: MergedBranch[]): Record<string, SquashCheck> {
  if (!baseSha) return {}
  const res: Record<string, SquashCheck> = {}
  for (const b of branches) {
    const hit = squashCache.get(cacheKey(repo, baseSha, b.sha))
    if (hit) res[b.name] = { ...hit, name: b.name }
  }
  return res
}

export function rememberChecks(repo: string, baseSha: string | undefined, branches: MergedBranch[], checks: SquashCheck[]) {
  if (!baseSha) return
  for (const c of checks) {
    const b = branches.find((x) => x.name === c.name)
    if (b) squashCache.set(cacheKey(repo, baseSha, b.sha), c)
  }
  // oldest first: drop what earlier bases and branch tips left behind
  for (const key of squashCache.keys()) {
    if (squashCache.size <= SQUASH_CACHE_SIZE) break
    squashCache.delete(key)
  }
}
