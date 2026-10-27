// Right panel for another worktree's WIP row: its uncommitted changes, read-only, with a way to open it.
import { useEffect, useState } from 'react'
import type { FileChange, WorkingStatus } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { openWorktree, worktreeLabel, worktreeMenuItems } from '../actions/worktreeActions'
import { FileList, FileStats, FileViewToggle } from './FileList'
import '../styles/detail.css'

export function WorktreePanel({ repo, path }: { repo: RepoTab; path: string }) {
  const { setCenter, select } = useStore.getState()
  const wt = repo.worktrees.find((w) => w.path === path)
  const [status, setStatus] = useState<{ path: string; st: WorkingStatus | null; error: string | null } | null>(null)

  // Reload whenever the repo refreshes (repo.worktrees is replaced on every refresh).
  useEffect(() => {
    let cancelled = false
    window.git.status(path).then(
      (st) => !cancelled && setStatus({ path, st, error: null }),
      (e: Error) => !cancelled && setStatus({ path, st: null, error: e.message })
    )
    return () => {
      cancelled = true
    }
  }, [path, repo.worktrees])

  if (!wt) return <div className="rp-empty">This worktree no longer exists.</div>
  const st = status?.path === path ? status.st : null
  const center = repo.center
  const selected = center.kind === 'diff' && center.cwd === path && center.target.kind === 'working' ? center.target : null
  const open = (f: FileChange, staged: boolean) => setCenter({ kind: 'diff', target: { kind: 'working', path: f.path, staged }, cwd: path })
  const all = st ? [...st.conflicted, ...st.staged, ...st.unstaged.filter((f) => !st.staged.some((s) => s.path === f.path))] : []

  const fileMenu = (f: FileChange, staged: boolean) => [
    { label: 'Open diff', onClick: () => open(f, staged) },
    { label: 'Open in external editor', onClick: () => void window.app.openInEditor(path, f.path) },
    { label: 'Copy file path', onClick: () => void navigator.clipboard.writeText(f.path) }
  ]

  const list = (title: string, files: FileChange[], staged: boolean) => (
    <>
      <div className="section-head">
        <span>{title}</span>
        <span className="count">{files.length}</span>
      </div>
      {files.length === 0 ? (
        <div className="empty-list">None</div>
      ) : (
        <FileList
          files={files}
          showStats
          selectedPath={selected && selected.staged === staged ? selected.path : null}
          onClick={(f) => open(f, staged)}
          onContextMenu={(e, f) => showContextMenu(e, fileMenu(f, staged))}
        />
      )}
    </>
  )

  return (
    <div className="rp">
      <div className="cd-bar" onContextMenu={(e) => showContextMenu(e, worktreeMenuItems(repo, wt))}>
        <span className="cd-bar-label">
          <Icon name="worktree" size={12} /> worktree:
        </span>
        <span className="cd-sha">{worktreeLabel(wt)}</span>
        <span className="grow" />
        <button
          className="icon-btn"
          title="Close" aria-label="Close"
          onClick={() => {
            if (center.kind === 'diff') setCenter({ kind: 'graph' })
            select(null)
          }}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="rp-scroll">
        <div className="wt-head">
          <div className="wt-title">
            <Icon name={wt.isMain ? 'home' : 'worktree'} size={16} />
            <span className="ellipsis">{worktreeLabel(wt)}</span>
            {wt.locked && (
              <span title={wt.lockReason ? `Locked: ${wt.lockReason}` : 'Locked'}>
                <Icon name="lock" size={13} />
              </span>
            )}
          </div>
          <div className="wt-path">{wt.path}</div>
          <div className="cd-actions">
            <button className="btn small primary" onClick={() => openWorktree(wt.path)}>
              Open worktree
            </button>
            <button className="btn small" onClick={() => void window.app.showInFolder(wt.path)}>
              Show in folder
            </button>
            <button className="btn small" onClick={() => void window.app.openTerminal(wt.path)}>
              <Icon name="terminal" size={12} /> Terminal
            </button>
          </div>
          <div className="wt-note">Uncommitted changes in this worktree. Open it to stage and commit them.</div>
        </div>
        {status?.error ? (
          <div className="rp-empty">{status.error}</div>
        ) : !st ? (
          <div className="rp-empty">Loading…</div>
        ) : (
          <>
            <div className="cd-files-summary">
              <FileStats files={all} />
              <span className="grow" />
              <FileViewToggle />
            </div>
            {st.conflicted.length > 0 && list('Conflicted', st.conflicted, false)}
            {list('Unstaged files', st.unstaged, false)}
            {list('Staged files', st.staged, true)}
          </>
        )}
      </div>
    </div>
  )
}
