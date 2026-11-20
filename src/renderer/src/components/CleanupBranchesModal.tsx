import { useEffect, useMemo, useRef, useState } from 'react'
import type { MergedBranch, Ref } from '@shared/types'
import { useActiveRepo, useStore, type RepoTab } from '../state/store'
import { Modal } from '../ui/Modal'
import { Icon } from '../ui/Icon'
import { offerUndo } from '../actions/undo'
import { relativeTime } from '../util/format'

export function CleanupBranchesModal() {
  const modal = useStore((s) => s.modal)
  const repo = useActiveRepo()
  if (modal?.kind !== 'cleanupBranches' || !repo) return null
  return <CleanupForm repo={repo} initialBase={modal.base} />
}

const REASON_LABEL: Record<MergedBranch['reason'], string> = {
  merged: 'merged',
  squashed: 'squash merged',
  gone: 'upstream deleted'
}

const REASON_TITLE: Record<MergedBranch['reason'], string> = {
  merged: 'Its last commit is in the base branch',
  squashed: 'Its changes are in the base branch as other commits (squash or rebase merge)',
  gone: 'Its branch on the remote was deleted, but its commits were not found in the base branch'
}

/** Remote branches to compare with: each remote's default branch first, then the rest by name. */
function baseCandidates(repo: RepoTab): Ref[] {
  return repo.refs
    .filter((r) => r.type === 'remote')
    .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name))
}

function defaultBase(repo: RepoTab, candidates: Ref[]): string | null {
  const origin = repo.remotes.find((r) => r.name === 'origin')?.name ?? repo.remotes[0]?.name
  const pick =
    candidates.find((r) => r.isDefault && r.remote === origin) ??
    candidates.find((r) => r.isDefault) ??
    candidates.find((r) => r.name === `${origin}/main` || r.name === `${origin}/master`)
  return pick?.fullName ?? null
}

/** The remote an upstream such as "refs/remotes/origin/feature/x" belongs to, and its branch name there. */
function splitUpstream(repo: RepoTab, upstream: string): { remote: string; branch: string } | null {
  const short = upstream.replace(/^refs\/remotes\//, '')
  const remote = repo.remotes
    .map((r) => r.name)
    .filter((r) => short.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0]
  return remote ? { remote, branch: short.slice(remote.length + 1) } : null
}

type Scan = { kind: 'loading' } | { kind: 'done'; branches: MergedBranch[] } | { kind: 'error'; message: string }

function CleanupForm({ repo, initialBase }: { repo: RepoTab; initialBase?: string }) {
  const setModal = useStore((s) => s.setModal)
  const candidates = useMemo(() => baseCandidates(repo), [repo])
  const [base, setBase] = useState<string | null>(() => initialBase ?? defaultBase(repo, candidates))
  const [squashed, setSquashed] = useState(false)
  const [alsoRemote, setAlsoRemote] = useState(false)
  const [scan, setScan] = useState<Scan>({ kind: 'loading' })
  const [rescan, setRescan] = useState(0)
  /** Choices the user made; branches they did not touch follow the default (merged and squashed ticked) */
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const scanId = useRef(0)

  useEffect(() => {
    if (!base) return
    const id = ++scanId.current
    setScan({ kind: 'loading' })
    window.git.mergedBranches(repo.path, base, squashed).then(
      (branches) => id === scanId.current && setScan({ kind: 'done', branches }),
      (e: unknown) => id === scanId.current && setScan({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    )
  }, [repo.path, base, squashed, rescan])

  const branches = scan.kind === 'done' ? scan.branches : []
  const isOn = (b: MergedBranch) => picked[b.name] ?? b.reason !== 'gone'
  const selected = branches.filter(isOn)
  const remoteTargets = alsoRemote ? selected.filter((b) => b.upstream && b.upstreamMerged) : []
  const keptRemote = alsoRemote ? selected.filter((b) => b.upstream && !b.upstreamMerged).length : 0
  const baseRef = candidates.find((r) => r.fullName === base)
  const baseRemote = baseRef?.remote ?? null

  const close = () => !busy && setModal(null)
  const setAll = (on: boolean) => setPicked(Object.fromEntries(branches.map((b) => [b.name, on])))

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
    const locals = selected.map((b) => ({ name: b.name, sha: b.sha, upstream: b.upstream }))
    // remote branches to delete, with the commit each pointed at so undo can push it back
    const remotes = remoteTargets.flatMap((b) => {
      const target = splitUpstream(repo, b.upstream!)
      const sha = repo.refs.find((r) => r.fullName === b.upstream)?.sha
      return target && sha ? [{ ...target, sha }] : []
    })
    let deleted: typeof locals = []
    let deletedRemote: typeof remotes = []
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 'es'}`
    const ok = await useStore.getState().run('Cleaning up branches', async (r) => {
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
          <label className="check" title="Finds branches merged with Squash and merge or Rebase and merge. Compares the patches of every branch, which takes longer.">
            <input type="checkbox" checked={squashed} disabled={!!busy} onChange={(e) => setSquashed(e.target.checked)} />
            Also find squash and rebase merges (slower)
          </label>

          <div className="cleanup-list" role="group" aria-label="Branches to delete">
            {scan.kind === 'loading' && (
              <div className="cleanup-empty">
                <span className="spinner small" /> Looking for merged branches…
              </div>
            )}
            {scan.kind === 'error' && <div className="cleanup-empty field-error">{scan.message}</div>}
            {scan.kind === 'done' && branches.length === 0 && (
              <div className="cleanup-empty">No merged branches{squashed ? '' : '. Squash merges are not checked; turn that on above to find them.'}</div>
            )}
            {branches.map((b) => (
              <label key={b.name} className="cleanup-row" title={b.summary}>
                <input type="checkbox" checked={isOn(b)} disabled={!!busy} onChange={(e) => setPicked({ ...picked, [b.name]: e.target.checked })} />
                <span className="cleanup-name ellipsis">{b.name}</span>
                <span className={`cleanup-reason ${b.reason}`} title={REASON_TITLE[b.reason]}>
                  {REASON_LABEL[b.reason]}
                </span>
                <span className="cleanup-meta ellipsis">
                  {[b.author, b.date ? relativeTime(b.date) : null].filter(Boolean).join(' · ')}
                </span>
              </label>
            ))}
          </div>
          {branches.length > 1 && (
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
          {branches.some((b) => b.reason === 'gone') && (
            <span className="field-warning">Branches whose upstream was deleted are not selected: their commits were not found in the base branch.</span>
          )}

          <label className="check">
            <input type="checkbox" checked={alsoRemote} disabled={!!busy} onChange={(e) => setAlsoRemote(e.target.checked)} />
            Also delete their branches on the remote
          </label>
          {alsoRemote && (
            <span className="field-hint">
              {remoteTargets.length
                ? `Deletes ${remoteTargets.map((b) => b.upstream!.replace(/^refs\/remotes\//, '')).join(', ')}.`
                : 'None of the selected branches has a merged branch on the remote.'}
              {keptRemote > 0 && ` Keeps ${keptRemote} remote branch${keptRemote === 1 ? '' : 'es'} with commits that are not in the base branch, or that are protected.`}
            </span>
          )}
        </>
      )}
    </Modal>
  )
}
