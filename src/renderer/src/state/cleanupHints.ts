// The "to clean up" badge on the left panel's Local section: branches a quick scan against the default base found
// merged or with their upstream deleted, less those the cleanup dialog already showed. Kept in memory only.
import { create } from 'zustand'
import { useStore } from './store'
import { baseCandidates, defaultBase, hintCount, hintNames } from '../actions/cleanup'
import { parseBranchList } from '../smart/text'

interface CleanupHints {
  /** Branches that may be cleaned up, from the last quick scan, by repo path */
  names: Record<string, string[]>
  /** Branches the cleanup dialog showed when it was last closed, by repo path */
  seen: Record<string, string[]>
}

export const useCleanupHints = create<CleanupHints>(() => ({ names: {}, seen: {} }))

/** Rescan with the default base; quietly keeps the last result when that fails. */
export async function refreshCleanupHint(path: string) {
  const { repos, prefs } = useStore.getState()
  const repo = repos[path]
  const base = repo && defaultBase(repo, baseCandidates(repo), prefs.defaultBranchName)
  if (!base) return
  try {
    const branches = await window.git.mergedBranches(path, base, { protected: parseBranchList(prefs.protectedBranches) })
    useCleanupHints.setState((s) => ({ names: { ...s.names, [path]: hintNames(branches) } }))
  } catch {
    // a hint is not worth an error toast
  }
}

export function markCleanupSeen(path: string, names: string[]) {
  useCleanupHints.setState((s) => ({ seen: { ...s.seen, [path]: names } }))
}

export function useCleanupHintCount(path: string): number {
  return useCleanupHints((s) => hintCount(s.names[path], s.seen[path]))
}
