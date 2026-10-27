// Undo for destructive operations: each records how to revert itself and a toast offers it for a few seconds.
import type { FileBackup } from '@shared/types'
import { useStore } from '../state/store'
import { Journal, UNDO_WINDOW_MS } from '../state/journal'
import { confirm } from '../ui/dialogs'

const store = () => useStore.getState()
const git = () => window.git

export const journal = new Journal()

interface UndoOptions {
  /** Toast title (defaults to the label) */
  title?: string
  message?: string
  /** Button text (default "Undo") */
  actionLabel?: string
  /** Asked before undoing, for undos that reach outside this machine */
  confirm?: { title: string; message: string; confirmLabel: string }
}

const confirmations = new Map<number, NonNullable<UndoOptions['confirm']>>()

/** Record how to revert an operation that just succeeded and show a toast with an Undo button. */
export function offerUndo(repo: string, label: string, undo: (repo: string) => Promise<unknown>, opts: UndoOptions = {}) {
  const entry = journal.push({ repo, label, undo: async (r) => void (await undo(r)) })
  if (opts.confirm) confirmations.set(entry.id, opts.confirm)
  store().toast({
    kind: 'success',
    title: opts.title ?? label,
    message: opts.message,
    duration: UNDO_WINDOW_MS,
    action: { label: opts.actionLabel ?? 'Undo', run: () => void undoEntry(entry.id) }
  })
}

export async function undoEntry(id: number) {
  const clicked = Date.now()
  const ask = confirmations.get(id)
  if (ask && journal.get(id, clicked) && !(await confirm(ask.title, ask.message, { danger: true, confirmLabel: ask.confirmLabel }))) return
  confirmations.delete(id)
  // the window is measured at the click, not after the confirmation
  const entry = journal.take(id, clicked)
  if (!entry || !store().repos[entry.repo]) {
    store().toast({ kind: 'info', title: 'Undo is no longer available', message: 'Only the latest destructive operation can be undone, for a few seconds after it ran.' })
    return
  }
  await store().run(`Undoing: ${entry.label}`, () => entry.undo(entry.repo), { success: `Undone: ${entry.label}`, repo: entry.repo })
}

/** Undo the latest undoable operation in the active repo (command palette). */
export function undoLatest() {
  const entry = journal.latest(store().activeTab)
  if (!entry) store().toast({ kind: 'info', title: 'Nothing to undo', message: 'Undo is available for a few seconds after a destructive operation.' })
  else void undoEntry(entry.id)
}

/**
 * Run an operation that moves a branch (the checked-out one when `branch` is null) and, when it moved,
 * offer to move it back. `success` titles the undo toast.
 */
export async function runRestorable(
  label: string,
  branch: string | null,
  fn: (repo: string) => Promise<unknown>,
  opts: { success: string; undoLabel: string }
): Promise<boolean> {
  const repo = store().activeTab
  const tab = store().repos[repo]
  if (!tab) return false
  const name = branch ?? (tab.status?.detached ? null : (tab.status?.branch ?? null))
  const rev = name ? `refs/heads/${name}` : 'HEAD'
  const before = await git().resolveRef(repo, rev).catch(() => null)
  const ok = await store().run(label, fn, before ? {} : { success: opts.success })
  if (!ok || !before) return ok
  const after = await git().resolveRef(repo, rev).catch(() => null)
  if (after === before) store().toast({ kind: 'success', title: opts.success })
  else offerUndo(repo, opts.undoLabel, (r) => git().restoreBranch(r, name, before), { title: opts.success })
  return ok
}

/** Discard work-tree changes to whole files, keeping their content so the discard can be undone. */
export async function discardFiles(paths: string[], what: string): Promise<boolean> {
  const repo = store().activeTab
  let backups: FileBackup[] = []
  const ok = await store().run(
    'Discarding changes',
    async (r) => {
      backups = await git().backupFiles(r, paths)
      await git().discard(r, paths)
    },
    { log: false }
  )
  if (ok) offerUndo(repo, `Discard ${what}`, (r) => git().restoreFiles(r, backups), { title: `Discarded changes to ${what}` })
  return ok
}

/** Discard part of a file (reverse-apply `patch` to the work tree), keeping the file so it can be undone. */
export async function discardPatch(path: string, patch: string, label: string): Promise<boolean> {
  const repo = store().activeTab
  let backups: FileBackup[] = []
  const ok = await store().run(
    label,
    async (r) => {
      backups = await git().backupFiles(r, [path])
      await git().applyPatch(r, patch, { cached: false, reverse: true })
    },
    { log: false }
  )
  if (ok) offerUndo(repo, `Discard in ${path}`, (r) => git().restoreFiles(r, backups), { title: `Discarded changes in ${path}` })
  return ok
}
