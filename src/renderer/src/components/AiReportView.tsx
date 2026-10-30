// The AI view: a summary of selected commits or a review of a pull request, written by the configured provider.
// Results are kept for the session (and a request still running is shared), so leaving the view and coming back
// doesn't pay for the same reply twice; Regenerate asks again.
import { useEffect, useRef, useState } from 'react'
import type { AiStatus } from '@shared/types'
import { useStore, type AiTask, type RepoTab } from '../state/store'
import { useHosting } from '../state/hosting'
import { Icon } from '../ui/Icon'
import { Markdown } from '../ui/Markdown'
import { copyText } from '../actions/refActions'
import { shortSha } from '../util/format'
import { reviewPullRequest, summarizeCommits, type Report } from '../smart/assist'
import { AiQuickSetup } from './AiQuickSetup'
import '../styles/detail.css'

const reports = new Map<string, Promise<Report>>()

function taskKey(repo: string, task: AiTask): string {
  return task.kind === 'summary' ? `${repo}\0summary\0${task.shas.join(',')}` : `${repo}\0review\0${task.pr.number}\0${task.pr.updatedAt}`
}

function start(repo: string, task: AiTask, progress: (label: string) => void): Promise<Report> {
  if (task.kind === 'summary') return summarizeCommits(repo, task.shas, progress)
  const remote = useHosting.getState().info[repo]?.remote
  if (!remote) return Promise.reject(new Error('The hosting provider of this repository is not known yet. Try again in a moment.'))
  return reviewPullRequest(repo, remote, task.pr, progress)
}

type State = { kind: 'checking' } | { kind: 'setup' } | { kind: 'running'; label: string } | { kind: 'done'; report: Report } | { kind: 'error'; message: string }

export function AiReportView({ repo, task }: { repo: RepoTab; task: AiTask }) {
  const [state, setState] = useState<State>({ kind: 'checking' })
  const [setupDismissed, setSetupDismissed] = useState(false)
  const key = taskKey(repo.path, task)
  const run = useRef(0)

  const generate = (fresh: boolean) => {
    const id = ++run.current
    const live = () => run.current === id
    if (fresh) reports.delete(key)
    let pending = reports.get(key)
    if (!pending) {
      setState({ kind: 'running', label: 'Starting' })
      pending = start(repo.path, task, (label) => live() && setState({ kind: 'running', label }))
      reports.set(key, pending)
      // a failure is not worth keeping: the next visit tries again
      pending.catch(() => reports.get(key) === pending && reports.delete(key))
    } else setState({ kind: 'running', label: 'Waiting for the AI' })
    pending.then(
      (report) => live() && setState({ kind: 'done', report }),
      (e: Error) => live() && setState({ kind: 'error', message: e.message })
    )
  }

  useEffect(() => {
    let cancelled = false
    setSetupDismissed(false)
    if (reports.has(key)) generate(false)
    else {
      setState({ kind: 'checking' })
      void window.ai.status().then(
        (s) => !cancelled && (s.active ? generate(false) : setState({ kind: 'setup' })),
        () => !cancelled && generate(false)
      )
    }
    return () => {
      cancelled = true
      run.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const close = () => useStore.getState().setCenter({ kind: 'graph' })
  const busy = state.kind === 'running' || state.kind === 'checking'
  const title = task.kind === 'summary' ? `Summary of ${task.shas.length} ${task.shas.length === 1 ? 'commit' : 'commits'}` : `AI review of #${task.pr.number}`
  const subtitle =
    task.kind === 'summary'
      ? task.shas.length > 1
        ? `${shortSha(task.shas[0])} … ${shortSha(task.shas[task.shas.length - 1])}`
        : shortSha(task.shas[0])
      : `${task.pr.title} · ${task.pr.headBranch} → ${task.pr.baseBranch}`

  return (
    <div className="view">
      <div className="view-head">
        <Icon name="sparkle" size={14} />
        <span className="title">{title}</span>
        <span className="muted ellipsis" style={{ fontSize: 12 }} title={subtitle}>
          {subtitle}
        </span>
        <span className="grow" />
        {state.kind === 'done' && (
          <button className="btn small" onClick={() => copyText(state.report.text, task.kind === 'summary' ? 'Summary copied' : 'Review copied')}>
            <Icon name="copy" size={12} /> Copy
          </button>
        )}
        {task.kind === 'review' && (
          <button className="btn small" title="Open the pull request in the browser" onClick={() => void window.app.openExternal(task.pr.url)}>
            <Icon name="external" size={12} /> Open on web
          </button>
        )}
        <button className="btn small" disabled={busy || state.kind === 'setup'} onClick={() => generate(true)}>
          <Icon name="refresh" size={12} /> Regenerate
        </button>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={close}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="view-body">
        {state.kind === 'setup' ? (
          <div className="ai-report">
            {setupDismissed ? (
              <div className="view-message">Connect an AI provider in Preferences &gt; AI to use this.</div>
            ) : (
              <AiQuickSetup
                why={task.kind === 'summary' ? 'to summarize these commits' : 'to review this pull request'}
                onConnected={(s: AiStatus) => s.active && generate(true)}
                onDismiss={() => setSetupDismissed(true)}
              />
            )}
          </div>
        ) : state.kind === 'done' ? (
          <div className="ai-report">
            <Markdown source={state.report.text} />
            <div className="ai-report-foot muted">
              {state.report.note && <span>{state.report.note} </span>}
              Written by AI from the diff; check it before relying on it.
            </div>
          </div>
        ) : state.kind === 'error' ? (
          <div className="view-message">
            <span className="field-error">{state.message}</span>
            <button className="btn" onClick={() => generate(true)}>
              Try again
            </button>
          </div>
        ) : (
          <div className="view-message">
            <span className="smart-progress">
              <span className="spinner small" /> {state.kind === 'running' ? `${state.label}…` : 'Checking the AI setup…'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
