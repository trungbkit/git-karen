import { useMemo, useState } from 'react'
import type { Ref } from '@shared/types'
import { useActiveRepo, useStore, type RepoTab } from '../state/store'
import { Modal } from '../ui/Modal'
import { Icon } from '../ui/Icon'
import { validateRefName } from '../ui/dialogs'
import { remoteBranchName } from '../actions/refActions'
import { suggestWorktreePath, worktreeLabel } from '../actions/worktreeActions'
import { basename, joinPath, shortSha } from '../util/format'
import '../styles/shell.css'

export function WorktreeModal() {
  const modal = useStore((s) => s.modal)
  const repo = useActiveRepo()
  if (modal?.kind !== 'worktree' || !repo) return null
  return <WorktreeForm repo={repo} initialRef={modal.ref} />
}

interface RefPlan {
  /** The ref the user typed resolved against the repo's refs */
  ref?: Ref
  /** Branch name to suggest for a new branch */
  suggestion: string
  /** Why a new branch is required, if it is */
  needsBranch: string | null
  /** What happens when no new branch is given */
  note: string | null
}

function plan(repo: RepoTab, value: string): RefPlan {
  const v = value.trim()
  const ref = repo.refs.find((r) => r.type !== 'stash' && r.type !== 'head' && (r.name === v || r.fullName === v))
  if (ref?.type === 'local') {
    const holder = repo.worktrees.find((wt) => wt.branch === ref.name)
    if (holder)
      return {
        ref,
        suggestion: '',
        needsBranch: `${ref.name} is already checked out in ${holder.path === repo.path ? 'this worktree' : worktreeLabel(holder) + ' (' + holder.path + ')'}. Enter a new branch name.`,
        note: null
      }
    return { ref, suggestion: '', needsBranch: null, note: `Checks out ${ref.name}.` }
  }
  if (ref?.type === 'remote') {
    const local = remoteBranchName(ref)
    const exists = repo.refs.some((r) => r.type === 'local' && r.name === local)
    return {
      ref,
      suggestion: exists ? '' : local,
      needsBranch: null,
      note: exists ? `A local ${local} already exists; without a new branch the worktree gets a detached HEAD.` : null
    }
  }
  const label = ref?.type === 'tag' ? ref.name : /^[0-9a-f]{7,40}$/i.test(v) ? shortSha(v) : v
  return { ref, suggestion: '', needsBranch: null, note: v ? `Without a new branch, ${label} is checked out as a detached HEAD.` : null }
}

function WorktreeForm({ repo, initialRef }: { repo: RepoTab; initialRef?: string }) {
  const setModal = useStore((s) => s.setModal)
  const { run, openRepo } = useStore.getState()
  const [refValue, setRefValue] = useState(initialRef ?? repo.status?.branch ?? 'HEAD')
  const p = useMemo(() => plan(repo, refValue), [repo, refValue])
  const [branch, setBranch] = useState('')
  const [branchTouched, setBranchTouched] = useState(false)
  const [pathValue, setPathValue] = useState<string | null>(null)
  const [lock, setLock] = useState(false)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)

  const newBranch = branchTouched ? branch : p.suggestion
  const nameForPath = newBranch.trim() || (p.ref ? (p.ref.type === 'remote' ? remoteBranchName(p.ref) : p.ref.name) : refValue.trim())
  const path = pathValue ?? suggestWorktreePath(repo, nameForPath)

  const branchError = newBranch.trim()
    ? (validateRefName(newBranch.trim()) ?? (repo.refs.some((r) => r.type === 'local' && r.name === newBranch.trim()) ? `A local branch ${newBranch.trim()} already exists` : null))
    : p.needsBranch
  const pathError = !path.trim() ? 'Choose a folder' : repo.worktrees.some((wt) => wt.path === path.trim()) ? 'A worktree already uses this folder' : null
  const insideRepo = path.trim().startsWith(repo.path + '/')
  const invalid = !refValue.trim() || !!branchError || !!pathError || busy

  const refOptions = useMemo(
    () =>
      repo.refs
        .filter((r) => r.type === 'local' || r.type === 'tag' || (r.type === 'remote' && !r.name.endsWith('/HEAD')))
        .map((r) => r.name),
    [repo.refs]
  )

  const close = () => !busy && setModal(null)
  const submit = async () => {
    if (invalid) return
    setBusy(true)
    const target = path.trim()
    const ok = await run('Creating worktree', (r) => window.git.worktreeAdd(r, target, refValue.trim(), newBranch.trim() || undefined, lock), {
      success: 'Worktree created'
    })
    setBusy(false)
    if (!ok) return
    setModal(null)
    if (open) await openRepo(target).catch(() => undefined)
  }

  return (
    <Modal
      title={
        <span className="wt-modal-title">
          <Icon name="worktree" size={15} /> Create worktree
        </span>
      }
      onClose={close}
      width={560}
      footer={
        <>
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={invalid} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create worktree'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Reference to check out</label>
        <input
          autoFocus
          list="kc-worktree-refs"
          value={refValue}
          placeholder="Branch, tag or commit"
          onChange={(e) => setRefValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <datalist id="kc-worktree-refs">
          {refOptions.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </div>
      <div className="field">
        <label>New branch to create {p.needsBranch ? '' : '(optional)'}</label>
        <input
          value={newBranch}
          placeholder={p.suggestion || 'Leave empty to check out the reference'}
          onChange={(e) => {
            setBranchTouched(true)
            setBranch(e.target.value)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        {branchError ? <span className="field-error">{branchError}</span> : p.note && !newBranch.trim() && <span className="field-hint">{p.note}</span>}
      </div>
      <div className="field">
        <label>Working directory</label>
        <div className="dir-picker">
          <input value={path} onChange={(e) => setPathValue(e.target.value)} placeholder="/path/to/worktree" />
          <button
            className="btn"
            onClick={async () => {
              // pick the parent folder; the worktree gets its own sub-folder in it
              const dir = await window.app.pickDirectory('Choose where to put the worktree')
              if (dir) setPathValue(joinPath(dir, basename(path) || 'worktree'))
            }}
          >
            Browse…
          </button>
        </div>
        {pathError ? (
          <span className="field-error">{pathError}</span>
        ) : (
          insideRepo && <span className="field-warning">The folder is inside this repository's working directory. Make sure it is ignored in .gitignore.</span>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
        Lock this worktree (it will not be pruned)
      </label>
      <label className="check">
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
        Open the worktree in a new tab
      </label>
    </Modal>
  )
}
