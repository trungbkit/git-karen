import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { BlameLine, DiffTarget, FileDiff, FileHistoryCommit } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { formatDate, fullDate, shortSha } from '../util/format'
import { DiffBody, useNewSideLines } from './DiffView'
import { ImageDiff, isImagePath } from './ImageDiff'
import { Avatar } from './CommitDetail'
import { useTokens } from '../highlight/useHighlight'
import { TokenLine } from '../highlight/Highlighted'
import { DelayedDiffSkeleton } from '../ui/Skeleton'
import { useRovingFocus } from '../ui/roving'
import '../styles/detail.css'
import '../styles/review.css'

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { value: T | undefined; error: string | null } {
  const [state, setState] = useState<{ value: T | undefined; error: string | null }>({ value: undefined, error: null })
  useEffect(() => {
    let cancelled = false
    setState({ value: undefined, error: null })
    fn().then(
      (value) => !cancelled && setState({ value, error: null }),
      (e: Error) => !cancelled && setState({ value: undefined, error: e.message })
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

/** The file's change in one commit of its history, under the path it had there (renames show as renames). */
function HistoryDiff({ repo, entry }: { repo: RepoTab; entry: FileHistoryCommit }) {
  const target: DiffTarget = { kind: 'commit', sha: entry.sha, path: entry.path, oldPath: entry.oldPath }
  const { value: diff, error } = useAsync<FileDiff | null>(() => window.git.diff(repo.path, target), [repo.path, JSON.stringify(target)])
  const image = isImagePath(entry.path) && !!diff?.binary
  const fileLines = useNewSideLines(repo.path, target, diff, !image)
  if (error) return <div className="view-message">{error}</div>
  if (diff === undefined) return <DelayedDiffSkeleton />
  if (diff === null) return <div className="view-message">No changes to this file in this commit.</div>
  if (image) return <ImageDiff repo={repo.path} target={target} diff={diff} />
  return <DiffBody diff={diff} layout="unified" wrap={false} fileLines={fileLines} />
}

interface BlameGroup {
  sha: string
  author: string
  date: number
  summary: string
  lines: BlameLine[]
}

/** A blame being looked at: the working copy (`rev` null), or the file before a commit, scrolled to `line`. */
interface BlameStep {
  rev: string | null
  path: string
  line?: number
  /** The commit this step went back from */
  from?: { sha: string; summary: string }
}

const uncommitted = (sha: string) => /^0+$/.test(sha)

function Blame({ repo, path }: { repo: RepoTab; path: string }) {
  const dateMode = useStore((s) => s.prefs.dateFormat)
  // going back in time: each step blames the file as it was before the clicked line's commit
  const [steps, setSteps] = useState<BlameStep[]>([{ rev: null, path }])
  const step = steps[steps.length - 1]
  const { value: lines, error } = useAsync<BlameLine[]>(
    () => window.git.blame(repo.path, step.path, step.rev ?? undefined),
    [repo.path, step.path, step.rev]
  )
  const bodyRef = useRef<HTMLDivElement>(null)

  const text = useMemo(() => (lines ? lines.map((l) => l.content).join('\n') : null), [lines])
  const tokens = useTokens(step.path, text)

  const { groups, oldest, newest } = useMemo(() => {
    const groups: BlameGroup[] = []
    let oldest = Infinity
    let newest = -Infinity
    for (const l of lines ?? []) {
      oldest = Math.min(oldest, l.date)
      newest = Math.max(newest, l.date)
      const last = groups[groups.length - 1]
      if (last && last.sha === l.sha) last.lines.push(l)
      else groups.push({ sha: l.sha, author: l.author, date: l.date, summary: l.summary, lines: [l] })
    }
    return { groups, oldest, newest }
  }, [lines])

  // bring the line we came from into view
  useEffect(() => {
    if (!lines || !step.line) return
    const el = bodyRef.current?.querySelector<HTMLElement>(`.blame-row[data-line="${Math.min(step.line, lines.length)}"]`)
    el?.scrollIntoView({ block: 'center' })
  }, [lines, step.line])

  const crumbs = (
    <div className="blame-crumbs">
      {steps.map((s, i) => {
        const label = s.from ? (
          <>
            before <span className="mono">{shortSha(s.from.sha)}</span>
          </>
        ) : (
          'Working copy'
        )
        const title = s.from ? `${s.path} before ${s.from.summary}` : path
        return (
          <span key={i} style={{ display: 'contents' }}>
            {i > 0 && <span className="sep">›</span>}
            {i === steps.length - 1 ? (
              <span className="current" title={title}>
                {label}
              </span>
            ) : (
              <button title={title} onClick={() => setSteps(steps.slice(0, i + 1))}>
                {label}
              </button>
            )}
          </span>
        )
      })}
      {step.path !== path && <span className="muted">· {step.path}</span>}
    </div>
  )

  if (error)
    return (
      <>
        {steps.length > 1 && crumbs}
        <div className="view-message">{error}</div>
      </>
    )
  if (!lines)
    return (
      <>
        {steps.length > 1 && crumbs}
        <DelayedDiffSkeleton label="Loading blame" />
      </>
    )

  const viewInGraph = (sha: string) => {
    const { select, setCenter } = useStore.getState()
    select({ kind: 'commit', shas: [sha] })
    setCenter({ kind: 'graph' })
  }
  const goBack = (g: BlameGroup, l: BlameLine) => {
    if (!l.previous) return
    setSteps([...steps, { rev: l.previous.sha, path: l.previous.path, line: l.origLine, from: { sha: g.sha, summary: g.summary } }])
  }
  const menu = (g: BlameGroup, l: BlameLine) => (e: MouseEvent) =>
    !uncommitted(g.sha) &&
    showContextMenu(e, [
      { label: 'Blame before this commit', onClick: () => goBack(g, l), disabled: !l.previous },
      { label: 'View commit in graph', onClick: () => viewInGraph(g.sha), disabled: !repo.commits.some((c) => c.sha === g.sha) },
      { label: 'Copy commit SHA', onClick: () => void navigator.clipboard.writeText(g.sha) }
    ])
  // Newer lines get a stronger accent.
  const age = (date: number) => (newest > oldest ? (date - oldest) / (newest - oldest) : 1)

  return (
    <>
      {steps.length > 1 && crumbs}
      <div className="blame" ref={bodyRef}>
        {groups.map((g) =>
          g.lines.map((l, i) => (
            <div key={l.line} data-line={l.line} className={`blame-row ${i === 0 ? 'first' : ''} ${step.line === l.line && steps.length > 1 ? 'target' : ''}`}>
              <span
                className="blame-age"
                style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(15 + age(g.date) * 85)}%, transparent)` }}
              />
              <span
                className="blame-gutter"
                onClick={() => goBack(g, l)}
                onContextMenu={menu(g, l)}
                style={uncommitted(g.sha) || !l.previous ? { cursor: 'default' } : undefined}
                title={
                  uncommitted(g.sha)
                    ? 'Not committed yet'
                    : `${g.summary}\n${g.author} · ${fullDate(g.date)}${l.path !== step.path ? `\nfrom ${l.path}` : ''}\n${
                        l.previous ? 'Click to blame the file before this commit' : 'This commit added the file'
                      } · right-click for more`
                }
              >
                {i === 0 && (
                  <>
                    <span className="mono">{uncommitted(g.sha) ? 'uncommitted' : shortSha(g.sha)}</span>
                    <span className="ellipsis" style={{ flex: 1 }}>
                      {g.author}
                    </span>
                    <span>{formatDate(g.date, dateMode)}</span>
                    {!uncommitted(g.sha) && l.previous && <Icon name="history" size={11} className="back" />}
                  </>
                )}
              </span>
              <span className="ln">{l.line}</span>
              <span className="code">{tokens?.[l.line - 1] && l.content ? <TokenLine tokens={tokens[l.line - 1]} /> : l.content || ' '}</span>
            </div>
          ))
        )}
      </div>
    </>
  )
}

export function FileHistoryView({ repo, path, blame }: { repo: RepoTab; path: string; blame: boolean }) {
  const { setCenter } = useStore.getState()
  const dateMode = useStore((s) => s.prefs.dateFormat)
  const { value: commits, error } = useAsync<FileHistoryCommit[]>(() => window.git.fileHistory(repo.path, path, 500), [repo.path, path])
  const [selected, setSelected] = useState<string | null>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  useRovingFocus(historyRef, { items: '.history-item' })

  useEffect(() => {
    if (commits?.length && !selected) setSelected(commits[0].sha)
  }, [commits, selected])

  const inGraph = (sha: string) => repo.commits.some((c) => c.sha === sha)

  return (
    <div className="view">
      <div className="view-head">
        <Icon name="history" size={14} />
        <span className="title" title={path}>
          {path}
        </span>
        <span className="grow" />
        <div className="seg">
          <button className={!blame ? 'on' : ''} onClick={() => setCenter({ kind: 'history', path, blame: false })}>
            History
          </button>
          <button className={blame ? 'on' : ''} onClick={() => setCenter({ kind: 'history', path, blame: true })}>
            Blame
          </button>
        </div>
        <button className="icon-btn" title="Open in external editor" aria-label="Open in external editor" onClick={() => void window.app.openInEditor(repo.path, path)}>
          <Icon name="external" size={13} />
        </button>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={() => setCenter({ kind: 'graph' })}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {blame ? (
        <div className="view-body">
          <Blame key={path} repo={repo} path={path} />
        </div>
      ) : (
        <div className="history">
          <div className="history-list" ref={historyRef} role="listbox" aria-label="Commits that changed this file">
            {error && <div className="view-message">{error}</div>}
            {!commits && !error && <div className="view-message">Loading history…</div>}
            {commits?.length === 0 && <div className="view-message">No history for this file.</div>}
            {commits?.map((c) => (
              <div key={c.sha} role="option" aria-selected={selected === c.sha} className={`history-item ${selected === c.sha ? 'selected' : ''}`} onClick={() => setSelected(c.sha)}>
                <span className="ellipsis">{c.summary}</span>
                {(c.oldPath || c.path !== path) && (
                  <span className="renamed" title={c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}>
                    {c.oldPath ? `Renamed from ${c.oldPath}` : c.path}
                  </span>
                )}
                <span className="meta">
                  <Avatar name={c.author.name} email={c.author.email} size={16} />
                  <span className="ellipsis">{c.author.name}</span>
                  <span title={fullDate(c.author.date)}>{formatDate(c.author.date, dateMode)}</span>
                  <span className="mono">{shortSha(c.sha)}</span>
                </span>
                {selected === c.sha && inGraph(c.sha) && (
                  <a
                    style={{ fontSize: 11, color: 'var(--text-accent)', cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      useStore.getState().select({ kind: 'commit', shas: [c.sha] })
                      setCenter({ kind: 'graph' })
                    }}
                  >
                    View in graph
                  </a>
                )}
              </div>
            ))}
          </div>
          <div className="view-body">
            {(() => {
              const entry = commits?.find((c) => c.sha === selected)
              return entry ? <HistoryDiff key={entry.sha} repo={repo} entry={entry} /> : null
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
