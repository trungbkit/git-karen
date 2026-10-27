import type { MouseEvent } from 'react'
import { COMMANDS } from '@shared/commands'
import { useStore, type RepoTab } from '../state/store'
import { Icon, type IconName } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { checkoutRef, createBranchAt, fetchAll, popStash, pull, pushCurrent, stashChanges } from '../actions/refActions'
import { createWorktree, currentWorktree, openWorktree, worktreeForBranch } from '../actions/worktreeActions'
import { dispatch, shortcutFor } from '../keybindings'
import { useProgress } from '../state/progress'
import '../styles/shell.css'

function menuBelow(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }
}

export function Toolbar({ repo }: { repo: RepoTab }) {
  const status = repo.status
  const busy = repo.busy
  const branch = status?.detached ? `detached at ${status.headSha?.slice(0, 7) ?? '?'}` : (status?.branch ?? '…')
  const locals = repo.refs.filter((r) => r.type === 'local')
  const hasChanges = !!status && status.staged.length + status.unstaged.length > 0
  const useInAppTerminal = useStore((s) => s.prefs.useInAppTerminal)
  const progress = useProgress((s) => (busy ? s[repo.path] : undefined))

  const thisWorktree = currentWorktree(repo)
  const linked = !!thisWorktree && !thisWorktree.isMain
  const mainWorktree = repo.worktrees.find((wt) => wt.isMain)

  const branchMenu = (e: MouseEvent) =>
    showContextMenu(menuBelow(e), [
      ...locals.map((ref) => ({
        label: ref.isHead ? `✓ ${ref.name}` : worktreeForBranch(repo, ref.name) ? `${ref.name}  (open worktree)` : ref.name,
        disabled: ref.isHead,
        onClick: () => void checkoutRef(repo, ref)
      })),
      locals.length > 0 && 'separator',
      { label: 'Create branch…', onClick: () => void createBranchAt() },
      { label: 'Create worktree…', onClick: () => createWorktree() }
    ])

  const terminalMenu = (e: MouseEvent) => {
    e.preventDefault()
    showContextMenu(menuBelow(e), [
      { label: 'New terminal tab', hint: shortcutFor(COMMANDS.newTerminal), onClick: () => dispatch(COMMANDS.newTerminal) },
      { label: 'Open external terminal', onClick: () => void window.app.openTerminal(repo.path) }
    ])
  }

  const pullMenu = (e: MouseEvent) =>
    showContextMenu(menuBelow(e), [
      { label: 'Fetch all', onClick: () => void fetchAll() },
      { label: 'Pull (fast-forward if possible)', onClick: () => void pull('ff') },
      { label: 'Pull (fast-forward only)', onClick: () => void pull('ff-only') },
      { label: 'Pull (rebase)', onClick: () => void pull('rebase') }
    ])

  return (
    <div className="toolbar">
      <div className="tb-left">
        <div className="tb-repo" title={repo.path}>
          <span className="tb-label">repository</span>
          <span className="tb-value ellipsis">{repo.info?.name}</span>
        </div>
        {linked && (
          <span className="tb-worktree" title={`This tab is a linked worktree${mainWorktree ? ` of ${mainWorktree.path}` : ''}`}>
            <Icon name="worktree" size={12} /> worktree
            {mainWorktree && (
              <button className="icon-btn" title="Open the main worktree" aria-label="Open the main worktree" onClick={() => openWorktree(mainWorktree.path)}>
                <Icon name="home" size={12} />
              </button>
            )}
          </span>
        )}
        <Icon name="chevron-right" size={12} className="muted" />
        <button className="tb-branch" onClick={branchMenu} title="Switch branch">
          <span className="tb-label">branch</span>
          <span className="tb-value ellipsis">
            <Icon name="branch" size={12} /> {branch} <Icon name="chevron-down" size={10} />
          </span>
        </button>
      </div>

      <div className="tb-center">
        <ToolButton icon="refresh" label="Refresh" title={`Refresh (${shortcutFor(COMMANDS.refresh) ?? ''})`} onClick={() => dispatch(COMMANDS.refresh)} />
        <div className="tb-split">
          <ToolButton icon="pull" label="Pull" badge={status?.behind || undefined} disabled={!!busy || repo.remotes.length === 0} onClick={() => void pull('ff')} />
          <button className="tb-caret" disabled={!!busy || repo.remotes.length === 0} onClick={pullMenu} title="Pull options" aria-label="Pull options">
            <Icon name="chevron-down" size={10} />
          </button>
        </div>
        <ToolButton icon="push" label="Push" badge={status?.ahead || undefined} disabled={!!busy || repo.remotes.length === 0} onClick={() => void pushCurrent(repo)} />
        <ToolButton icon="branch" label="Branch" title={`Create branch (${shortcutFor(COMMANDS.createBranch) ?? ''})`} onClick={() => void createBranchAt()} />
        <ToolButton icon="stash" label="Stash" disabled={!hasChanges} onClick={() => void stashChanges()} />
        <ToolButton icon="stash" label="Pop" disabled={repo.stashes.length === 0} onClick={() => void popStash(0)} flip />
        <div className="tb-split">
          <ToolButton
            icon="terminal"
            label="Terminal"
            title={useInAppTerminal ? `Toggle terminal (${shortcutFor(COMMANDS.toggleTerminal) ?? ''})` : 'Open external terminal'}
            onClick={() => dispatch(COMMANDS.toggleTerminal)}
            onContextMenu={terminalMenu}
          />
          <button className="tb-caret" onClick={terminalMenu} title="Terminal options" aria-label="Terminal options">
            <Icon name="chevron-down" size={10} />
          </button>
        </div>
        <ToolButton icon="external" label="Editor" onClick={() => void window.app.openInEditor(repo.path)} />
      </div>

      <div className="tb-right">
        {busy && (
          <span className="tb-busy">
            <span className="spinner" /> {busy}…{progress?.overall != null && ` ${progress.overall}%`}
          </span>
        )}
        <button className="icon-btn tb-icon" title={`Command palette (${shortcutFor(COMMANDS.toggleFuzzyFinder) ?? ''})`} aria-label={`Command palette (${shortcutFor(COMMANDS.toggleFuzzyFinder) ?? ''})`} onClick={() => dispatch(COMMANDS.toggleFuzzyFinder)}>
          <Icon name="search" size={15} />
        </button>
        <button className="icon-btn tb-icon" title="Preferences" aria-label="Preferences" onClick={() => dispatch(COMMANDS.preferences)}>
          <Icon name="settings" size={15} />
        </button>
      </div>
    </div>
  )
}

function ToolButton(p: { icon: IconName; label: string; onClick(e: MouseEvent): void; onContextMenu?(e: MouseEvent): void; disabled?: boolean; title?: string; badge?: number; flip?: boolean }) {
  return (
    <button className="tb-btn" disabled={p.disabled} title={p.title ?? p.label} onClick={p.onClick} onContextMenu={p.onContextMenu}>
      <span className="tb-btn-icon">
        <Icon name={p.icon} size={17} style={p.flip ? { transform: 'scaleY(-1)' } : undefined} />
        {p.badge ? <span className="tb-badge">{p.badge}</span> : null}
      </span>
      <span className="tb-btn-label">{p.label}</span>
    </button>
  )
}
