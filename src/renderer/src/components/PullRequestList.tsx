// "Pull requests" section of the left panel (plan 07.2): mine, waiting for my review, and all open, from the hosting
// API with the user's token. Shown only for repos on GitHub or GitLab.
import type { MouseEvent, ReactNode } from 'react'
import type { PullRequest } from '@shared/integrations'
import type { RepoTab } from '../state/store'
import { usePullRequests, useRepoHosting, useHosting } from '../state/hosting'
import { checkoutPullRequest, openCreatePullRequest, openIntegrationsSettings, pullRequestMenuItems, revealPullRequest } from '../actions/hostingActions'
import { showContextMenu } from '../ui/ContextMenu'
import { Icon } from '../ui/Icon'
import { fuzzyMatch } from '../util/fuzzy'
import { relativeTime } from '../util/format'
import { CiIcon } from '../graph/CiBadge'
import '../styles/hosting.css'

const GROUPS = [
  { key: 'pr:mine', label: 'Mine', pick: (p: PullRequest) => p.mine },
  { key: 'pr:review', label: 'Waiting for my review', pick: (p: PullRequest) => p.reviewRequested },
  { key: 'pr:all', label: 'All open', pick: () => true }
]

interface Props {
  repo: RepoTab
  filter: string
  isCollapsed(key: string): boolean
  onToggle(key: string): void
}

export function PullRequestsSection({ repo, filter, isCollapsed, onToggle }: Props) {
  const collapsed = isCollapsed('pullRequests')
  const info = useRepoHosting(repo.path)
  const state = usePullRequests(repo.path, !collapsed)
  if (!info?.apiSupported) return null

  const f = filter.trim()
  const items = (state?.list?.items ?? []).filter((p) => !f || fuzzyMatch(f, `#${p.number} ${p.title} ${p.author} ${p.headBranch}`) !== null)
  const count = state?.list?.items.length ?? 0

  let body: ReactNode
  if (!info.connected) {
    body = (
      <div className="lp-pr-msg">
        <span>Add a {info.label} token to list pull requests for {info.path}.</span>
        <button className="btn small" onClick={openIntegrationsSettings}>
          Connect {info.label}…
        </button>
      </div>
    )
  } else if (!state?.list) {
    body = state?.error ? (
      <div className="lp-pr-msg error">
        <span>{state.error}</span>
        <button className="btn small" onClick={() => void useHosting.getState().loadPrs(repo.path)}>
          Retry
        </button>
      </div>
    ) : (
      <div className="lp-pr-msg">Loading…</div>
    )
  } else {
    body = (
      <>
        {state.error && <div className="lp-pr-msg error">{state.error}</div>}
        {GROUPS.map((g) => {
          const prs = items.filter(g.pick)
          if (g.key !== 'pr:all' && prs.length === 0) return null
          const open = f ? true : !isCollapsed(g.key)
          return (
            <div key={g.key}>
              <div className="lp-row lp-folder" role="treeitem" aria-expanded={open} style={{ paddingLeft: 10 }} onClick={() => onToggle(g.key)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
                <span className="ellipsis">{g.label}</span>
                <span className="lp-count">{prs.length}</span>
              </div>
              {open && prs.map((pr) => <PullRequestRow key={`${g.key}:${pr.number}`} repo={repo} pr={pr} />)}
              {open && prs.length === 0 && <div className="lp-empty">{f ? 'No match' : 'No open pull requests'}</div>}
            </div>
          )
        })}
      </>
    )
  }

  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div className="lp-section">
      <div className="lp-section-header" role="treeitem" aria-expanded={!collapsed} onClick={() => onToggle('pullRequests')}>
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={11} />
        <Icon name="pull-request" size={13} />
        <span className="lp-section-title">{info.kind === 'gitlab' ? 'Merge requests' : 'Pull requests'}</span>
        <span className="lp-count">{count || ''}</span>
        {info.connected && (
          <button className="icon-btn lp-add" title="Refresh" aria-label="Refresh pull requests" onClick={stop(() => void useHosting.getState().loadPrs(repo.path))}>
            <Icon name="refresh" size={12} className={state?.loading ? 'spin' : undefined} />
          </button>
        )}
        <button className="icon-btn lp-add" title="Create pull request" aria-label="Create pull request" onClick={stop(() => openCreatePullRequest())}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {!collapsed && <div className="lp-section-body">{body}</div>}
    </div>
  )
}

function PullRequestRow({ repo, pr }: { repo: RepoTab; pr: PullRequest }) {
  const updated = Date.parse(pr.updatedAt)
  const tip = [
    `#${pr.number} ${pr.title}`,
    `${pr.headRepo && !pr.sameRepo ? `${pr.headRepo}:` : ''}${pr.headBranch} → ${pr.baseBranch}`,
    `by ${pr.author}${Number.isNaN(updated) ? '' : `, updated ${relativeTime(updated)}`}`,
    pr.reviewers.length ? `Reviewers: ${pr.reviewers.join(', ')}` : '',
    'Double-click to check out'
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div
      className="lp-row lp-pr"
      role="treeitem"
      aria-label={`#${pr.number} ${pr.title}, by ${pr.author}${pr.draft ? ', draft' : ''}${pr.checks ? `, checks ${pr.checks}` : ''}`}
      style={{ paddingLeft: 24 }}
      title={tip}
      onClick={() => revealPullRequest(repo, pr)}
      onDoubleClick={() => void checkoutPullRequest(repo, pr)}
      onContextMenu={(e) => showContextMenu(e, pullRequestMenuItems(repo, pr))}
    >
      {pr.checks ? <CiIcon state={pr.checks} /> : <Icon name="pull-request" size={13} />}
      <span className="lp-pr-num">#{pr.number}</span>
      <span className="ellipsis lp-name">{pr.title}</span>
      {pr.draft && <span className="lp-pr-draft">draft</span>}
      <span className="lp-pr-author">{pr.author}</span>
    </div>
  )
}
