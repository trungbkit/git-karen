// The log of a GitHub Actions job: groups collapsed except those with errors, annotations coloured, search, jump to
// the first error. Shown inside the pull request dialog (Checks) and on its own from a CI badge in the graph.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CiState, JobLog } from '@shared/integrations'
import { useStore } from '../state/store'
import { useHosting } from '../state/hosting'
import { parseActionsLog, plainLog, searchLog, type LogBlock, type LogLine } from '../util/actionsLog'
import { CiIcon } from '../graph/CiBadge'
import { Icon } from '../ui/Icon'
import { Modal } from '../ui/Modal'
import '../styles/hosting.css'

/** Re-check a job that hasn't finished this often */
const POLL_MS = 10_000

export function jobState(status: string, conclusion: string | null): CiState {
  if (status !== 'completed') return 'pending'
  if (conclusion === 'success') return 'success'
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure' || conclusion === 'action_required') return 'failure'
  return 'neutral'
}

export function JobLogModal() {
  const modal = useStore((s) => s.modal)
  const repo = useStore((s) => s.activeTab)
  const remote = useHosting((s) => s.info[repo]?.remote ?? null)
  if (modal?.kind !== 'jobLog') return null
  const close = () => useStore.getState().setModal(null)
  return (
    <Modal title="GitHub Actions log" onClose={close} width={900}>
      <JobLogView repo={repo} remote={remote} jobId={modal.jobId} />
    </Modal>
  )
}

export function JobLogView({ repo, remote, jobId, onBack }: { repo: string; remote: string | null; jobId: number; onBack?(): void }) {
  const [job, setJob] = useState<JobLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const [times, setTimes] = useState(false)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setJob(await window.integrations.jobLog(repo, remote, jobId))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [repo, remote, jobId])

  useEffect(() => void load(), [load])
  const running = !!job && job.status !== 'completed'
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [running, load])

  const blocks = useMemo(() => parseActionsLog(job?.log ?? ''), [job?.log])
  // groups with errors start open, like on GitHub
  useEffect(() => setOpen(new Set(blocks.flatMap((b, i) => (b.hasError ? [i] : [])))), [blocks])
  const hits = useMemo(() => searchLog(blocks, query), [blocks, query])
  const firstError = useMemo(() => blocks.flatMap((b) => b.lines).find((l) => l.kind === 'error')?.n ?? null, [blocks])

  const reveal = (n: number) => {
    const i = blocks.findIndex((b) => b.title?.n === n || b.lines.some((l) => l.n === n))
    if (i >= 0 && blocks[i].title && !open.has(i)) setOpen((s) => new Set(s).add(i))
    requestAnimationFrame(() => box.current?.querySelector(`[data-n="${n}"]`)?.scrollIntoView({ block: 'center' }))
  }
  const step = (d: number) => {
    if (!hits.length) return
    const next = (hit + d + hits.length) % hits.length
    setHit(next)
    reveal(hits[next])
  }
  useEffect(() => {
    setHit(0)
    if (hits.length) reveal(hits[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits])

  const copy = () =>
    void navigator.clipboard.writeText(plainLog(blocks)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })

  const current = hits[hit]
  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s)
      if (!next.delete(i)) next.add(i)
      return next
    })

  return (
    <div className="jl">
      <div className="jl-head">
        {onBack && (
          <button className="btn small ghost" onClick={onBack}>
            <Icon name="chevron-left" size={11} /> Checks
          </button>
        )}
        {job && <CiIcon state={jobState(job.status, job.conclusion)} />}
        <span className="jl-title ellipsis">{job ? `${job.workflow ? `${job.workflow} / ` : ''}${job.name}` : `Job ${jobId}`}</span>
        <span className="jl-status">{job ? (job.status === 'completed' ? (job.conclusion ?? 'completed') : job.status.replace('_', ' ')) : ''}</span>
        <span className="jl-spacer" />
        <button className="icon-btn" title="Reload" aria-label="Reload log" onClick={() => void load()}>
          <Icon name="refresh" size={12} className={loading ? 'spin' : undefined} />
        </button>
        {job?.url && (
          <button className="icon-btn" title="Open on GitHub" aria-label="Open on GitHub" onClick={() => void window.app.openExternal(job.url)}>
            <Icon name="external" size={12} />
          </button>
        )}
      </div>
      {error && <span className="field-error">{error}</span>}
      {job && job.steps.length > 0 && (
        <div className="jl-steps">
          {job.steps.map((s) => (
            <span key={s.number} className="jl-step" title={`${s.name}: ${s.conclusion ?? s.status}`}>
              <CiIcon state={jobState(s.status, s.conclusion)} size={10} /> {s.name}
            </span>
          ))}
        </div>
      )}
      {running && <span className="hint">The job is {job.status.replace('_', ' ')}; GitHub serves its log once it finishes. Checking every 10 seconds…</span>}
      {job && !running && (
        <>
          <div className="jl-tools">
            <input
              className="jl-search"
              placeholder="Search the log"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  step(e.shiftKey ? -1 : 1)
                }
              }}
            />
            <span className="jl-count">{query.trim() ? (hits.length ? `${hit + 1}/${hits.length}` : 'No match') : ''}</span>
            <button className="icon-btn" disabled={!hits.length} aria-label="Previous match" onClick={() => step(-1)}>
              <Icon name="chevron-up" size={12} />
            </button>
            <button className="icon-btn" disabled={!hits.length} aria-label="Next match" onClick={() => step(1)}>
              <Icon name="chevron-down" size={12} />
            </button>
            <span className="jl-spacer" />
            <button className="btn small" disabled={firstError === null} onClick={() => firstError !== null && reveal(firstError)}>
              First error
            </button>
            <label className="check">
              <input type="checkbox" checked={times} onChange={(e) => setTimes(e.target.checked)} /> Timestamps
            </label>
            <button className="btn small" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {job.truncated && <span className="hint">The log is long; only its end is shown. Open it on GitHub for the rest.</span>}
          <div className="jl-log" ref={box}>
            {blocks.length === 0 && <div className="jl-empty">The log is empty.</div>}
            {blocks.map((b, i) => (
              <Block key={i} block={b} open={!b.title || open.has(i)} onToggle={() => toggle(i)} times={times} current={current} query={query.trim()} />
            ))}
          </div>
        </>
      )}
      {!job && !error && <span className="hint">Loading…</span>}
    </div>
  )
}

function Block({ block, open, onToggle, times, current, query }: { block: LogBlock; open: boolean; onToggle(): void; times: boolean; current?: number; query: string }) {
  return (
    <>
      {block.title && (
        <div className={`jl-line jl-group${block.hasError ? ' has-error' : ''}${current === block.title.n ? ' current' : ''}`} data-n={block.title.n} onClick={onToggle}>
          <span className="jl-n">{block.title.n}</span>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={10} />
          {times && <span className="jl-time">{block.title.time}</span>}
          <span className="jl-text">
            <Text text={block.title.text} query={query} />
          </span>
        </div>
      )}
      {open && block.lines.map((l) => <Line key={l.n} line={l} times={times} current={current === l.n} query={query} nested={!!block.title} />)}
    </>
  )
}

function Line({ line, times, current, query, nested }: { line: LogLine; times: boolean; current: boolean; query: string; nested: boolean }) {
  return (
    <div className={`jl-line jl-${line.kind}${current ? ' current' : ''}${nested ? ' nested' : ''}`} data-n={line.n}>
      <span className="jl-n">{line.n}</span>
      {times && <span className="jl-time">{line.time}</span>}
      <span className="jl-text">
        {line.kind === 'error' ? 'Error: ' : line.kind === 'warning' ? 'Warning: ' : ''}
        <Text text={line.text} query={query} />
      </span>
    </div>
  )
}

function Text({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: (string | { m: string })[] = []
  let from = 0
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    parts.push(text.slice(from, i), { m: text.slice(i, i + q.length) })
    from = i + q.length
  }
  parts.push(text.slice(from))
  return <>{parts.map((p, i) => (typeof p === 'string' ? p : <mark key={i}>{p.m}</mark>))}</>
}
