// Hover card for a branch or tag: ahead/behind its upstream, the commit it points at and the worktree it is checked out in.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Ref } from '@shared/types'
import type { RepoTab } from '../state/store'
import { worktreeForBranch } from '../actions/worktreeActions'
import { Icon, type IconName } from '../ui/Icon'
import { fullDate, relativeTime, shortSha } from '../util/format'

export type CardPlacement = 'below' | 'right'

/** Show a card after the pointer rests on an element for `delay` ms; any scroll, click or drag hides it. */
export function useHoverCard(delay = 400) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hide = () => {
    clearTimeout(timer.current)
    setAnchor(null)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!anchor) return
    const close = () => setAnchor(null)
    for (const ev of ['scroll', 'mousedown', 'dragstart', 'wheel'] as const) window.addEventListener(ev, close, true)
    return () => {
      for (const ev of ['scroll', 'mousedown', 'dragstart', 'wheel'] as const) window.removeEventListener(ev, close, true)
    }
  }, [anchor])
  return {
    anchor,
    hide,
    onMouseEnter(e: MouseEvent<HTMLElement>) {
      const el = e.currentTarget
      clearTimeout(timer.current)
      timer.current = setTimeout(() => el.isConnected && setAnchor(el.getBoundingClientRect()), delay)
    },
    onMouseLeave: hide
  }
}

const GAP = 6

interface Props {
  repo: RepoTab
  refItem: Ref
  /** Remote branches at the same commit, shown on the same graph label */
  remotes?: Ref[]
  anchor: DOMRect
  placement?: CardPlacement
}

export function RefCard({ repo, refItem: ref, remotes = [], anchor, placement = 'below' }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const card = el.current?.getBoundingClientRect()
    if (!card) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left: number
    let top: number
    if (placement === 'right') {
      left = anchor.right + GAP
      if (left + card.width > vw - 4) left = anchor.left - card.width - GAP
      top = anchor.top
    } else {
      left = anchor.left
      top = anchor.bottom + GAP
      if (top + card.height > vh - 4) top = anchor.top - card.height - GAP
    }
    setPos({ left: Math.max(4, Math.min(left, vw - card.width - 4)), top: Math.max(4, Math.min(top, vh - card.height - 4)) })
  }, [anchor, placement])

  const commit = repo.commits.find((c) => c.sha === ref.sha)
  const summary = ref.summary ?? commit?.summary
  const author = ref.author ?? commit?.author.name
  const date = ref.date ?? commit?.committer.date
  const worktree = ref.type === 'local' ? worktreeForBranch(repo, ref.name) : undefined
  const upstream = ref.upstream?.replace(/^refs\/remotes\//, '')
  const ahead = ref.ahead ?? 0
  const behind = ref.behind ?? 0
  const icon: IconName = ref.type === 'tag' ? 'tag' : ref.type === 'remote' ? 'remote' : 'branch'

  return createPortal(
    <div ref={el} className="ref-card" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
      <div className="ref-card-head">
        <Icon name={icon} size={13} />
        <span className="ref-card-name">{ref.name}</span>
        {ref.isHead && ref.type === 'local' && <span className="ref-card-chip accent">checked out</span>}
        {ref.isDefault && <span className="ref-card-chip">default</span>}
      </div>
      {ref.type === 'local' &&
        (upstream ? (
          <div className="ref-card-line">
            {ahead || behind ? (
              <>
                {ahead > 0 && <span className="ref-card-ahead">↑{ahead}</span>}
                {behind > 0 && <span className="ref-card-behind">↓{behind}</span>}
                <span className="muted">
                  {[ahead && `${ahead} to push`, behind && `${behind} to pull`].filter(Boolean).join(', ')} · {upstream}
                </span>
              </>
            ) : (
              <span className="muted">Up to date with {upstream}</span>
            )}
          </div>
        ) : (
          <div className="ref-card-line muted">No upstream branch</div>
        ))}
      {ref.type === 'remote' && <div className="ref-card-line muted">Remote branch on {ref.remote ?? ref.name.split('/')[0]}</div>}
      {remotes.length > 0 && <div className="ref-card-line muted">Same commit as {remotes.map((r) => r.name).join(', ')}</div>}
      {ref.type === 'tag' && ref.message && <div className="ref-card-line">{ref.message}</div>}
      {worktree && (
        <div className="ref-card-line muted">
          <Icon name="worktree" size={12} /> Checked out in {worktree.path}
        </div>
      )}
      {(summary || author) && (
        <div className="ref-card-commit">
          {summary && <div className="ellipsis">{summary}</div>}
          <div className="muted">
            {[author, date !== undefined && relativeTime(date)].filter(Boolean).join(' · ')}
            {' · '}
            <span className="mono" title={date !== undefined ? fullDate(date) : undefined}>
              {shortSha(ref.sha)}
            </span>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}
