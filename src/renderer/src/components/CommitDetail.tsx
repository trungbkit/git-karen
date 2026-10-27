import { useEffect, useState } from 'react'
import type { CommitDetail as CommitDetailData, Stash } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { avatarColor, formatDate, fullDate, initials, shortSha } from '../util/format'
import { commitMenuItems, copyText, dropStash, popStash } from '../actions/refActions'
import { FileList, FileStats, FileViewToggle, fileMenuItems } from './FileList'
import { Avatar as GraphAvatar } from '../graph/avatar'
import { SignatureBadge } from './SignatureBadge'
import { IssueText } from './IssueText'
import { CiBadge } from '../graph/CiBadge'
import '../styles/detail.css'

// Commits are immutable, so details can be cached for the session.
const cache = new Map<string, CommitDetailData>()

/** Commit details (cached); pass null to skip loading. */
export function useCommitDetail(repoPath: string, sha: string | null): { detail: CommitDetailData | null; error: string | null } {
  const key = sha ? `${repoPath}\0${sha}` : ''
  const [state, setState] = useState<{ key: string; detail: CommitDetailData | null; error: string | null }>(() => ({
    key,
    detail: cache.get(key) ?? null,
    error: null
  }))
  useEffect(() => {
    if (!sha) return
    const cached = cache.get(key)
    if (cached) {
      setState({ key, detail: cached, error: null })
      return
    }
    let cancelled = false
    setState({ key, detail: null, error: null })
    window.git.commitDetail(repoPath, sha).then(
      (d) => {
        cache.set(key, d)
        if (!cancelled) setState({ key, detail: d, error: null })
      },
      (e: Error) => !cancelled && setState({ key, detail: null, error: e.message })
    )
    return () => {
      cancelled = true
    }
  }, [key, repoPath, sha])
  return state.key === key ? state : { detail: null, error: null }
}

export function Avatar({ name, email, size = 28 }: { name: string; email: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: avatarColor(email), width: size, height: size, fontSize: size * 0.38 }} title={`${name} <${email}>`}>
      {initials(name)}
    </span>
  )
}

export function CommitDetail({ repo, sha, stash }: { repo: RepoTab; sha: string; stash?: Stash }) {
  const { detail, error } = useCommitDetail(repo.path, sha)
  const dateMode = useStore((s) => s.prefs.dateFormat)
  const showAvatars = useStore((s) => s.prefs.showAvatars)
  const { setCenter, select, run } = useStore.getState()

  if (error) return <div className="rp-empty">{error}</div>
  if (!detail) return <div className="rp-empty">Loading…</div>

  const { commit, files } = detail
  const selectedPath =
    repo.center.kind === 'diff' && repo.center.target.kind === 'commit' && repo.center.target.sha === sha ? repo.center.target.path : null
  const sameCommitter = commit.committer.email === commit.author.email && commit.committer.name === commit.author.name
  const additions = files.reduce((n, f) => n + (f.additions ?? 0), 0)
  const deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0)
  const openDiff = (path: string) => setCenter({ kind: 'diff', target: { kind: 'commit', sha, path } })

  const person = (who: 'authored' | 'committed', sig: typeof commit.author, size: number) => (
    <div className="cd-person">
      <GraphAvatar name={sig.name} email={sig.email} size={size} remote={showAvatars} />
      <div className="cd-person-text">
        <span className="cd-person-name ellipsis" title={`${sig.name} <${sig.email}>`}>
          {sig.name}
        </span>
        <span className="muted" title={fullDate(sig.date)}>
          {who} {formatDate(sig.date, dateMode)}
        </span>
      </div>
    </div>
  )

  return (
    <div className="rp">
      <div className="cd-bar" onContextMenu={stash ? undefined : (e) => showContextMenu(e, commitMenuItems(repo, sha))}>
        {stash ? (
          <span className="cd-bar-label">
            <Icon name="stash" size={12} /> {stash.ref}
          </span>
        ) : (
          <span className="cd-bar-label">commit:</span>
        )}
        <span className="cd-sha" title="Copy full SHA" onClick={() => copyText(commit.sha, 'SHA copied')}>
          {shortSha(commit.sha)}
        </span>
        {!stash && <SignatureBadge repo={repo.path} sha={commit.sha} />}
        {!stash && <CiBadge repo={repo.path} sha={commit.sha} />}
        <span className="grow" />
        <button className="icon-btn" title="Copy full SHA" aria-label="Copy full SHA" onClick={() => copyText(commit.sha, 'SHA copied')}>
          <Icon name="copy" size={13} />
        </button>
        <button
          className="icon-btn"
          title="Close" aria-label="Close"
          onClick={() => {
            if (repo.center.kind === 'diff') setCenter({ kind: 'graph' })
            select(null)
          }}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="rp-scroll">
        <div className="cd-head">
          <div className="cd-message">
            <div className="cd-summary">{stash ? stash.message : <IssueText repo={repo.path} text={commit.summary} />}</div>
            {commit.body && (
              <div className="cd-body">
                <IssueText repo={repo.path} text={commit.body} />
              </div>
            )}
          </div>
          <div className="cd-people">
            <div className="cd-people-col">
              {person('authored', commit.author, 36)}
              {!sameCommitter && person('committed', commit.committer, 28)}
            </div>
            {!stash && commit.parents.length > 0 && (
              <div className="cd-parents">
                <span className="muted">{commit.parents.length > 1 ? 'parents:' : 'parent:'}</span>
                {commit.parents.map((p) => (
                  <a key={p} className="cd-sha-link" title="Select parent" onClick={() => select({ kind: 'commit', shas: [p] })}>
                    {shortSha(p)}
                  </a>
                ))}
              </div>
            )}
          </div>
          {stash && (
            <div className="cd-actions">
              <button className="btn small" onClick={() => void run('Applying stash', (r) => window.git.stashApply(r, stash.index), { success: 'Stash applied' })}>
                Apply
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  if (await popStash(stash.index)) select({ kind: 'wip' })
                }}
              >
                Pop
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  if (await dropStash(stash)) select(null)
                }}
              >
                <Icon name="trash" size={12} /> Delete
              </button>
            </div>
          )}
        </div>
        <div className="cd-files-summary">
          <FileStats files={files} />
          <span className="grow" />
          {(additions > 0 || deletions > 0) && (
            <span className="stats" title={`${additions} lines added, ${deletions} removed`}>
              {additions > 0 && <span className="add">+{additions}</span>}
              {deletions > 0 && <span className="del">−{deletions}</span>}
            </span>
          )}
        </div>
        <div className="cd-files-controls">
          <span className="muted">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
          <span className="grow" />
          <FileViewToggle />
        </div>
        <FileList
          files={files}
          showStats
          selectedPath={selectedPath}
          onClick={(f) => openDiff(f.path)}
          onContextMenu={(e, f) =>
            showContextMenu(e, [
              { label: 'Open diff', onClick: () => openDiff(f.path) },
              'separator',
              ...fileMenuItems(repo, f.path)
            ])
          }
          actions={(f) => (
            <>
              <button className="icon-btn" title="File history" aria-label="File history" onClick={(e) => (e.stopPropagation(), setCenter({ kind: 'history', path: f.path, blame: false }))}>
                <Icon name="history" size={12} />
              </button>
              <button className="icon-btn" title="Open in external editor" aria-label="Open in external editor" onClick={(e) => (e.stopPropagation(), void window.app.openInEditor(repo.path, f.path))}>
                <Icon name="external" size={12} />
              </button>
            </>
          )}
        />
      </div>
    </div>
  )
}
