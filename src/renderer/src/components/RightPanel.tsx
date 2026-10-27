import type { RepoOperation } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { confirm } from '../ui/dialogs'
import { shortSha } from '../util/format'
import { CommitDetail } from './CommitDetail'
import { StagingPanel } from './StagingPanel'
import { WorktreePanel } from './WorktreePanel'
import { cherryPick } from '../actions/refActions'
import { openCompare } from '../actions/compareActions'
import '../styles/detail.css'

const OPERATION_LABEL: Record<RepoOperation, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  bisect: 'Bisect'
}

function OperationBanner({ repo }: { repo: RepoTab }) {
  const op = repo.status?.operation
  if (!op) return null
  const { run, setCenter } = useStore.getState()
  const conflicted = repo.status?.conflicted ?? []
  const label = OPERATION_LABEL[op]
  return (
    <div className="op-banner">
      <div className="op-banner-title">
        <Icon name="warning" size={14} />
        {label} in progress
        {conflicted.length > 0 && (
          <span className="muted" style={{ fontWeight: 400 }}>
            · {conflicted.length} {conflicted.length === 1 ? 'conflict' : 'conflicts'}
          </span>
        )}
      </div>
      {conflicted.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {conflicted.slice(0, 6).map((f) => (
            <a key={f.path} style={{ cursor: 'pointer', color: 'var(--text-accent)' }} onClick={() => setCenter({ kind: 'conflict', path: f.path })}>
              {f.path}
            </a>
          ))}
          {conflicted.length > 6 && <span className="muted">and {conflicted.length - 6} more…</span>}
        </div>
      )}
      {op !== 'bisect' && (
        <div className="op-banner-actions">
          <button
            className="btn small primary"
            disabled={conflicted.length > 0}
            title={conflicted.length > 0 ? 'Resolve all conflicts first' : undefined}
            onClick={() => void run(`Continuing ${label.toLowerCase()}`, (r) => window.git.continueOperation(r))}
          >
            Continue {label}
          </button>
          {op === 'rebase' && (
            <button className="btn small" onClick={() => void run('Skipping commit', (r) => window.git.skipOperation(r))}>
              Skip commit
            </button>
          )}
          <button
            className="btn small danger"
            onClick={async () => {
              if (await confirm(`Abort ${label.toLowerCase()}?`, 'Your repository will return to the state before the operation started.', { confirmLabel: 'Abort', danger: true }))
                void run(`Aborting ${label.toLowerCase()}`, (r) => window.git.abortOperation(r))
            }}
          >
            Abort
          </button>
        </div>
      )}
    </div>
  )
}

function MultiCommitSummary({ repo, shas }: { repo: RepoTab; shas: string[] }) {
  const { setCenter } = useStore.getState()
  const index = new Map(repo.commits.map((c, i) => [c.sha, i]))
  // Oldest first (repo.commits is newest first).
  const ordered = [...shas].sort((a, b) => (index.get(b) ?? 0) - (index.get(a) ?? 0))
  const commits = ordered.map((sha) => repo.commits[index.get(sha) ?? -1]).filter(Boolean)
  const oldest = commits[0]
  return (
    <div className="rp">
      <div className="cd-head">
        <div className="cd-summary">{shas.length} commits selected</div>
        <div className="cd-actions">
          <button
            className="btn small"
            onClick={() => void cherryPick(repo, ordered)}
          >
            Cherry-pick {shas.length} commits
          </button>
          {shas.length === 2 && (
            <button className="btn small" title="Files and commits between the two" onClick={() => openCompare(ordered[0], ordered[1])}>
              Compare
            </button>
          )}
          <button
            className="btn small"
            disabled={!oldest || oldest.parents.length === 0}
            title="Interactively rebase from the parent of the oldest selected commit"
            onClick={() => oldest && setCenter({ kind: 'rebase', onto: oldest.parents[0], shas: ordered })}
          >
            Interactive rebase
          </button>
        </div>
      </div>
      <div className="rp-scroll">
        {[...commits].reverse().map((c) => (
          <div key={c.sha} className="history-item" onClick={() => useStore.getState().select({ kind: 'commit', shas: [c.sha] })}>
            <span className="ellipsis">{c.summary}</span>
            <span className="meta">
              <span className="mono">{shortSha(c.sha)}</span>
              <span>{c.author.name}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function RightPanel({ repo }: { repo: RepoTab }) {
  const sel = repo.selection
  const status = repo.status
  const changeCount = status ? status.staged.length + status.unstaged.length + status.conflicted.length : 0

  let body
  if (sel?.kind === 'commit' && sel.shas.length === 1) {
    body = <CommitDetail key={sel.shas[0]} repo={repo} sha={sel.shas[0]} />
  } else if (sel?.kind === 'commit' && sel.shas.length > 1) {
    body = <MultiCommitSummary repo={repo} shas={sel.shas} />
  } else if (sel?.kind === 'stash') {
    const stash = repo.stashes.find((s) => s.index === sel.index)
    body = stash ? <CommitDetail key={stash.sha} repo={repo} sha={stash.sha} stash={stash} /> : <div className="rp-empty">Stash not found</div>
  } else if (sel?.kind === 'worktree') {
    body = <WorktreePanel key={sel.path} repo={repo} path={sel.path} />
  } else if (sel?.kind === 'wip' || changeCount > 0 || status?.operation) {
    body = <StagingPanel repo={repo} />
  } else {
    body = (
      <div className="rp-empty">
        <Icon name="commit" size={28} />
        <span>Working directory clean.</span>
        <span>Select a commit to see its details.</span>
        {status?.branch && !status.detached && repo.remotes.length > 0 && (
          <button
            className="btn small rp-empty-action"
            disabled={!!repo.busy}
            onClick={() => useStore.getState().setModal({ kind: 'smartCommit', prOnly: true })}
            title={`Push ${status.branch} if needed and open pull requests with AI-written texts`}
          >
            <Icon name="pull-request" size={12} /> Create pull request…
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="panel-right">
      <OperationBanner repo={repo} />
      {body}
    </div>
  )
}
