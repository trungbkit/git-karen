// Popover for picking a co-author from the authors of recent commits, with fuzzy search.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Author } from '@shared/types'
import { fuzzyFilter } from '../util/fuzzy'
import '../styles/staging.css'

// Authors per repo, read once per session.
const cache = new Map<string, Author[]>()

export function CoAuthorPicker({ repo, exclude, onPick, onClose }: { repo: string; exclude: string[]; onPick(a: Author): void; onClose(): void }) {
  const [authors, setAuthors] = useState<Author[] | null>(() => cache.get(repo) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (cache.has(repo)) return
    let cancelled = false
    window.git.recentAuthors(repo).then(
      (list) => {
        cache.set(repo, list)
        if (!cancelled) setAuthors(list)
      },
      (e: Error) => !cancelled && setError(e.message)
    )
    return () => {
      cancelled = true
    }
  }, [repo])

  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [onClose])

  const shown = useMemo(() => {
    const skip = new Set(exclude.map((e) => e.toLowerCase()))
    const candidates = (authors ?? []).filter((a) => !skip.has(a.email.toLowerCase()))
    return fuzzyFilter(candidates, query, (a) => `${a.name} ${a.email}`, 50).map((m) => m.item)
  }, [authors, exclude, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.coauthor-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = shown.length
      if (n) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (shown[active]) onPick(shown[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="coauthor-picker" ref={ref}>
      <input autoFocus placeholder="Search recent authors" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
      <div className="coauthor-list" ref={listRef}>
        {error ? (
          <div className="coauthor-empty field-error">{error}</div>
        ) : !authors ? (
          <div className="coauthor-empty">
            <span className="spinner small" /> Reading recent commits…
          </div>
        ) : shown.length === 0 ? (
          <div className="coauthor-empty">{query ? 'No matching authors' : 'No other authors in recent commits'}</div>
        ) : (
          shown.map((a, i) => (
            <div
              key={a.email}
              className={`coauthor-row ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => (e.preventDefault(), onPick(a))}
            >
              <span className="ellipsis">{a.name}</span>
              <span className="muted ellipsis">{a.email}</span>
              <span className="count" title={`${a.commits} recent ${a.commits === 1 ? 'commit' : 'commits'}`}>
                {a.commits}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
