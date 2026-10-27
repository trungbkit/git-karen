// CI status next to a commit in the graph (plan 07.3): an icon per combined state, and on hover a card listing
// every check with a link to its run.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { CiState, CiStatus } from '@shared/integrations'
import { useHosting } from '../state/hosting'
import { Icon } from '../ui/Icon'
import '../styles/hosting.css'

const LABEL: Record<CiState, string> = { success: 'passed', failure: 'failed', pending: 'running', neutral: 'skipped' }

export function CiIcon({ state, size = 12 }: { state: CiState; size?: number }) {
  return (
    <span className={`ci-icon ci-${state}`} style={{ width: size, height: size }} role="img" aria-label={`Checks ${LABEL[state]}`}>
      {state === 'success' ? <Icon name="check" size={size - 2} /> : state === 'failure' ? <Icon name="x" size={size - 2} /> : <span className="ci-dot" />}
    </span>
  )
}

export function ciSummary(st: CiStatus): string {
  if (st.checks.length === 0) return `Checks ${LABEL[st.state]}`
  const counts = new Map<CiState, number>()
  for (const c of st.checks) counts.set(c.state, (counts.get(c.state) ?? 0) + 1)
  return (['failure', 'pending', 'success', 'neutral'] as CiState[])
    .filter((s) => counts.get(s))
    .map((s) => `${counts.get(s)} ${LABEL[s]}`)
    .join(', ')
}

export function CiBadge({ repo, sha }: { repo: string; sha: string }) {
  const st = useHosting((s) => s.ci[repo]?.[sha])
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!st) return null
  const show = (e: MouseEvent<HTMLElement>) => {
    clearTimeout(timer.current)
    const el = e.currentTarget
    timer.current = setTimeout(() => el.isConnected && setAnchor(el.getBoundingClientRect()), 250)
  }
  // leaving the badge for the card keeps it open
  const hide = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAnchor(null), 200)
  }
  return (
    <span
      className="ci-badge"
      onMouseEnter={show}
      onMouseLeave={hide}
      onClick={(e) => {
        e.stopPropagation()
        setAnchor(e.currentTarget.getBoundingClientRect())
      }}
    >
      <CiIcon state={st.state} />
      {anchor &&
        createPortal(
          <CiCard status={st} anchor={anchor} onEnter={() => clearTimeout(timer.current)} onLeave={hide} onClose={() => setAnchor(null)} />,
          document.body
        )}
    </span>
  )
}

function CiCard({ status, anchor, onEnter, onLeave, onClose }: { status: CiStatus; anchor: DOMRect; onEnter(): void; onLeave(): void; onClose(): void }) {
  const el = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const card = el.current?.getBoundingClientRect()
    if (!card) return
    const left = Math.max(8, Math.min(anchor.left - 8, window.innerWidth - card.width - 8))
    const below = anchor.bottom + 4
    const top = below + card.height > window.innerHeight - 8 ? Math.max(8, anchor.top - card.height - 4) : below
    setPos({ left, top })
  }, [anchor])
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('scroll', close, true)
    window.addEventListener('wheel', close, true)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('wheel', close, true)
    }
  }, [onClose])
  return (
    <div
      ref={el}
      className="ci-card"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="ci-card-head">
        <CiIcon state={status.state} />
        <span>{ciSummary(status)}</span>
      </div>
      <div className="ci-card-list">
        {status.checks.map((c, i) => (
          <div key={i} className="ci-card-row" title={c.description}>
            <CiIcon state={c.state} size={11} />
            {c.url ? (
              <a
                href={c.url}
                onClick={(e) => {
                  e.preventDefault()
                  void window.app.openExternal(c.url!)
                }}
              >
                {c.name || '(unnamed)'}
              </a>
            ) : (
              <span>{c.name || '(unnamed)'}</span>
            )}
            {c.description && <span className="ci-card-desc ellipsis">{c.description}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
