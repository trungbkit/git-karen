// Recovery view: the HEAD reflog, to find and bring back commits no branch points at anymore.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReflogEntry } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { formatDate, fullDate, shortSha } from '../util/format'
import { reflogMenuItems, showInGraph } from '../actions/refActions'
import { useRovingFocus } from '../ui/roving'
import '../styles/detail.css'
import '../graph/graph.css'

/** Colour family of a reflog action ("rebase (finish)" -> rebase). */
function actionKind(action: string): string {
  const word = action.split(/[\s(]/)[0]
  return ['commit', 'checkout', 'reset', 'rebase', 'merge', 'pull', 'cherry-pick', 'revert'].includes(word) ? word : 'other'
}

export function ReflogView({ repo }: { repo: RepoTab }) {
  // one Tab stop: arrows move between entries, Shift+F10 opens the entry menu
  const listRef = useRef<HTMLDivElement>(null)
  useRovingFocus(listRef, { items: '.reflog-row' })
  const { setCenter } = useStore.getState()
  const dateMode = useStore((s) => s.prefs.dateFormat)
  const head = repo.status?.headSha ?? null
  const [entries, setEntries] = useState<ReflogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  // reload whenever HEAD moves: every move adds an entry
  useEffect(() => {
    let live = true
    window.git.reflog(repo.path).then(
      (e) => live && (setEntries(e), setError(null)),
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [repo.path, head])

  useEffect(() => filterRef.current?.focus(), [])

  const loaded = useMemo(() => new Set(repo.commits.map((c) => c.sha)), [repo.commits])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!entries || !q) return entries ?? []
    return entries.filter((e) => `${e.selector} ${e.action} ${e.message} ${e.sha}`.toLowerCase().includes(q))
  }, [entries, query])

  return (
    <div className="view">
      <div className="view-head">
        <Icon name="undo" size={14} />
        <span className="title">Recovery</span>
        <span className="muted" style={{ fontSize: 12 }}>
          Every position HEAD has been at. Right-click an entry to bring it back.
        </span>
        <span className="grow" />
        <div className="gh-filter reflog-filter">
          <Icon name="search" size={11} />
          <input
            ref={filterRef}
            value={query}
            placeholder="Filter by message, action or sha"
            aria-label="Filter the reflog"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                e.stopPropagation()
                setQuery('')
              }
            }}
          />
        </div>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={() => setCenter({ kind: 'graph' })}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="view-body" ref={listRef} role="listbox" aria-label="Reflog entries">
        {error && <div className="view-message">{error}</div>}
        {!entries && !error && <div className="view-message">Loading reflog…</div>}
        {entries?.length === 0 && <div className="view-message">The reflog is empty.</div>}
        {entries && entries.length > 0 && filtered.length === 0 && <div className="view-message">No entries match “{query}”.</div>}
        {filtered.map((e) => (
          <div
            key={e.index}
            role="option"
            aria-selected={selected === e.index}
            className={`reflog-row ${selected === e.index ? 'selected' : ''}`}
            onClick={() => setSelected(e.index)}
            onDoubleClick={() => loaded.has(e.sha) && showInGraph(e.sha)}
            onContextMenu={(ev) => (setSelected(e.index), showContextMenu(ev, reflogMenuItems(repo, e.sha)))}
            title={loaded.has(e.sha) ? 'Double-click to view in graph' : 'Not in the graph: no branch or tag reaches this commit (or it is beyond the loaded history)'}
          >
            <span className="mono muted reflog-selector">{e.selector}</span>
            <span className={`reflog-action ${actionKind(e.action)}`}>{e.action}</span>
            <span className="ellipsis">{e.message}</span>
            {e.sha === head && <span className="reflog-tag">HEAD</span>}
            {!loaded.has(e.sha) && <span className="reflog-tag muted">not in graph</span>}
            <span className="mono reflog-sha">{shortSha(e.sha)}</span>
            <span className="muted reflog-date" title={fullDate(e.date)}>
              {formatDate(e.date, dateMode)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
