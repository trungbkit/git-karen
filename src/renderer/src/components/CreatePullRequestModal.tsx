// Create pull request (plan 07.4): base/head, title and description prefilled from the commits, draft and reviewers,
// created through the hosting API with the user's token, then opened in the browser. Without a token (or on a provider
// without API support) the same form opens the provider's "new pull request" page instead.
import { useEffect, useMemo, useState } from 'react'
import type { RepoHosting } from '@shared/integrations'
import { useStore, type RepoTab } from '../state/store'
import { useHosting, useRepoHosting } from '../state/hosting'
import { currentBranch, remoteBranchName } from '../actions/refActions'
import { defaultBranch } from '../actions/compareActions'
import { openIntegrationsSettings } from '../actions/hostingActions'
import { newPullRequestUrl, parseReviewers, prefillPullRequest } from '../util/hosting'
import { Modal } from '../ui/Modal'
import '../styles/detail.css'
import '../styles/hosting.css'

export function CreatePullRequestModal() {
  const modal = useStore((s) => s.modal)
  const repo = useStore((s) => s.repos[s.activeTab])
  if (!repo || modal?.kind !== 'createPullRequest') return null
  return <CreatePullRequest repo={repo} initialHead={modal.head} initialBase={modal.base} />
}

/** The remote a local branch's upstream lives on (longest matching remote name). */
function upstreamRemote(repo: RepoTab, upstream: string | undefined): string | undefined {
  const short = upstream?.replace(/^refs\/remotes\//, '')
  if (!short) return undefined
  return repo.remotes
    .map((r) => r.name)
    .filter((n) => short.startsWith(`${n}/`))
    .sort((a, b) => b.length - a.length)[0]
}

function CreatePullRequest({ repo, initialHead, initialBase }: { repo: RepoTab; initialHead?: string; initialBase?: string }) {
  const { setModal, toast, refresh } = useStore.getState()
  const close = () => setModal(null)
  const info = useRepoHosting(repo.path)
  const locals = useMemo(() => repo.refs.filter((r) => r.type === 'local'), [repo.refs])
  const [head, setHead] = useState(initialHead ?? currentBranch(repo) ?? locals[0]?.name ?? '')
  const headLocal = locals.find((r) => r.name === head)
  const originName = repo.remotes.find((r) => r.name === 'origin')?.name
  const headRemote = upstreamRemote(repo, headLocal?.upstream) ?? originName ?? info?.remote ?? repo.remotes[0]?.name ?? ''
  const baseRemote = info?.remote ?? headRemote
  const baseBranches = useMemo(
    () => repo.refs.filter((r) => r.type === 'remote' && r.remote === baseRemote && !r.name.endsWith('/HEAD')).map(remoteBranchName),
    [repo.refs, baseRemote]
  )
  const [base, setBase] = useState(() => {
    if (initialBase) return initialBase
    const d = defaultBranch(repo)
    return d ? d.replace(new RegExp(`^${baseRemote}/`), '') : 'main'
  })
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [dirty, setDirty] = useState({ title: false, body: false })
  const [draft, setDraft] = useState(false)
  const [reviewers, setReviewers] = useState('')
  const [suggestions, setSuggestions] = useState<string[] | null>(null)
  const [commits, setCommits] = useState<{ count: number; targetExists: boolean } | null>(null)
  const [headInfo, setHeadInfo] = useState<RepoHosting | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remoteHead = repo.refs.find((r) => r.type === 'remote' && r.name === `${headRemote}/${head}`)
  const needsPush = !!headRemote && (!remoteHead || (!!headLocal && remoteHead.sha !== headLocal.sha))
  const [push, setPush] = useState(needsPush)
  useEffect(() => setPush(needsPush), [needsPush])

  // a head in a fork is "owner:branch" on GitHub; learn the fork's owner from its remote
  useEffect(() => {
    if (!headRemote || headRemote === baseRemote) return setHeadInfo(null)
    let cancelled = false
    void window.integrations.repoInfo(repo.path, headRemote).then((i) => !cancelled && setHeadInfo(i), () => undefined)
    return () => {
      cancelled = true
    }
  }, [repo.path, headRemote, baseRemote])

  // prefill title and description from the commits the PR brings, until the user edits them
  useEffect(() => {
    if (!head || !base || !baseRemote) return
    let cancelled = false
    void (async () => {
      const comparison = await window.git.compareBranch(repo.path, head, base, baseRemote).catch(() => null)
      const template = await window.git.prTemplate(repo.path).catch(() => null)
      if (cancelled) return
      const subjects = comparison?.commits ?? []
      const tip = headLocal && repo.commits.find((c) => c.sha === headLocal.sha)
      const p = prefillPullRequest(head, subjects, subjects.length === 1 && tip ? tip.body : null, template?.content ?? null)
      setCommits(comparison ? { count: subjects.length, targetExists: comparison.targetExists } : null)
      setTitle((t) => (dirty.title ? t : p.title))
      setBody((b) => (dirty.body ? b : p.body))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.path, head, base, baseRemote, headLocal?.sha])

  const loadSuggestions = () => {
    if (suggestions || !info?.connected) return
    setSuggestions([])
    void window.integrations.reviewerSuggestions(repo.path, baseRemote).then(setSuggestions, () => undefined)
  }

  const canApi = !!info?.apiSupported && !!info.connected
  const fork = headRemote !== baseRemote ? (headInfo?.owner ?? null) : null

  const pushFirst = async () => {
    if (!push) return
    setBusy(`Pushing ${head} to ${headRemote}`)
    await window.git.push(repo.path, { remote: headRemote, branch: head, setUpstream: !headLocal?.upstream })
  }

  const openOnWeb = async () => {
    if (!info) return
    setError(null)
    try {
      await pushFirst()
      await window.app.openExternal(newPullRequestUrl(info, { base, head, headOwner: fork, title: title.trim(), body }))
      if (push) void refresh(repo.path)
      close()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    setError(null)
    try {
      await pushFirst()
      setBusy('Creating pull request')
      const res = await window.integrations.createPullRequest(repo.path, {
        baseRemote,
        headRemote,
        base,
        head,
        title: title.trim(),
        body,
        draft,
        reviewers: parseReviewers(reviewers)
      })
      toast({
        kind: 'success',
        title: res.existing ? `#${res.number} is already open` : `Pull request #${res.number} created`,
        message: `${head} → ${base}`,
        action: { label: 'Open', run: () => void window.app.openExternal(res.url) }
      })
      if (res.warning) toast({ kind: 'info', title: 'Pull request created with a warning', message: res.warning, duration: 8000 })
      void window.app.openExternal(res.url)
      void useHosting.getState().loadPrs(repo.path)
      if (push) void refresh(repo.path)
      close()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const invalid = !head || !base || (head === base && headRemote === baseRemote) ? 'Choose two different branches.' : !title.trim() ? 'A title is required.' : null

  if (info === null) {
    return (
      <Modal title="Create pull request" onClose={close} width={520}>
        <div className="cpr">
          <span className="field-warning">
            {repo.remotes.length === 0 ? 'This repository has no remote.' : 'The remote is not on a recognized hosting provider (GitHub, GitLab, Bitbucket, Azure DevOps).'}
          </span>
          <span className="hint">Self-hosted GitHub Enterprise or GitLab? Add the host in Preferences &gt; Integrations. The smart commit flow can still open GitHub PRs with the gh CLI.</span>
          <div className="int-row">
            <button className="btn" onClick={openIntegrationsSettings}>
              Integrations…
            </button>
            <button className="btn" onClick={() => setModal({ kind: 'smartCommit', prOnly: true })}>
              Pull request with gh CLI…
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={info ? `Create ${info.kind === 'gitlab' ? 'merge request' : 'pull request'} on ${info.label}` : 'Create pull request'}
      onClose={close}
      width={640}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className={`btn ${canApi ? '' : 'primary'}`} disabled={!info || !!busy || !head || !base} onClick={() => void openOnWeb()} title="Open the provider's page with the branches filled in">
            Open on web
          </button>
          {canApi && (
            <button className="btn primary" disabled={!!busy || !!invalid} title={invalid ?? undefined} onClick={() => void create()}>
              {busy ?? (draft ? 'Create draft' : 'Create')}
            </button>
          )}
        </>
      }
    >
      <div className="cpr">
        {info && !info.apiSupported && <span className="hint">{info.label} pull requests open on the web; creating them in the app is supported for GitHub and GitLab.</span>}
        {info?.apiSupported && !info.connected && (
          <span className="hint">
            No {info.label} token for {info.host}: “Open on web” fills in the provider’s page.{' '}
            <a
              className="issue-link"
              onClick={(e) => {
                e.preventDefault()
                openIntegrationsSettings()
              }}
            >
              Add a token
            </a>{' '}
            to create it here with draft and reviewers.
          </span>
        )}
        <div className="cpr-branches">
          <div className="field">
            <label>From {headRemote && `(${fork ? `${fork} · ` : ''}${headRemote})`}</label>
            <select value={head} onChange={(e) => setHead(e.target.value)}>
              {!locals.some((r) => r.name === head) && head && <option value={head}>{head}</option>}
              {locals.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <span className="cpr-arrow">→</span>
          <div className="field">
            <label>Into ({info ? `${info.path} · ${baseRemote}` : baseRemote})</label>
            {baseBranches.length ? (
              <select value={base} onChange={(e) => setBase(e.target.value)}>
                {!baseBranches.includes(base) && <option value={base}>{base}</option>}
                {baseBranches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <input value={base} onChange={(e) => setBase(e.target.value.trim())} />
            )}
          </div>
        </div>
        {commits && (
          <span className={commits.targetExists && commits.count > 0 ? 'cpr-commits' : 'field-warning'}>
            {!commits.targetExists
              ? `${baseRemote}/${base} does not exist (fetch first?).`
              : commits.count === 0
                ? `${head} has no commits that ${baseRemote}/${base} doesn't have${needsPush ? ' yet (push it first)' : ''}.`
                : `${commits.count}${commits.count >= 30 ? '+' : ''} commit${commits.count === 1 ? '' : 's'} will be included.`}
          </span>
        )}
        {headRemote && (
          <label className="check">
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
            Push {head} to {headRemote} first{needsPush ? (remoteHead ? ' (it has unpushed commits)' : ' (not on the remote yet)') : ''}
          </label>
        )}
        <div className="field">
          <label>Title</label>
          <input
            value={title}
            autoFocus
            onChange={(e) => {
              setTitle(e.target.value)
              setDirty((d) => ({ ...d, title: true }))
            }}
          />
        </div>
        <div className="field">
          <label>Description</label>
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              setDirty((d) => ({ ...d, body: true }))
            }}
          />
        </div>
        {canApi && (
          <>
            <div className="field">
              <label>Reviewers</label>
              <input value={reviewers} list="cpr-reviewers" placeholder="logins, comma separated" onFocus={loadSuggestions} onChange={(e) => setReviewers(e.target.value)} />
              <datalist id="cpr-reviewers">
                {(suggestions ?? []).map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
              {info?.kind === 'github' && <span className="hint">Use org/team to request a team.</span>}
            </div>
            <label className="check">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Create as draft
            </label>
          </>
        )}
        {error && <span className="field-error">{error}</span>}
      </div>
    </Modal>
  )
}
