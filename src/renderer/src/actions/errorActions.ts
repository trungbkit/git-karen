// Error toasts of failed git operations: a plain explanation of common errors (util/gitErrors.ts) and buttons that
// run the fix with the app's existing actions. Installed into the store's `run` when this module is imported.
import { setErrorToast, useStore, type Toast } from '../state/store'
import { describeGitError, type GitFixAction } from '../util/gitErrors'
import { pull, pullCurrent, publishCurrent, pushCurrent, stashChanges } from './refActions'

/** The fixes act on the active tab: switch to the repo that failed first. */
function focusRepo(path: string) {
  const s = useStore.getState()
  if (!s.repos[path]) return null
  if (s.activeTab !== path) s.setActiveTab(path)
  return useStore.getState().repos[path]
}

const latest = (path: string) => useStore.getState().repos[path]

const FIXES: Record<GitFixAction, (repo: string, label: string) => Promise<unknown> | void> = {
  async pullRebaseThenPush(path) {
    if (!focusRepo(path) || !(await pull('rebase'))) return
    const repo = latest(path)
    // the rebase may have stopped on a conflict: then there is nothing to push yet
    if (repo && !repo.status?.operation) await pushCurrent(repo)
  },
  pullRebase(path) {
    if (focusRepo(path)) return pull('rebase')
  },
  pushSetUpstream(path) {
    const repo = focusRepo(path)
    if (repo) return publishCurrent(repo)
  },
  openConflicts(path) {
    const repo = focusRepo(path)
    if (!repo) return
    const s = useStore.getState()
    const first = repo.status?.conflicted[0]
    if (!first) return s.toast({ kind: 'info', title: 'No conflicted files', message: 'The conflicts are resolved already.' })
    s.select({ kind: 'wip' }, path)
    if (!s.showDetailPanel) s.toggleDetailPanel()
    s.setCenter({ kind: 'conflict', path: first.path }, path)
  },
  openIdentity() {
    useStore.getState().setModal({ kind: 'preferences', section: 'identity' })
  },
  stashAndPull(path, label) {
    const repo = focusRepo(path)
    if (repo) return pullCurrent(repo, /rebase/i.test(label) ? 'rebase' : 'ff', true)
  },
  stashChanges(path) {
    if (focusRepo(path)) return stashChanges()
  }
}

/** The toast for a failed `run(label, …)` against `repo`. */
export function gitErrorToast(label: string, error: Error, repo: string): Omit<Toast, 'id'> {
  const raw = error.message
  const hint = describeGitError(raw, label)
  if (!hint) return { kind: 'error', title: `${label} failed`, message: raw }
  return {
    kind: 'error',
    title: `${label} failed`,
    message: hint.message,
    detail: raw,
    actions: hint.actions.map((a) => ({ label: a.label, run: () => void FIXES[a.id](repo, label) }))
  }
}

setErrorToast(gitErrorToast)
