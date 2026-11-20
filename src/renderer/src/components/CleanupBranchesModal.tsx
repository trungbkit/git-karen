import { useEffect, useMemo, useRef, useState } from 'react'
import type { MergedBranch, SquashCheck } from '@shared/types'
import { useActiveRepo, useStore, type RepoTab } from '../state/store'
import { Modal } from '../ui/Modal'
import { Icon } from '../ui/Icon'
import { offerUndo } from '../actions/undo'
import { trackedChanges } from '../actions/refActions'
import {
  baseCandidates,
  cachedChecks,
  checkoutTarget,
  cleanupRows,
  defaultBase,
  isSelected,
  rememberChecks,
  remoteDeletions,
  splitUpstream,
  squashBatches,
  type CleanupStatus
} from '../actions/cleanup'
import { parseBranchList } from '../smart/text'
import { relativeTime } from '../util/format'

export function CleanupBranchesModal() {
  const modal = useStore((s) => s.modal)
  const repo = useActiveRepo()
  if (modal?.kind !== 'cleanupBranches' || !repo) return null
  return <CleanupForm repo={repo} initialBase={modal.base} />
}

const STATUS_LABEL: Record<CleanupStatus, string> = {
  merged: 'merged',
  squashed: 'squash merged',
  gone: 'upstream deleted',
  checking: 'checking…'
}

const STATUS_TITLE: Record<CleanupStatus, string> = {
  merged: 'Its last commit is in the base branch',
  squashed: 'Its changes are in the base branch as other commits (squash or rebase merge)',
  gone: 'Its branch on the remote was deleted, but some of its commits are not in the base branch',
  checking: 'Its branch on the remote was deleted; checking whether it was squash merged'
}

type Scan = { kind: 'loading' } | { kind: 'done'; branches: MergedBranch[] } | { kind: 'error'; message: string }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function CleanupForm({ repo, initialBase }: { repo: RepoTab; initialBase?: string }) {
  const setModal = useStore((s) => s.setModal)
  const protectedBranches = useStore((s) => s.prefs.protectedBranches)
  const candidates = useMemo(() => baseCandidates(repo), [repo])
  const [base, setBase] = useState<string | null>(() => initialBase ?? defaultBase(repo, candidates))
  const [alsoRemote, setAlsoRemote] = useState(false)
  const [scan, setScan] = useState<Scan>({ kind: 'loading' })
  const [checks, setChecks] = useState<Record<string, SquashCheck>>({})
  /** Squash checks done out of those needed, while they run */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [rescan, setRescan] = useState(0)
  /** Choices the user made; branches they did not touch follow the default (merged and squashed ticked) */
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const scanId = useRef(0)

  useEffect(() => {
    if (!base) return
    const id = ++scanId.current
    const live = () => id === scanId.current
    setScan({ kind: 'loading' })
    setChecks({})
    setProgress(null)
    setCheckError(null)
    void (async () => {
      let branches: MergedBranch[]
      try {
        branches = await window.git.mergedBranches(repo.path, base, { protected: parseBranchList(protectedBranches) })
      } catch (e) {
        if (live()) setScan({ kind: 'error', message: message(e) })
        return
      }
      if (!live()) return
      const baseSha = useStore.getState().repos[repo.path]?.refs.find((r) => r.fullName === base)?.sha
      const known = cachedChecks(repo.path, baseSha, branches)
      setScan({ kind: 'done', branches })
      setChecks(known)
      const total = squashBatches(branches).flat().length
      const batches = squashBatches(branches.filter((b) => !known[b.name]))
      let done = total - batches.flat().length
      if (!batches.length) return
      setProgress({ done, total })
      for (const names of batches) {
        let res: SquashCheck[]
        try {
          res = await window.git.checkSquashMerged(repo.path, base, names)
        } catch (e) {
          if (live()) {
            setCheckError(message(e))
            setProgress(null)
          }
          return
        }
        if (!live()) return
        rememberChecks(repo.path, baseSha, branches, res)
        done += names.length
        setChecks((c) => ({ ...c, ...Object.fromEntries(res.map((r) => [r.name, r])) }))
        setProgress(done < total ? { done, total } : null)
      }
    })()
    return () => {
      scanId.current++
    }
  }, [repo.path, base, protectedBranches, rescan])

  const branches = scan.kind === 'done' ? scan.branches : []
  const checking = progress !== null
  const rows = cleanupRows(branches, checks, { checking, currentBranch: repo.status?.branch ?? null, dirty: trackedChanges(repo) })
  const selectable = rows.filter((r) => !r.locked)
  const selected = rows.filter((r) => isSelected(r, picked))
  const remoteTargets = alsoRemote ? remoteDeletions(selected) : []
  const keptRemote = alsoRemote ? selected.filter((r) => r.branch.upstream).length - remoteTargets.length : 0
  const baseRef = candidates.find((r) => r.fullName === base)
  const baseRemote = baseRef?.remote ?? null
  const leaving = base && selected.some((r) => r.current) ? checkoutTarget(repo, base) : null

  const close = () => !busy && setModal(null)
  const setAll = (on: boolean) => setPicked(Object.fromEntries(selectable.map((r) => [r.branch.name, on])))

  const fetchAndRescan = async () => {
    if (!baseRemote) return
    setBusy('Fetching')
    await useStore.getState().run(`Fetching ${baseRemote}`, (r) => window.git.fetch(r, baseRemote, true))
    setBusy(null)
    setRescan((n) => n + 1)
  }

  const submit = async () => {
    if (!selected.length || busy) return
    setBusy('Deleting')
    const locals = selected.map(({ branch: b }) => ({ name: b.name, sha: b.sha, upstream: b.upstream }))
    // remote branches to delete, with the commit each pointed at so undo can push it back
    const remotes = remoteTargets.flatMap(({ branch: b }) => {
      const target = splitUpstream(repo, b.upstream!)
      const sha = repo.refs.find((r) => r.fullName === b.upstream)?.sha
      return target && sha ? [{ ...target, sha }] : []
    })
    let deleted: typeof locals = []
    let deletedRemote: typeof remotes = []
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 'es'}`
    const ok = await useStore.getState().run('Cleaning up branches', async (r) => {
      // git refuses to delete the checked-out branch; when switching fails, nothing is deleted
      if (leaving) await (leaving.remoteRef ? window.git.checkoutRemote(r, leaving.remoteRef) : window.git.checkout(r, leaving.name))
      const res = await window.git.deleteBranches(
        r,
        locals.map((b) => b.name)
      )
      const failed = res.filter((d) => d.error)
      deleted = locals.filter((b) => res.some((d) => d.name === b.name && !d.error))
      const byRemote = new Map<string, typeof remotes>()
      for (const t of remotes) byRemote.set(t.remote, [...(byRemote.get(t.remote) ?? []), t])
      for (const [remote, targets] of byRemote) {
        await window.git.deleteRemoteBranches(
          r,
          remote,
          targets.map((t) => t.branch)
        )
        deletedRemote = [...deletedRemote, ...targets]
      }
      if (failed.length) throw new Error(failed.map((d) => `${d.name}: ${d.error}`).join('\n'))
    })
    setBusy(null)
    if (deleted.length || deletedRemote.length) {
      const doneLocal = deleted
      const doneRemote = deletedRemote
      offerUndo(
        repo.path,
        `Clean up ${count(doneLocal.length, 'branch')}`,
        async (r) => {
          for (const b of doneLocal) await window.git.createBranch(r, b.name, b.sha, false)
          for (const t of doneRemote) await window.git.pushSha(r, t.remote, t.sha, t.branch, null)
          for (const b of doneLocal)
            if (b.upstream) await window.git.setUpstream(r, b.name, b.upstream.replace(/^refs\/remotes\//, '')).catch(() => undefined)
        },
        {
          title: `Deleted ${count(doneLocal.length, 'branch')}`,
          message: doneRemote.length ? `and ${count(doneRemote.length, 'branch')} on the remote` : doneLocal.map((b) => b.name).join(', ')
        }
      )
    }
    if (ok) setModal(null)
    else setRescan((n) => n + 1)
  }

  const deleteLabel = selected.length
    ? `Delete ${selected.length} branch${selected.length === 1 ? '' : 'es'}${remoteTargets.length ? ` and ${remoteTargets.length} on the remote` : ''}`
    : 'Delete'

  return (
    <Modal
      title={
        <span className="wt-modal-title">
          <Icon name="branch" size={15} /> Clean up merged branches
        </span>
      }
      onClose={close}
      width={620}
      footer={
        <>
          {leaving && <span className="field-hint cleanup-footer-hint">Switches to {leaving.name} before deleting.</span>}
          <button className="btn" onClick={close} disabled={!!busy}>
            Cancel
          </button>
          <button className="btn danger" disabled={!selected.length || !!busy || scan.kind !== 'done'} onClick={() => void submit()}>
            {busy === 'Deleting' ? 'Deleting…' : deleteLabel}
          </button>
        </>
      }
    >
      {!candidates.length ? (
        <span className="field-hint">This repository has no remote branches to compare with. Add a remote and fetch first.</span>
      ) : (
        <>
          <div className="field">
            <label htmlFor="kc-cleanup-base">Branches merged into</label>
            <div className="cleanup-base">
              <select id="kc-cleanup-base" value={base ?? ''} onChange={(e) => setBase(e.target.value)} disabled={!!busy}>
                {!base && <option value="">Choose a branch</option>}
                {candidates.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.name}
                    {r.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => void fetchAndRescan()} disabled={!baseRemote || !!busy} title={`Fetch ${baseRemote ?? ''} and remove branches deleted there`}>
                <Icon name="fetch" size={13} /> {busy === 'Fetching' ? 'Fetching…' : `Fetch ${baseRemote ?? ''}`}
              </button>
            </div>
          </div>

          <div className="cleanup-list" role="group" aria-label="Branches to delete">
            {(scan.kind === 'loading' || (checking && rows.length === 0)) && (
              <div className="cleanup-empty">
                <span className="spinner small" /> Looking for merged branches…
              </div>
            )}
            {scan.kind === 'error' && <div className="cleanup-empty field-error">{scan.message}</div>}
            {scan.kind === 'done' && !checking && rows.length === 0 && <div className="cleanup-empty">No merged branches</div>}
            {rows.map((row) => {
              const b = row.branch
              const tag = row.current ? 'current branch' : b.worktree ? 'in worktree' : null
              return (
                <label key={b.name} className={`cleanup-row${row.locked ? ' locked' : ''}`} title={row.locked ?? b.summary}>
                  <input
                    type="checkbox"
                    checked={isSelected(row, picked)}
                    disabled={!!busy || !!row.locked}
                    onChange={(e) => setPicked({ ...picked, [b.name]: e.target.checked })}
                  />
                  <span className="cleanup-name">
                    <span className="ellipsis">{b.name}</span>
                    {tag && <span className="cleanup-tag">{tag}</span>}
                  </span>
                  <span className={`cleanup-reason ${row.status}`} title={STATUS_TITLE[row.status]}>
                    {row.status === 'checking' && <span className="spinner small" />}
                    {STATUS_LABEL[row.status]}
                  </span>
                  <span className="cleanup-meta ellipsis">{[b.author, b.date ? relativeTime(b.date) : null].filter(Boolean).join(' · ')}</span>
                </label>
              )
            })}
          </div>
          {progress && (
            <span className="field-hint cleanup-progress">
              <span className="spinner small" /> Checking squash merges… {progress.done}/{progress.total}
            </span>
          )}
          {checkError && <span className="field-error">Could not check for squash merges: {checkError}</span>}
          {selectable.length > 1 && (
            <div className="cleanup-bulk">
              <button className="btn ghost small" onClick={() => setAll(true)} disabled={!!busy}>
                Select all
              </button>
              <button className="btn ghost small" onClick={() => setAll(false)} disabled={!!busy}>
                Select none
              </button>
              <span className="field-hint">{selected.length} selected</span>
            </div>
          )}
          {!checking && rows.some((r) => r.status === 'gone') && (
            <span className="field-warning">Branches whose upstream was deleted are not selected when they have commits that are not in the base branch.</span>
          )}

          <label className="check">
            <input type="checkbox" checked={alsoRemote} disabled={!!busy} onChange={(e) => setAlsoRemote(e.target.checked)} />
            Also delete their branches on the remote
          </label>
          {alsoRemote && (
            <span className="field-hint">
              {remoteTargets.length
                ? `Deletes ${remoteTargets.map((r) => r.branch.upstream!.replace(/^refs\/remotes\//, '')).join(', ')}.`
                : 'None of the selected branches has a merged branch on the remote.'}
              {keptRemote > 0 && ` Keeps ${keptRemote} remote branch${keptRemote === 1 ? '' : 'es'} with commits that are not in the base branch, or that are protected.`}
            </span>
          )}
        </>
      )}
    </Modal>
  )
}
