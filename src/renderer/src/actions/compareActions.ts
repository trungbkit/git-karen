// Comparing two commits or branches: the default branch to compare against, and the menu entries that open the compare view.
import type { Ref } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import type { MenuItem } from '../ui/ContextMenu'
import { currentBranch, remoteBranchName } from './refActions'

const FALLBACK_DEFAULTS = ['main', 'master', 'develop', 'trunk']

export function openCompare(from: string, to: string, repo?: string) {
  useStore.getState().setCenter({ kind: 'compare', from, to }, repo)
}

/**
 * The repo's default branch: the one origin's HEAD points at (its local branch when there is one),
 * else the first of the preferred default name, main, master, develop or trunk that exists.
 */
export function defaultBranch(repo: RepoTab): string | null {
  const remotes = repo.refs.filter((r) => r.type === 'remote')
  const locals = new Set(repo.refs.filter((r) => r.type === 'local').map((r) => r.name))
  const origin = repo.remotes.find((r) => r.name === 'origin')?.name ?? repo.remotes[0]?.name
  const remoteDefault = remotes.find((r) => r.isDefault && r.remote === origin) ?? remotes.find((r) => r.isDefault)
  if (remoteDefault) {
    const name = remoteBranchName(remoteDefault)
    return locals.has(name) ? name : remoteDefault.name
  }
  const names = [useStore.getState().prefs.defaultBranchName, ...FALLBACK_DEFAULTS].filter(Boolean)
  for (const n of names) if (locals.has(n)) return n
  for (const n of names) {
    const remote = remotes.find((r) => r.name === `${origin}/${n}`)
    if (remote) return remote.name
  }
  return null
}

/** "Compare with <default branch>" and "Compare with <current branch>" for a branch or tag. */
export function compareRefMenuItems(repo: RepoTab, ref: Ref): MenuItem[] {
  const def = defaultBranch(repo)
  const current = currentBranch(repo)
  const items: MenuItem[] = []
  if (def && def !== ref.name) items.push({ label: `Compare with ${def}`, onClick: () => openCompare(def, ref.name) })
  if (current && current !== def && current !== ref.name) items.push({ label: `Compare with ${current}`, onClick: () => openCompare(current, ref.name) })
  return items
}

/** Two selected commits, oldest first (repo.commits is newest first). */
export function orderedPair(repo: RepoTab, shas: string[]): [string, string] | null {
  if (shas.length !== 2) return null
  const index = new Map(repo.commits.map((c, i) => [c.sha, i]))
  const [a, b] = shas
  return (index.get(a) ?? 0) >= (index.get(b) ?? 0) ? [a, b] : [b, a]
}
