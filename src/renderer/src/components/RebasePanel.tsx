import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Commit, RebaseTodoItem } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { shortSha } from '../util/format'
import { runRestorable } from '../actions/undo'
import '../styles/detail.css'

type Action = 'pick' | 'reword' | 'squash' | 'drop'

interface Row {
  commit: Commit
  action: Action
  message: string
}

const KEY_ACTION: Record<string, Action> = { p: 'pick', r: 'reword', s: 'squash', d: 'drop' }

function fullMessage(c: Commit): string {
  return c.body ? `${c.summary}\n\n${c.body}` : c.summary
}

/**
 * Commits that `git rebase -i <onto>` would replay: first-parent walk from HEAD down to `onto`.
 * Returned newest first. Throws a readable error when the range cannot be rebased here.
 */
function rebaseRange(repo: RepoTab, onto: string): Commit[] {
  const head = repo.status?.headSha
  if (!head) throw new Error('HEAD is not on a commit.')
  const bySha = new Map(repo.commits.map((c) => [c.sha, c]))
  const out: Commit[] = []
  let sha: string | undefined = head
  while (sha && sha !== onto) {
    const c = bySha.get(sha)
    if (!c) throw new Error('The selected commit is not an ancestor of the current branch (or is beyond the loaded history).')
    if (c.parents.length > 1) throw new Error(`The range contains merge commit ${shortSha(c.sha)}; interactive rebase across merges is not supported.`)
    out.push(c)
    sha = c.parents[0]
  }
  if (sha !== onto) throw new Error('The selected commit is not an ancestor of the current branch.')
  return out
}

export function RebasePanel({ repo, onto, shas }: { repo: RepoTab; onto: string; shas: string[] }) {
  const { setCenter } = useStore.getState()
  const range = useMemo(() => {
    try {
      return { commits: rebaseRange(repo, onto), error: null }
    } catch (e) {
      return { commits: [] as Commit[], error: (e as Error).message }
    }
    // Only HEAD and onto define the range; ignoring later commit-list refreshes (e.g. auto-fetch)
    // keeps the user's edits from being reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.status?.headSha, onto])

  const initialRows = () => range.commits.map((commit) => ({ commit, action: 'pick' as Action, message: fullMessage(commit) }))
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [focus, setFocus] = useState(() => Math.max(0, range.commits.findIndex((c) => shas.includes(c.sha))))
  const [editing, setEditing] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setRows(initialRows())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  const branch = repo.status?.branch ?? 'HEAD'
  const ontoCommit = repo.commits.find((c) => c.sha === onto)
  const close = () => setCenter({ kind: 'graph' })

  const setAction = (i: number, action: Action) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, action } : r)))
    setEditing(action === 'reword' ? rows[i].commit.sha : null)
  }

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    setRows((rs) => {
      const next = [...rs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setFocus(j)
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'SELECT') return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const dir = e.key === 'ArrowUp' ? -1 : 1
      if (e.altKey) move(focus, dir)
      else setFocus((f) => Math.max(0, Math.min(rows.length - 1, f + dir)))
      return
    }
    const action = KEY_ACTION[e.key.toLowerCase()]
    if (action && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      setAction(focus, action)
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }

  // Rows are displayed newest first; the oldest commit is the last row and cannot be squashed.
  const oldestIndex = rows.length - 1
  const invalid =
    rows.length === 0
      ? 'Nothing to rebase.'
      : rows[oldestIndex]?.action === 'squash'
        ? 'The oldest commit cannot be squashed (there is nothing to squash into).'
        : rows.every((r) => r.action === 'drop')
          ? null
          : rows.some((r) => r.action === 'reword' && !r.message.trim())
            ? 'Reworded commits need a message.'
            : null

  const start = async () => {
    const todo: RebaseTodoItem[] = [...rows].reverse().map((r) => ({
      action: r.action,
      sha: r.commit.sha,
      ...(r.action === 'reword' ? { message: r.message.trim() } : {})
    }))
    const ok = await runRestorable('Rebasing', null, (r) => window.git.interactiveRebase(r, onto, todo), {
      success: 'Rebase complete',
      undoLabel: `Interactive rebase of ${branch}`
    })
    if (ok) close()
  }

  return (
    <div className="view">
      <div className="view-head">
        <Icon name="merge" size={14} />
        <span className="title">
          Interactive rebase <span className="muted">{branch}</span> onto{' '}
          <span className="mono">{shortSha(onto)}</span>
        </span>
        <span className="grow" />
        <button className="btn small" onClick={() => (setRows(initialRows()), setEditing(null))}>
          Reset
        </button>
        <button className="btn small" onClick={close}>
          Cancel
        </button>
        <button className="btn small primary" disabled={!!range.error || !!invalid || !!repo.busy} onClick={() => void start()}>
          Start rebase
        </button>
      </div>
      <div className="view-body" ref={listRef} tabIndex={0} onKeyDown={onKey} style={{ outline: 'none' }}>
        {range.error ? (
          <div className="view-message">{range.error}</div>
        ) : (
          <div className="rebase-list">
            {rows.map((r, i) => (
              <div key={r.commit.sha}>
                <div className={`rebase-row ${focus === i ? 'focused' : ''} ${r.action}`} onMouseDown={() => setFocus(i)}>
                  <select className={`action-${r.action}`} value={r.action} onChange={(e) => setAction(i, e.target.value as Action)}>
                    <option value="pick">Pick</option>
                    <option value="reword">Reword</option>
                    <option value="squash" disabled={i === oldestIndex}>
                      Squash
                    </option>
                    <option value="drop">Drop</option>
                  </select>
                  <span className="mono muted">{shortSha(r.commit.sha)}</span>
                  <span className="rebase-summary" onDoubleClick={() => setAction(i, 'reword')}>
                    {r.action === 'reword' ? r.message.split('\n')[0] : r.commit.summary}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {r.commit.author.name}
                  </span>
                  <button className="icon-btn" title="Move up (Alt+↑)" aria-label="Move commit up" disabled={i === 0} onClick={() => move(i, -1)}>
                    ▲
                  </button>
                  <button className="icon-btn" title="Move down (Alt+↓)" aria-label="Move commit down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                    ▼
                  </button>
                </div>
                {r.action === 'reword' && editing === r.commit.sha && (
                  <div className="rebase-reword">
                    <textarea
                      autoFocus
                      value={r.message}
                      onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                          e.preventDefault()
                          e.stopPropagation()
                          setEditing(null)
                          listRef.current?.focus()
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
            <div className="rebase-row base">
              <span style={{ width: 96 }}>onto</span>
              <span className="mono">{shortSha(onto)}</span>
              <span className="rebase-summary">{ontoCommit?.summary ?? ''}</span>
            </div>
          </div>
        )}
      </div>
      <div className="rebase-help">
        {invalid && !range.error ? <span style={{ color: 'var(--warning)' }}>{invalid} </span> : null}
        Keys: <span className="kbd">P</span>pick <span className="kbd">R</span>reword <span className="kbd">S</span>squash{' '}
        <span className="kbd">D</span>drop · <span className="kbd">↑</span>
        <span className="kbd">↓</span>move focus · <span className="kbd">Alt</span>+<span className="kbd">↑↓</span>reorder · Squash melds
        a commit into the one below it.
      </div>
    </div>
  )
}
