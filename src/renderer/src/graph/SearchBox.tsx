// The graph search box: prefix suggestions while typing, and the matching rows (search syntax in search.ts).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import type { RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import type { GraphRow } from './layout'
import {
  completePrefix,
  highlightTerm,
  isEmptySearch,
  matchCommit,
  matchStash,
  needsBackend,
  parseSearch,
  suggestPrefixes,
  type CommitSearch,
  type SearchField
} from './search'

/** Wait for typing to pause before asking git to scan the history */
const HISTORY_DEBOUNCE_MS = 300

interface HistoryResult {
  key: string
  shas: Set<string>
  error?: string
}

/** Shas matching the `path:` / `content:` filters, from `git log` over the graph's history. */
function useHistoryMatches(repo: RepoTab, search: CommitSearch, limit: number) {
  const [result, setResult] = useState<HistoryResult | null>(null)
  const commits = repo.commits
  // the history the graph shows: rerun when it changes, and walk no further back than its oldest commit
  const since = commits.length >= limit ? commits[commits.length - 1]?.committer.date : undefined
  const key = needsBackend(search) ? JSON.stringify([repo.path, search.path, search.content, commits[0]?.sha, commits.length, limit]) : ''
  const request = useRef({ paths: search.path, content: search.content, since })
  request.current = { paths: search.path, content: search.content, since }

  useEffect(() => {
    if (!key) return
    let live = true
    const timer = setTimeout(async () => {
      const { paths, content, since } = request.current
      try {
        // one git log per content value (git takes a single -S); paths are alternatives within each
        const lists = await Promise.all(
          (content.length ? content : [undefined]).map((c) => window.git.searchLog(repo.path, { paths, content: c, since, limit }))
        )
        if (live) setResult({ key, shas: new Set(lists.flat()) })
      } catch (e) {
        if (live) setResult({ key, shas: new Set(), error: (e as Error).message })
      }
    }, HISTORY_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, repo.path, limit])

  const current = key && result?.key === key ? result : null
  return { key, shas: current?.shas ?? null, pending: !!key && !current, error: current?.error }
}

/** Rows matching the search box (null when it is empty) and the text to mark in them. */
export function useCommitSearch(repo: RepoTab, query: string, rows: GraphRow[], limit: number) {
  const search = useMemo(() => parseSearch(query), [query])
  const history = useHistoryMatches(repo, search, limit)
  const matches = useMemo(() => {
    if (isEmptySearch(search)) return null
    const set = new Set<number>()
    rows.forEach((row, i) => {
      const c = row.node.commit
      const hit = c
        ? matchCommit(search, c) && (!history.key || !!history.shas?.has(c.sha))
        : !!row.node.stash && matchStash(search, row.node.stash.message)
      if (hit) set.add(i)
    })
    return set
  }, [search, rows, history.key, history.shas])
  const errors = history.error ? [...search.errors, history.error] : search.errors
  return { matches, highlight: highlightTerm(search), pending: history.pending, errors }
}

interface SearchBoxProps {
  inputRef: Ref<HTMLInputElement>
  query: string
  onChange(query: string): void
  /** Enter / Shift+Enter */
  onJump(direction: 1 | -1): void
  count: number | null
  pending: boolean
  errors: string[]
}

export function SearchBox({ inputRef, query, onChange, onJump, count, pending, errors }: SearchBoxProps) {
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement | null>(null)
  const suggestions = focused && !hidden ? suggestPrefixes(query, caret) : []
  useEffect(() => setActive(-1), [query, caret])

  const setRefs = (el: HTMLInputElement | null) => {
    input.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) inputRef.current = el
  }

  const accept = (field: SearchField) => {
    const next = completePrefix(query, caret, field)
    onChange(next.value)
    setCaret(next.caret)
    requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a + d + suggestions.length + (a < 0 && d < 0 ? 1 : 0)) % suggestions.length)
    } else if (suggestions.length && (e.key === 'Tab' || (e.key === 'Enter' && active >= 0))) {
      e.preventDefault()
      accept(suggestions[Math.max(0, active)].field)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onJump(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (suggestions.length) return setHidden(true)
      onChange('')
      e.currentTarget.blur()
    }
  }

  const track = () => setCaret(input.current?.selectionStart ?? query.length)
  const title = errors.length
    ? errors.join('\n')
    : 'author: message: path: content: sha: since: until: — text without a prefix searches messages, authors, shas and refs'

  return (
    <div className="gh-filter" onContextMenu={(e) => e.stopPropagation()} title={title}>
      <Icon name="search" size={11} />
      <input
        ref={setRefs}
        value={query}
        placeholder="Search commits (author: path: since: …)"
        aria-label="Search commits"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart ?? e.target.value.length)
          setHidden(false)
        }}
        onSelect={track}
        onKeyDown={onKeyDown}
        onFocus={() => (setFocused(true), track())}
        onBlur={() => setFocused(false)}
      />
      {errors.length > 0 && (
        <span className="gh-search-error">
          <Icon name="warning" size={11} />
        </span>
      )}
      {pending ? <span className="spinner small" aria-label="Searching" /> : count !== null && <span className="gh-count" aria-live="polite">{count}</span>}
      {suggestions.length > 0 && (
        <div className="gh-suggest" role="listbox" aria-label="Search filters" onMouseDown={(e) => e.preventDefault()}>
          {suggestions.map((s, i) => (
            <div key={s.field} role="option" aria-selected={i === active} className={`gh-suggest-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => accept(s.field)}>
              <span className="mono">{s.field}:</span>
              <span className="muted ellipsis">{s.hint}</span>
            </div>
          ))}
          <div className="gh-suggest-foot muted">Tab to complete</div>
        </div>
      )}
    </div>
  )
}
