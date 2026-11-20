// Clean up merged branches: what the dialog shows and selects, kept apart from React so it can be tested.
import type { MergedBranch, Ref, SquashCheck } from '@shared/types'
import type { BranchPullRequest } from '@shared/integrations'
import type { RepoTab } from '../state/store'
import { fuzzyMatch } from '../util/fuzzy'

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
  /** Its last closed or merged pull request, for an upstream-deleted branch whose changes are not in the base */
  pr?: BranchPullRequest
}

export const DIRTY_CURRENT = 'Commit or stash your changes before deleting the current branch'

/** Local branches tried as the base when there is no remote branch to compare with, after the preferred default name. */
const LOCAL_DEFAULTS = ['main', 'master', 'develop', 'trunk']

/** Branches to compare with: remote branches (each remote's default branch first, then by name), then local ones by name. */
export function baseCandidates(repo: Pick<RepoTab, 'refs'>): Ref[] {
  const byName = (a: Ref, b: Ref) => a.name.localeCompare(b.name)
  const remote = repo.refs.filter((r) => r.type === 'remote').sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || byName(a, b))
  return [...remote, ...repo.refs.filter((r) => r.type === 'local').sort(byName)]
}

/**
 * The remote's default branch (origin's first), else origin's main or master; without any, the local default branch:
 * `preferredLocal` (the default branch name from Preferences), then main, master, develop or trunk.
 */
export function defaultBase(repo: Pick<RepoTab, 'remotes'>, candidates: Ref[], preferredLocal?: string): string | null {
  const origin = repo.remotes.find((r) => r.name === 'origin')?.name ?? repo.remotes[0]?.name
  const remotes = candidates.filter((r) => r.type === 'remote')
  const pick =
    remotes.find((r) => r.isDefault && r.remote === origin) ??
    remotes.find((r) => r.isDefault) ??
    remotes.find((r) => r.name === `${origin}/main` || r.name === `${origin}/master`)
  if (pick) return pick.fullName
  for (const name of [preferredLocal, ...LOCAL_DEFAULTS]) {
    const local = name && candidates.find((r) => r.type === 'local' && r.name === name)
    if (local) return local.fullName
  }
  return null
}

/** A local branch as the base: nothing to fetch, and no remote branches to delete. */
export const isLocalBase = (base: string | null) => !!base?.startsWith('refs/heads/')

/** Candidates matching the filter, always keeping the chosen base so the select still shows it. */
export function filterCandidates(candidates: Ref[], query: string, keep: string | null): Ref[] {
  const q = query.trim()
  return q ? candidates.filter((r) => r.fullName === keep || fuzzyMatch(q, r.name) !== null) : candidates
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
  opts: { checking: boolean; currentBranch: string | null; dirty: number; prs?: Record<string, BranchPullRequest> }
): CleanupRow[] {
  return branches.flatMap((branch) => {
    const check = checks[branch.name]
    const status = cleanupStatus(branch, check, opts.checking)
    if (!status) return []
    const current = branch.name === opts.currentBranch
    const locked = current ? (opts.dirty > 0 ? DIRTY_CURRENT : undefined) : branch.worktree
    const pr = status === 'gone' ? opts.prs?.[branch.name] : undefined
    return [{ branch, status, current, locked, check, pr }]
  })
}

/**
 * Ticked until the user says otherwise: merged and squash merged branches, and upstream-deleted ones whose pull request
 * was merged with the commit the branch is at (anything else means commits that never reached the pull request).
 * Never the checked-out branch.
 */
export function selectedByDefault(row: CleanupRow): boolean {
  if (row.locked || row.current) return false
  return row.status === 'merged' || row.status === 'squashed' || prMergedAtTip(row)
}

export function prMergedAtTip(row: CleanupRow): boolean {
  return row.pr?.state === 'merged' && row.pr.headSha === row.branch.sha
}

/** Branches to ask the hosting provider about: upstream deleted, and their changes not found in the base. */
export function prLookups(rows: CleanupRow[]): string[] {
  return rows.filter((r) => r.status === 'gone' && r.check && !r.check.squashed).map((r) => r.branch.name)
}

export function prLabel(pr: BranchPullRequest): string {
  return pr.state === 'merged' ? `merged in #${pr.number}` : `#${pr.number} closed`
}

export function isSelected(row: CleanupRow, picked: Record<string, boolean>): boolean {
  return !row.locked && (picked[row.branch.name] ?? selectedByDefault(row))
}

/** Of the selected rows, those whose upstream can go too: it holds nothing the base lacks, or it is the squash-merged branch itself. */
export function remoteDeletions(rows: CleanupRow[]): CleanupRow[] {
  return rows.filter((r) => r.branch.upstream && (r.branch.upstreamMerged || (r.status === 'squashed' && r.branch.upstreamMatches)))
}

export interface CleanupGroup {
  key: 'merged' | 'squashed' | 'gone'
  title: string
  rows: CleanupRow[]
}

const GROUP_TITLES: [CleanupGroup['key'], string][] = [
  ['merged', 'Merged'],
  ['squashed', 'Squash merged'],
  ['gone', 'Upstream deleted']
]

/** Rows by why they count as merged (branches still being checked with the upstream-deleted ones), newest commit first. */
export function groupRows(rows: CleanupRow[]): CleanupGroup[] {
  return GROUP_TITLES.flatMap(([key, title]) => {
    const inGroup = rows
      .filter((r) => (r.status === 'checking' ? 'gone' : r.status) === key)
      .sort((a, b) => (b.branch.date ?? 0) - (a.branch.date ?? 0) || a.branch.name.localeCompare(b.branch.name))
    return inGroup.length ? [{ key, title, rows: inGroup }] : []
  })
}

/** The tri-state of a group's checkbox, over the rows that can be selected. */
export function groupSelection(rows: CleanupRow[], picked: Record<string, boolean>): 'all' | 'none' | 'some' {
  const open = rows.filter((r) => !r.locked)
  const on = open.filter((r) => isSelected(r, picked)).length
  return on === 0 ? 'none' : on === open.length ? 'all' : 'some'
}

/** Choices for every unlocked row from `from` to `to` (either order) of the rows as shown; empty when either is gone. */
export function rangeChoices(shown: CleanupRow[], from: string, to: string, on: boolean): Record<string, boolean> {
  const a = shown.findIndex((r) => r.branch.name === from)
  const b = shown.findIndex((r) => r.branch.name === to)
  if (a < 0 || b < 0) return {}
  const range = shown.slice(Math.min(a, b), Math.max(a, b) + 1).filter((r) => !r.locked)
  return Object.fromEntries(range.map((r) => [r.branch.name, on]))
}

/** Branches the "to clean up" badge counts: merged or upstream deleted, and not checked out anywhere. */
export function hintNames(branches: MergedBranch[]): string[] {
  return branches.filter((b) => (b.reason === 'merged' || b.reason === 'gone') && !b.worktree).map((b) => b.name)
}

/** The badge only counts branches the dialog has not shown yet, so branches the user chose to keep do not keep it up. */
export function hintCount(names: string[] | undefined, seen: string[] | undefined): number {
  const shown = new Set(seen)
  return (names ?? []).filter((n) => !shown.has(n)).length
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
