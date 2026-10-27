// Branch / Tag column: ref labels tinted with the lane colour, joined to the node by a ref line.
import { useState, type DragEvent, type MouseEvent } from 'react'
import type { Ref, Remote } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { checkoutRef, refMenuItems, remoteBranchName } from '../actions/refActions'
import { worktreeForBranch } from '../actions/worktreeActions'
import { showContextMenu } from '../ui/ContextMenu'
import { Icon } from '../ui/Icon'
import { laneColor } from './geometry'
import { usePins } from './pin'
import { RefCard, useHoverCard } from './RefCard'

export const DRAG_TYPE = 'application/x-kc-ref'

export interface PillGroup {
  /** Local branch, or a remote branch / tag when there is no local branch for it */
  ref: Ref
  /** Remote branches with the same name at the same commit (shown as icons on the label) */
  remotes: Ref[]
}

/** Group refs by commit: local branches absorb same-named remote branches at the same commit. */
export function groupRefs(repo: RepoTab, index: Map<string, number>): Map<string, PillGroup[]> {
  const bySha = new Map<string, Ref[]>()
  const add = (sha: string, ref: Ref) => {
    const list = bySha.get(sha) ?? []
    list.push(ref)
    bySha.set(sha, list)
  }
  // Annotated tags may point at tag objects; fall back to the ref names recorded on commits.
  const commitByRef = new Map<string, string>()
  for (const c of repo.commits) for (const r of c.refs) commitByRef.set(r, c.sha)
  for (const ref of repo.refs) {
    if (ref.type === 'stash' || ref.type === 'head') continue
    const sha = index.has(ref.sha) ? ref.sha : commitByRef.get(ref.fullName)
    if (sha) add(sha, ref)
  }

  const out = new Map<string, PillGroup[]>()
  for (const [sha, refs] of bySha) {
    const locals = refs.filter((r) => r.type === 'local')
    const remotes = refs.filter((r) => r.type === 'remote' && !r.name.endsWith('/HEAD'))
    const tags = refs.filter((r) => r.type === 'tag')
    const used = new Set<string>()
    const groups: PillGroup[] = []
    for (const l of locals) {
      const same = remotes.filter((r) => remoteBranchName(r) === l.name)
      same.forEach((r) => used.add(r.fullName))
      groups.push({ ref: l, remotes: same })
    }
    for (const r of remotes) if (!used.has(r.fullName)) groups.push({ ref: r, remotes: [] })
    for (const t of tags) groups.push({ ref: t, remotes: [] })
    groups.sort((a, b) => Number(b.ref.isHead === true) - Number(a.ref.isHead === true))
    out.set(sha, groups)
  }
  if (repo.status?.detached && repo.status.headSha && index.has(repo.status.headSha)) {
    const head: Ref = { fullName: 'HEAD', name: 'HEAD', type: 'head', sha: repo.status.headSha, isHead: true }
    out.set(repo.status.headSha, [{ ref: head, remotes: [] }, ...(out.get(repo.status.headSha) ?? [])])
  }
  return out
}

function remoteIcon(remotes: Remote[], ref: Ref) {
  const name = ref.remote ?? ref.name.split('/')[0]
  const url = remotes.find((r) => r.name === name)?.fetchUrl ?? ''
  return /github\.com/i.test(url) ? ('github' as const) : ('remote' as const)
}

interface ZoneProps {
  repo: RepoTab
  groups?: PillGroup[]
  /** Refs of the nearest descendant branch, shown faded when the row is hovered or selected */
  ghost?: PillGroup[]
  showGhost: boolean
  column: number
  /** Row holds the checked-out branch: the ref line is drawn solid */
  active: boolean
  onHoverRef(ref: Ref | null): void
}

export function RefZone({ repo, groups, ghost, showGhost, column, active, onHoverRef }: ZoneProps) {
  const [open, setOpen] = useState(false)
  const color = laneColor(column)
  const list = groups && groups.length > 0 ? groups : null
  if (!list) {
    if (!showGhost || !ghost?.length) return null
    return (
      <div className="g-refzone ghost" style={{ ['--lane' as string]: color }}>
        <div className="g-refzone-inner">
          <span className="g-ref ghost-ref">
            <span className="g-ref-name">{ghost[0].ref.name}</span>
          </span>
          <span className="g-ref-line" />
        </div>
      </div>
    )
  }
  const [first, ...rest] = list
  return (
    <div className="g-refzone" style={{ ['--lane' as string]: color }} onMouseLeave={() => setOpen(false)}>
      <div className="g-refzone-inner">
        <RefLabel repo={repo} group={first} onHoverRef={onHoverRef} />
        {rest.length > 0 && (
          <span className="g-ref-overflow" onMouseEnter={() => setOpen(true)}>
            +{rest.length}
          </span>
        )}
        <span className={`g-ref-line ${active ? 'active' : ''}`} />
      </div>
      {open && (
        <div className="g-ref-popover" onMouseLeave={() => setOpen(false)}>
          {list.map((g) => (
            <RefLabel key={g.ref.fullName} repo={repo} group={g} onHoverRef={onHoverRef} />
          ))}
        </div>
      )}
    </div>
  )
}

function RefLabel({ repo, group, onHoverRef }: { repo: RepoTab; group: PillGroup; onHoverRef(ref: Ref | null): void }) {
  const { ref, remotes } = group
  const toggleHidden = useStore((s) => s.toggleHidden)
  const toggleSolo = useStore((s) => s.toggleSolo)
  const draggable = ref.type === 'local' || ref.type === 'remote'
  const isLocal = ref.type === 'local'
  const remoteRefs = ref.type === 'remote' ? [ref] : remotes
  const soloed = repo.soloRefs.includes(ref.fullName)
  const worktree = isLocal ? worktreeForBranch(repo, ref.name) : undefined

  const card = useHoverCard()
  const pinned = usePins((s) => s.pinned[repo.path] === ref.fullName)
  const togglePin = usePins((s) => s.toggle)
  const onContext = (e: MouseEvent) => {
    if (ref.type === 'head') return
    e.stopPropagation()
    const pin = ref.type === 'tag' ? [] : (['separator', { label: pinned ? 'Unpin from Left' : 'Pin to Left', onClick: () => togglePin(repo.path, ref.fullName) }] as const)
    showContextMenu(e, [...refMenuItems(repo, ref), ...pin])
  }
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, ref.fullName)
    e.dataTransfer.effectAllowed = 'move'
  }
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  return (
    <span
      className={`g-ref ${ref.type} ${ref.isHead ? 'is-active' : ''}`}
      data-ref={ref.fullName}
      title={ref.type === 'head' ? 'Detached HEAD' : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onMouseEnter={(e) => {
        onHoverRef(ref)
        if (ref.type !== 'head') card.onMouseEnter(e)
      }}
      onMouseLeave={() => {
        onHoverRef(null)
        card.onMouseLeave()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (ref.type === 'local' || ref.type === 'remote') void checkoutRef(repo, ref)
      }}
      onContextMenu={onContext}
    >
      {pinned && <PinIcon />}
      {ref.isHead && ref.type !== 'tag' ? (
        <Icon name="check" size={12} className="g-ref-icon" />
      ) : ref.type === 'tag' ? (
        <Icon name="tag" size={12} className="g-ref-icon" />
      ) : null}
      <span className="g-ref-name">{ref.name}</span>
      <span className="g-ref-icons">
        {isLocal && (worktree ? <Icon name="worktree" size={12} className="g-ref-wt" /> : <Icon name="computer" size={12} />)}
        {remoteRefs.slice(0, 2).map((r) => (
          <span key={r.fullName} title={r.name}>
            <Icon name={remoteIcon(repo.remotes, r)} size={12} />
          </span>
        ))}
      </span>
      {ref.type !== 'head' && (
        <span className="g-ref-actions">
          <button title="Hide in graph" aria-label="Hide in graph" onClick={stop(() => toggleHidden(ref.fullName))}>
            <Icon name="eye-off" size={11} />
          </button>
          <button title={soloed ? 'Unsolo' : 'Solo (show only this)'} aria-label={soloed ? 'Unsolo' : 'Solo (show only this)'} className={soloed ? 'on' : ''} onClick={stop(() => toggleSolo(ref.fullName))}>
            <SoloIcon />
          </button>
        </span>
      )}
      {card.anchor && <RefCard repo={repo} refItem={ref} remotes={remotes} anchor={card.anchor} />}
    </span>
  )
}

function SoloIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <circle cx={8} cy={8} r={5.5} />
      <circle cx={8} cy={8} r={1.8} fill="currentColor" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg className="g-ref-icon" width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <title>Pinned to left</title>
      <path d="M10 1.5 14.5 6l-2.5 1-2.5 2.5.5 3.5-1.5 1.5-3-3-3.5 3.5M5.5 8.5l-3-3L4 4l3.5.5L10 2" />
    </svg>
  )
}
