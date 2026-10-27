// Thin banner above the graph when a fetch brought new commits to the checked-out branch's upstream.
import { useEffect } from 'react'
import type { RepoTab } from '../state/store'
import { dismissBehindNotice, useBehindNotices } from '../state/autoFetch'
import { pullCurrent, trackedChanges, type PullMode } from '../actions/refActions'
import { Icon } from '../ui/Icon'

export function BehindBanner({ repo }: { repo: RepoTab }) {
  const notice = useBehindNotices((s) => s[repo.path])
  const st = repo.status
  // still the same branch and upstream, and still behind (a pull elsewhere or a checkout ends it)
  const live = !!notice && !!st && st.branch === notice.branch && st.upstream === notice.upstream && st.behind > 0
  useEffect(() => {
    if (notice && st && !live) dismissBehindNotice(repo.path)
  }, [notice, st, live, repo.path])
  if (!live || !notice || !st) return null

  const dirty = trackedChanges(repo) > 0
  const busy = !!repo.busy
  const run = (mode: PullMode) => void pullCurrent(repo, mode, dirty)
  const commits = st.behind === 1 ? '1 new commit' : `${st.behind} new commits`
  return (
    <div className="behind-banner" role="status">
      <Icon name="pull" size={13} />
      <span className="ellipsis">
        <b>{notice.upstream}</b> has {commits}: {notice.branch} is behind by {st.behind}
        {st.ahead > 0 && <span className="muted"> and ahead by {st.ahead}</span>}
      </span>
      <span className="grow" />
      <button
        className="btn small primary"
        disabled={busy}
        title={dirty ? 'Stash your uncommitted changes, pull, then pop them back' : undefined}
        onClick={() => run('ff')}
      >
        {dirty ? 'Stash & pull' : 'Pull'}
      </button>
      <button className="btn small" disabled={busy} title={dirty ? 'Stash, pull with rebase, then pop your changes back' : undefined} onClick={() => run('rebase')}>
        {dirty ? 'Stash & pull (rebase)' : 'Pull (rebase)'}
      </button>
      <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={() => dismissBehindNotice(repo.path)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}
