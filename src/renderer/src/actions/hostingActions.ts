// Pull request actions shared by the left panel list and its context menu (plan 07.2).
import type { PullRequest, RepoHosting } from '@shared/integrations'
import { useStore, type RepoTab } from '../state/store'
import { useHosting } from '../state/hosting'
import type { MenuItem } from '../ui/ContextMenu'
import { copyText } from './refActions'
import { openCompare } from './compareActions'
import { reviewWithAi } from './aiActions'
import { scrollToSha } from '../graph/nav'

export function openCreatePullRequest(head?: string, base?: string) {
  useStore.getState().setModal({ kind: 'createPullRequest', head, base })
}

export function openIntegrationsSettings() {
  useStore.getState().setModal({ kind: 'preferences', section: 'integrations' })
}

/** The remote-tracking ref of a same-repository PR's head branch, when it has been fetched. */
function headRef(repo: RepoTab, info: RepoHosting, pr: PullRequest) {
  if (!pr.sameRepo) return undefined
  return repo.refs.find((r) => r.type === 'remote' && r.name === `${info.remote}/${pr.headBranch}`)
}

export async function checkoutPullRequest(repo: RepoTab, pr: PullRequest) {
  const info = useHosting.getState().info[repo.path]
  if (!info) return
  const s = useStore.getState()
  let branch = ''
  const ok = await s.run(
    `Checking out #${pr.number}`,
    async (r) => {
      branch = await window.integrations.checkoutPullRequest(r, info.remote, pr.number, pr.headBranch, pr.sameRepo)
    },
    { repo: repo.path }
  )
  if (ok) s.toast({ kind: 'success', title: `Checked out #${pr.number}`, message: `On ${branch}` })
}

/** Select the PR's head commit in the graph when its branch is known locally. */
export function revealPullRequest(repo: RepoTab, pr: PullRequest): boolean {
  const info = useHosting.getState().info[repo.path]
  const ref = info && headRef(repo, info, pr)
  if (!ref) return false
  const s = useStore.getState()
  if (repo.center.kind !== 'graph') s.setCenter({ kind: 'graph' })
  s.select({ kind: 'commit', shas: [ref.sha] })
  scrollToSha(ref.sha)
  return true
}

export function pullRequestMenuItems(repo: RepoTab, pr: PullRequest): MenuItem[] {
  const info = useHosting.getState().info[repo.path]
  const head = info && headRef(repo, info, pr)
  const base = info && repo.refs.find((r) => r.type === 'remote' && r.name === `${info.remote}/${pr.baseBranch}`)
  return [
    { label: `Checkout #${pr.number}`, onClick: () => void checkoutPullRequest(repo, pr) },
    { label: 'Open on web', onClick: () => void window.app.openExternal(pr.url) },
    { label: 'Review with AI', onClick: () => reviewWithAi(repo, pr) },
    !!head && { label: 'Show in graph', onClick: () => revealPullRequest(repo, pr) },
    !!head && !!base && { label: `Compare with ${base.name}`, onClick: () => openCompare(base.name, head.name) },
    'separator',
    { label: 'Copy link', onClick: () => copyText(pr.url, 'Link copied') },
    { label: 'Copy branch name', onClick: () => copyText(pr.headBranch) },
    { label: 'Refresh list', onClick: () => void useHosting.getState().loadPrs(repo.path) }
  ]
}
