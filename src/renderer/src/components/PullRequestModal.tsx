// A GitHub pull request in the app: its description and conversation with a box to comment, approve or request
// changes; its checks, with the logs of GitHub Actions jobs; and merging (merge, squash or rebase, optionally deleting
// the branch). Everything goes through the hosting API with the host's token (keychain or GitHub CLI).
import { useCallback, useEffect, useState } from 'react'
import type { MergeMethod, PullRequestDetail, ReviewEvent, TimelineItem } from '@shared/integrations'
import { useStore, type RepoTab } from '../state/store'
import { useHosting } from '../state/hosting'
import { checkoutPullRequest } from '../actions/hostingActions'
import { relativeTime } from '../util/format'
import { CiIcon, ciSummary } from '../graph/CiBadge'
import { Markdown } from '../ui/Markdown'
import { Modal } from '../ui/Modal'
import { Icon } from '../ui/Icon'
import { confirm } from '../ui/dialogs'
import { JobLogView } from './JobLogView'
import '../styles/detail.css'
import '../styles/hosting.css'

type Tab = 'conversation' | 'checks' | 'merge'

const METHOD_LABEL: Record<MergeMethod, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' }
const KIND_LABEL: Record<TimelineItem['kind'], string> = {
  comment: 'commented',
  approved: 'approved',
  changes_requested: 'requested changes',
  commented: 'reviewed',
  dismissed: 'review dismissed'
}

export function PullRequestModal() {
  const modal = useStore((s) => s.modal)
  const repo = useStore((s) => s.repos[s.activeTab])
  if (!repo || modal?.kind !== 'pullRequest') return null
  return <PullRequestView key={`${repo.path}#${modal.number}`} repo={repo} number={modal.number} initialTab={modal.tab ?? 'conversation'} />
}

function when(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : relativeTime(t)
}

function PullRequestView({ repo, number, initialTab }: { repo: RepoTab; number: number; initialTab: Tab }) {
  const close = () => useStore.getState().setModal(null)
  const remote = useHosting((s) => s.info[repo.path]?.remote ?? null)
  const [pr, setPr] = useState<PullRequestDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [log, setLog] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPr(await window.integrations.pullRequest(repo.path, remote, number))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [repo.path, remote, number])
  useEffect(() => void load(), [load])

  const checks = pr?.checks
  const title = (
    <span className="prd-title">
      <span className="prd-num">#{number}</span> <span className="ellipsis">{pr?.title ?? 'Pull request'}</span>
    </span>
  )
  return (
    <Modal
      title={title}
      onClose={close}
      width={860}
      footer={
        <>
          <button className="icon-btn" title="Reload" aria-label="Reload pull request" onClick={() => void load()}>
            <Icon name="refresh" size={12} className={loading ? 'spin' : undefined} />
          </button>
          <span className="jl-spacer" />
          {pr && (
            <button className="btn" onClick={() => void window.app.openExternal(pr.url)}>
              Open on GitHub
            </button>
          )}
          {pr?.state === 'open' && (
            <button
              className="btn"
              onClick={() => {
                close()
                void checkoutPullRequest(repo, pr)
              }}
            >
              Check out
            </button>
          )}
          <button className="btn" onClick={close}>
            Close
          </button>
        </>
      }
    >
      {error && !pr && <span className="field-error">{error}</span>}
      {!pr && !error && <span className="hint">Loading…</span>}
      {pr && (
        <div className="prd">
          <Meta pr={pr} />
          <div className="cmp-tabs prd-tabs">
            {(['conversation', 'checks', 'merge'] as Tab[]).map((t) => (
              <button
                key={t}
                className={tab === t ? 'on' : ''}
                onClick={() => {
                  setTab(t)
                  setLog(null)
                }}
              >
                {t === 'conversation' ? `Conversation${pr.timeline.length ? ` (${pr.timeline.length})` : ''}` : t === 'checks' ? (
                  <>
                    {checks && <CiIcon state={checks.state} size={11} />} Checks{checks ? ` (${checks.checks.length})` : ''}
                  </>
                ) : (
                  'Merge'
                )}
              </button>
            ))}
          </div>
          {error && <span className="field-error">{error}</span>}
          {tab === 'conversation' && <Conversation repo={repo.path} remote={remote} pr={pr} onChanged={load} />}
          {tab === 'checks' &&
            (log !== null ? (
              <JobLogView repo={repo.path} remote={remote} jobId={log} onBack={() => setLog(null)} />
            ) : (
              <Checks pr={pr} onLog={setLog} />
            ))}
          {tab === 'merge' && <Merge repo={repo} remote={remote} pr={pr} onChanged={load} />}
        </div>
      )}
    </Modal>
  )
}

function Meta({ pr }: { pr: PullRequestDetail }) {
  const state = pr.state === 'open' && pr.draft ? 'draft' : pr.state
  return (
    <div className="prd-meta">
      <span className={`prd-state prd-state-${state}`}>{state}</span>
      <span>
        <b>{pr.author}</b> wants to merge <code>{pr.headBranch}</code> into <code>{pr.baseBranch}</code>
      </span>
      <span className="prd-diffstat">
        <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span> · {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
      </span>
      {pr.reviewDecision && <span className={`prd-review prd-review-${pr.reviewDecision}`}>{pr.reviewDecision.replace('_', ' ')}</span>}
    </div>
  )
}

// ------------------------------------------------------------ conversation

function Conversation({ repo, remote, pr, onChanged }: { repo: string; remote: string | null; pr: PullRequestDetail; onChanged(): Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const own = !!pr.viewer && pr.viewer === pr.author
  const closed = pr.state !== 'open'

  const send = async (what: 'comment' | ReviewEvent) => {
    setBusy(what)
    setError(null)
    try {
      if (what === 'comment') await window.integrations.commentPullRequest(repo, remote, pr.number, text)
      else await window.integrations.reviewPullRequest(repo, remote, pr.number, { event: what, body: text })
      setText('')
      const done = what === 'comment' ? 'Comment posted' : what === 'approve' ? 'Approved' : 'Changes requested'
      useStore.getState().toast({ kind: 'success', title: `${done} on #${pr.number}` })
      await onChanged()
      void useHosting.getState().loadPrs(repo)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const reviewTip = own ? 'You cannot review your own pull request' : closed ? 'The pull request is not open' : undefined

  return (
    <div className="prd-conv">
      <div className="prd-item">
        <div className="prd-item-head">
          <b>{pr.author}</b> <span className="muted">opened this pull request</span>
        </div>
        {pr.body.trim() ? <Markdown source={pr.body} /> : <span className="muted">No description.</span>}
      </div>
      {pr.timeline.map((t, i) => (
        <div key={i} className={`prd-item prd-${t.kind}`}>
          <div className="prd-item-head">
            <b>{t.author || 'ghost'}</b> <span className={`prd-kind prd-kind-${t.kind}`}>{KIND_LABEL[t.kind] ?? t.kind}</span>
            <span className="muted">{when(t.createdAt)}</span>
            {t.url && (
              <a className="issue-link prd-link" onClick={() => void window.app.openExternal(t.url)}>
                {t.codeComments ? `${t.codeComments} comment${t.codeComments === 1 ? '' : 's'} on code` : 'Open'}
              </a>
            )}
          </div>
          {t.body.trim() && <Markdown source={t.body} />}
        </div>
      ))}
      <div className="prd-compose">
        <textarea
          placeholder={closed ? 'Leave a comment' : 'Leave a comment, or a note with your review'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
              e.preventDefault()
              void send('comment')
            }
          }}
        />
        {error && <span className="field-error">{error}</span>}
        <div className="int-row prd-actions">
          <span className="hint">⌘/Ctrl+Enter to comment. Reviews here cover the whole pull request; comment on lines of code on GitHub.</span>
          <button className="btn" disabled={!!busy || !!reviewTip || !text.trim()} title={reviewTip ?? 'Request changes, with the text above as the reason'} onClick={() => void send('request_changes')}>
            {busy === 'request_changes' ? 'Sending…' : 'Request changes'}
          </button>
          <button className="btn" disabled={!!busy || !!reviewTip} title={reviewTip ?? 'Approve, with the text above as an optional note'} onClick={() => void send('approve')}>
            {busy === 'approve' ? 'Sending…' : 'Approve'}
          </button>
          <button className="btn primary" disabled={!!busy || !text.trim()} onClick={() => void send('comment')}>
            {busy === 'comment' ? 'Sending…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ checks

function Checks({ pr, onLog }: { pr: PullRequestDetail; onLog(jobId: number): void }) {
  const st = pr.checks
  if (!st || st.checks.length === 0) return <span className="hint">No checks reported for the head commit.</span>
  const order = { failure: 0, pending: 1, success: 2, neutral: 3 }
  const checks = [...st.checks].sort((a, b) => order[a.state] - order[b.state])
  return (
    <div className="prd-checks">
      <div className="prd-checks-head">
        <CiIcon state={st.state} /> {ciSummary(st)}
      </div>
      {checks.map((c, i) => (
        <div key={i} className="prd-check">
          <CiIcon state={c.state} size={11} />
          <span className="prd-check-name ellipsis" title={c.name}>
            {c.name || '(unnamed)'}
          </span>
          {c.description && <span className="muted ellipsis">{c.description}</span>}
          <span className="jl-spacer" />
          {c.jobId !== undefined && (
            <button className="btn small" onClick={() => onLog(c.jobId!)}>
              Log
            </button>
          )}
          {c.url && (
            <button className="icon-btn" title="Open on the web" aria-label={`Open ${c.name}`} onClick={() => void window.app.openExternal(c.url!)}>
              <Icon name="external" size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- merge

/** What stands between the pull request and a merge, from GitHub's merge state. */
function mergeNotes(pr: PullRequestDetail): { text: string; level: 'ok' | 'warn' | 'block' }[] {
  const notes: { text: string; level: 'ok' | 'warn' | 'block' }[] = []
  if (pr.state === 'merged') return [{ text: 'This pull request was merged.', level: 'ok' }]
  if (pr.state === 'closed') return [{ text: 'This pull request is closed.', level: 'block' }]
  if (pr.draft) notes.push({ text: 'Draft pull requests cannot be merged; mark it ready for review on GitHub first.', level: 'block' })
  if (pr.mergeable === 'conflicting' || pr.mergeState === 'dirty') notes.push({ text: `It conflicts with ${pr.baseBranch}; resolve the conflicts first.`, level: 'block' })
  if (pr.mergeable === 'unknown' || pr.mergeState === 'unknown') notes.push({ text: 'GitHub is still checking whether it can be merged; reload in a moment.', level: 'warn' })
  if (pr.reviewDecision === 'changes_requested') notes.push({ text: 'Changes were requested.', level: 'warn' })
  if (pr.reviewDecision === 'review_required') notes.push({ text: 'An approving review is required.', level: 'warn' })
  if (pr.checks?.state === 'failure') notes.push({ text: 'Some checks failed.', level: 'warn' })
  if (pr.checks?.state === 'pending') notes.push({ text: 'Some checks are still running.', level: 'warn' })
  if (pr.mergeState === 'behind') notes.push({ text: `The branch is behind ${pr.baseBranch}.`, level: 'warn' })
  if (pr.mergeState === 'blocked') notes.push({ text: 'Branch protection blocks the merge (required reviews or checks). Only users allowed to bypass it can merge.', level: 'warn' })
  if (notes.length === 0) notes.push({ text: 'Ready to merge.', level: 'ok' })
  return notes
}

function Merge({ repo, remote, pr, onChanged }: { repo: RepoTab; remote: string | null; pr: PullRequestDetail; onChanged(): Promise<void> }) {
  const [method, setMethod] = useState<MergeMethod>(pr.defaultMergeMethod)
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const notes = mergeNotes(pr)
  const blocked = pr.state !== 'open' || notes.some((n) => n.level === 'block')
  const defaultTitle = method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number} from ${pr.headBranch}`

  const merge = async () => {
    const what = method === 'merge' ? 'Merge' : method === 'squash' ? 'Squash and merge' : 'Rebase and merge'
    if (!(await confirm(`${what} #${pr.number} into ${pr.baseBranch}?`, pr.title, { confirmLabel: what }))) return
    setBusy(true)
    setError(null)
    const s = useStore.getState()
    try {
      const res = await window.integrations.mergePullRequest(repo.path, remote, pr.number, {
        method,
        title: method === 'rebase' ? null : title.trim() || null,
        message: method === 'rebase' ? null : message.trim() || null,
        sha: pr.headSha,
        deleteBranch
      })
      s.toast({ kind: 'success', title: `Merged #${pr.number}`, message: res.branchDeleted ? `Deleted ${pr.headBranch} on GitHub.` : undefined })
      if (res.warning) s.toast({ kind: 'info', title: 'Merged with a warning', message: res.warning, duration: 8000 })
      void useHosting.getState().loadPrs(repo.path)
      if (remote) void s.run(`Fetching ${remote}`, (r) => window.git.fetch(r, remote, true), { repo: repo.path })
      await onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="prd-merge">
      <ul className="prd-notes">
        {notes.map((n, i) => (
          <li key={i} className={`prd-note ${n.level}`}>
            <Icon name={n.level === 'ok' ? 'check' : n.level === 'block' ? 'x' : 'warning'} size={12} /> {n.text}
          </li>
        ))}
      </ul>
      {pr.state === 'open' && (
        <>
          <div className="seg prd-methods" role="radiogroup" aria-label="Merge method">
            {pr.mergeMethods.map((m) => (
              <button key={m} role="radio" aria-checked={method === m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>
                {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
          {method !== 'rebase' ? (
            <>
              <div className="field">
                <label>Commit title</label>
                <input value={title} placeholder={defaultTitle} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="field">
                <label>Commit message</label>
                <textarea value={message} placeholder={method === 'squash' ? 'GitHub’s default: the commit messages' : 'GitHub’s default: the pull request title'} onChange={(e) => setMessage(e.target.value)} />
              </div>
            </>
          ) : (
            <span className="hint">Each commit of {pr.headBranch} is replayed onto {pr.baseBranch}, without a merge commit.</span>
          )}
          {pr.sameRepo ? (
            pr.deleteBranchOnMerge ? (
              <span className="hint">GitHub deletes {pr.headBranch} after merging (repository setting).</span>
            ) : (
              <label className="check">
                <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> Delete {pr.headBranch} on GitHub after merging
              </label>
            )
          ) : (
            <span className="hint">The branch is in a fork and stays there.</span>
          )}
          {error && <span className="field-error">{error}</span>}
          <div>
            <button className="btn primary" disabled={busy || blocked} onClick={() => void merge()}>
              {busy ? 'Merging…' : METHOD_LABEL[method] === 'Create a merge commit' ? 'Merge pull request' : METHOD_LABEL[method]}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
