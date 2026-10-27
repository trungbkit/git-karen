// Worktree helpers and actions shared by the left panel, graph, toolbar and ref menus.
import type { Ref, Worktree } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { confirm, prompt } from '../ui/dialogs'
import type { MenuItem } from '../ui/ContextMenu'
import { basename, joinPath, shortSha } from '../util/format'
import { copyText } from './refActions'

const store = () => useStore.getState()
const git = () => window.git

/** Display name: the checked-out branch, else the detached commit, else the folder. */
export function worktreeLabel(wt: Worktree): string {
  return wt.branch ?? (wt.detached && wt.head ? shortSha(wt.head) : basename(wt.path))
}

/** The worktree entry for the repo tab itself. */
export function currentWorktree(repo: RepoTab): Worktree | undefined {
  return repo.worktrees.find((wt) => wt.path === repo.path)
}

/** True when the tab is a linked (non-main) worktree of another repository. */
export function isLinkedWorktree(repo: RepoTab): boolean {
  const wt = currentWorktree(repo)
  return !!wt && !wt.isMain
}

/** Another worktree (not this tab) that has `branch` checked out. */
export function worktreeForBranch(repo: RepoTab, branch: string): Worktree | undefined {
  return repo.worktrees.find((wt) => wt.branch === branch && wt.path !== repo.path)
}

export function changeCount(wt: Worktree): number {
  const c = wt.changes
  return c ? c.modified + c.added + c.deleted + c.conflicted : 0
}

/** Default folder for a new worktree: `<repo>.worktrees/<name>` next to the main worktree. */
export function suggestWorktreePath(repo: RepoTab, name: string): string {
  const main = repo.worktrees.find((wt) => wt.isMain)?.path ?? repo.path
  const slash = Math.max(main.lastIndexOf('/'), main.lastIndexOf('\\'))
  const parent = slash > 0 ? main.slice(0, slash) : main
  const folder = name.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree'
  return joinPath(joinPath(parent, `${basename(main)}.worktrees`), folder)
}

export function openWorktree(path: string) {
  void store().openRepo(path).catch(() => undefined)
}

export function createWorktree(ref?: string) {
  store().setModal({ kind: 'worktree', ref })
}

async function lockWorktree(wt: Worktree) {
  const res = await prompt({
    title: `Lock worktree ${worktreeLabel(wt)}`,
    message: 'A locked worktree is never pruned, e.g. while it lives on a removable drive.',
    fields: [{ name: 'reason', label: 'Reason (optional)', placeholder: 'Lock message' }],
    confirmLabel: 'Lock'
  })
  if (res) await store().run('Locking worktree', (r) => git().worktreeLock(r, wt.path, true, res.reason.trim() || undefined))
}

/**
 * Remove a worktree, optionally deleting its branch (`'local'`) and the branch's upstream (`'remote'`).
 * Git refuses to remove a worktree with changes; the user is then asked to force it.
 */
export async function removeWorktree(repo: RepoTab, wt: Worktree, deleteBranch: false | 'local' | 'remote' = false) {
  const branch = wt.branch ? repo.refs.find((r) => r.type === 'local' && r.name === wt.branch) : undefined
  const upstream = branch?.upstream?.replace('refs/remotes/', '')
  const what = deleteBranch === 'remote' ? `and delete ${wt.branch} and ${upstream}` : deleteBranch ? `and delete ${wt.branch}` : ''
  const dirty = changeCount(wt) > 0
  const res = await prompt({
    title: `Remove worktree ${worktreeLabel(wt)} ${what}?`.replace(' ?', '?'),
    message: `${wt.path}${dirty ? '\n\nThis worktree has uncommitted changes that will be lost.' : ''}`,
    checkboxes: [{ name: 'force', label: 'Force (discard uncommitted changes in the worktree)', initial: dirty }],
    danger: true,
    confirmLabel: deleteBranch ? 'Remove and delete' : 'Remove'
  })
  if (!res) return
  let removed = false
  if (!res.checks.force) {
    try {
      await git().worktreeRemove(repo.path, wt.path, false)
      removed = true
    } catch (e) {
      const msg = (e as Error).message
      if (!/modified or untracked|--force/i.test(msg)) {
        store().toast({ kind: 'error', title: 'Removing worktree failed', message: msg })
        return
      }
      const force = await confirm('Force remove worktree?', 'Removing this worktree requires force, which discards its uncommitted changes and cannot be undone.', {
        confirmLabel: 'Force remove',
        danger: true
      })
      if (!force) return
    }
  }
  const ok = await store().run('Removing worktree', async (r) => {
    if (!removed) await git().worktreeRemove(r, wt.path, true)
    if (deleteBranch && wt.branch) {
      await git().deleteBranch(r, wt.branch, true)
      if (deleteBranch === 'remote' && branch?.upstream) {
        const remote = repo.remotes.map((rm) => rm.name).find((n) => upstream!.startsWith(`${n}/`))
        if (remote) await git().deleteRemoteBranch(r, remote, upstream!.slice(remote.length + 1))
      }
    }
  }, { success: 'Worktree removed' })
  // its tab (if open) now points at a folder that no longer exists
  if ((ok || removed) && store().tabs.includes(wt.path)) store().closeTab(wt.path)
}

export function worktreeMenuItems(repo: RepoTab, wt: Worktree): MenuItem[] {
  const s = store()
  const isCurrent = wt.path === repo.path
  const upstream = wt.branch ? repo.refs.find((r) => r.type === 'local' && r.name === wt.branch)?.upstream : undefined
  return [
    { label: 'Open worktree', onClick: () => openWorktree(wt.path), disabled: isCurrent || wt.prunable },
    { label: 'Show in folder', onClick: () => void window.app.showInFolder(wt.path), disabled: wt.prunable },
    { label: 'Open in external terminal', onClick: () => void window.app.openTerminal(wt.path), disabled: wt.prunable },
    { label: 'Open in external editor', onClick: () => void window.app.openInEditor(wt.path), disabled: wt.prunable },
    'separator',
    wt.locked
      ? { label: 'Unlock worktree', onClick: () => void s.run('Unlocking worktree', (r) => git().worktreeLock(r, wt.path, false)) }
      : { label: 'Lock worktree…', disabled: wt.isMain, onClick: () => void lockWorktree(wt) },
    wt.prunable && { label: 'Prune worktrees', onClick: () => void s.run('Pruning worktrees', (r) => git().worktreePrune(r)) },
    'separator',
    { label: 'Copy path', onClick: () => copyText(wt.path) },
    !!wt.branch && { label: 'Copy branch name', onClick: () => copyText(wt.branch!) },
    'separator',
    { label: 'Remove worktree', danger: true, disabled: wt.isMain || isCurrent || wt.locked, onClick: () => void removeWorktree(repo, wt) },
    !!wt.branch && {
      label: `Remove worktree and delete ${wt.branch}`,
      danger: true,
      disabled: wt.isMain || isCurrent || wt.locked,
      onClick: () => void removeWorktree(repo, wt, 'local')
    },
    !!wt.branch &&
      !!upstream && {
        label: `Remove worktree and delete ${wt.branch} (local and remote)`,
        danger: true,
        disabled: wt.isMain || isCurrent || wt.locked,
        onClick: () => void removeWorktree(repo, wt, 'remote')
      }
  ]
}

/** Branch menu entries for a local branch checked out in another worktree (replaces checkout and delete). */
export function branchWorktreeItems(repo: RepoTab, ref: Ref, wt: Worktree): MenuItem[] {
  return [
    { label: `Open worktree for ${ref.name}`, onClick: () => openWorktree(wt.path) },
    { label: `Remove worktree and delete ${ref.name}`, danger: true, disabled: wt.isMain || wt.locked, onClick: () => void removeWorktree(repo, wt, 'local') }
  ]
}
