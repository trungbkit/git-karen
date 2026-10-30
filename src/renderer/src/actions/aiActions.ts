// Entry points of the AI view: summarizing commits and reviewing a pull request.
import type { PullRequest } from '@shared/integrations'
import { useStore, type RepoTab } from '../state/store'

/** Open the AI summary of `shas`, oldest first (repo.commits is newest first). */
export function summarizeWithAi(repo: RepoTab, shas: string[]) {
  const index = new Map(repo.commits.map((c, i) => [c.sha, i]))
  const ordered = [...shas].sort((a, b) => (index.get(b) ?? 0) - (index.get(a) ?? 0))
  useStore.getState().setCenter({ kind: 'ai', task: { kind: 'summary', shas: ordered } }, repo.path)
}

export function reviewWithAi(repo: RepoTab, pr: PullRequest) {
  useStore.getState().setCenter({ kind: 'ai', task: { kind: 'review', pr } }, repo.path)
}
