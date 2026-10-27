// One graph row: ref labels, lane edges + node, message, author, changes, date and SHA cells.
import { memo, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import type { CommitStats, Ref, Worktree } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { commitMenuItems, stashChanges, stashMenuItems } from '../actions/refActions'
import { worktreeLabel, worktreeMenuItems } from '../actions/worktreeActions'
import { showContextMenu } from '../ui/ContextMenu'
import { Icon } from '../ui/Icon'
import { formatDate, fullDate, shortSha } from '../util/format'
import { Avatar } from './avatar'
import type { ColumnDef, ColumnId } from './columns'
import { laneColor, laneX, rowEdgePaths, type GraphMetrics } from './geometry'
import type { GraphRow } from './layout'
import { RefZone, type PillGroup } from './RefZone'
import { CiBadge } from './CiBadge'
import { IssueText } from '../components/IssueText'

export interface WipSummary {
  modified: number
  added: number
  deleted: number
  conflicted: number
  operation: string | null
}

export interface RowProps {
  index: number
  row: GraphRow
  repo: RepoTab
  m: GraphMetrics
  columns: ColumnDef[]
  widths: Record<ColumnId, number>
  pills?: PillGroup[]
  ghost?: PillGroup[]
  selected: boolean
  dimmed: boolean
  query: string
  dropTarget: boolean
  /** Set while the row flashes after a reveal; a new id restarts the flash */
  flashId?: number
  wip: WipSummary
  /** Set on another worktree's WIP row */
  worktree?: Worktree
  onOpenWorktree(path: string): void
  stats?: CommitStats
  statsMax: number
  showAvatars: boolean
  showDescription: boolean
  dateMode: 'relative' | 'absolute'
  onSelect(i: number, mode?: 'single' | 'toggle' | 'range'): void
  onDragOver(e: DragEvent, i: number): void
  onDrop(e: DragEvent, i: number): void
  onHoverRef(ref: Ref | null): void
}

export const GraphRowView = memo(function GraphRowView(p: RowProps) {
  const { row, repo, index, m } = p
  const node = row.node
  const commit = node.commit
  const conflict = node.kind === 'wip' && p.wip.operation !== null

  const onClick = (e: MouseEvent) => {
    const mod = e.metaKey || e.ctrlKey
    p.onSelect(index, e.shiftKey ? 'range' : mod ? 'toggle' : 'single')
  }

  const onContext = (e: MouseEvent) => {
    if (!p.selected) p.onSelect(index)
    if (p.worktree) showContextMenu(e, worktreeMenuItems(repo, p.worktree))
    else if (node.kind === 'commit') showContextMenu(e, commitMenuItems(repo, node.sha))
    else if (node.kind === 'stash' && node.stash) showContextMenu(e, stashMenuItems(repo, node.stash))
    else if (node.kind === 'wip') {
      const run = useStore.getState().run
      showContextMenu(e, [
        { label: 'Stash all changes', onClick: () => void stashChanges() },
        { label: 'Stage all changes', onClick: () => void run('Staging', (r) => window.git.stageAll(r), { log: false }) },
        { label: 'Unstage all changes', onClick: () => void run('Unstaging', (r) => window.git.unstageAll(r), { log: false }) }
      ])
    }
  }

  const cls = [
    'g-row',
    `g-${node.kind}`,
    row.isMerge && 'g-merge',
    p.selected && 'selected',
    p.dimmed && 'dimmed',
    p.dropTarget && 'drop-target',
    p.worktree && 'g-wt-wip',
    conflict && 'conflict'
  ]
    .filter(Boolean)
    .join(' ')

  const hasRefs = Boolean(p.pills?.length)
  const active = Boolean(p.pills?.some((g) => g.ref.isHead))

  const cells: ReactNode[] = p.columns.map((col) => {
    const w = p.widths[col.id]
    switch (col.id) {
      case 'ref':
        return (
          <div key="ref" className="g-cell g-c-ref" style={{ width: w }}>
            <RefZone
              repo={repo}
              groups={p.pills}
              ghost={p.ghost}
              showGhost={node.kind === 'commit'}
              column={row.column}
              active={active}
              onHoverRef={p.onHoverRef}
            />
          </div>
        )
      case 'graph':
        return <GraphCell key="graph" row={row} m={m} width={w} selected={p.selected} hasRefs={hasRefs} active={active} conflict={conflict} showAvatars={p.showAvatars} />
      case 'message':
        return (
          <div key="message" className="g-cell g-c-message">
            <Message {...p} />
          </div>
        )
      case 'author':
        return (
          <div key="author" className="g-cell g-c-author" style={{ width: w }} title={commit ? `${commit.author.name} <${commit.author.email}>` : undefined}>
            {commit && (
              <>
                <Avatar name={commit.author.name} email={commit.author.email} size={16} remote={p.showAvatars} />
                <span className="ellipsis">{commit.author.name}</span>
              </>
            )}
          </div>
        )
      case 'changes':
        return (
          <div key="changes" className="g-cell g-c-changes" style={{ width: w }}>
            {node.kind === 'commit' && p.stats && p.stats.files > 0 && <ChangesBar stats={p.stats} max={p.statsMax} width={w - 50} />}
          </div>
        )
      case 'date':
        return (
          <div key="date" className="g-cell g-c-date ellipsis" style={{ width: w }} title={commit ? fullDate(commit.author.date) : undefined}>
            {(() => {
              const ms = commit?.author.date ?? node.stash?.date
              if (ms === undefined) return ''
              return w < 125 ? compactAgo(ms) : formatDate(ms, p.dateMode)
            })()}
          </div>
        )
      case 'sha':
        return (
          <div key="sha" className="g-cell g-c-sha mono" style={{ width: w }}>
            {commit ? shortSha(commit.sha) : node.stash ? shortSha(node.stash.sha) : ''}
          </div>
        )
    }
  })

  return (
    <div
      className={cls}
      style={{ top: index * m.rowH }}
      onClick={onClick}
      onDoubleClick={p.worktree ? () => p.onOpenWorktree(p.worktree!.path) : undefined}
      onContextMenu={onContext}
      onDragOver={(e) => p.onDragOver(e, index)}
      onDrop={(e) => p.onDrop(e, index)}
    >
      {cells}
      {p.flashId !== undefined && <span key={p.flashId} className="g-flash" />}
    </div>
  )
})

function Message(p: RowProps) {
  const node = p.row.node
  if (node.kind === 'wip' && p.worktree) {
    const wt = p.worktree
    const c = wt.changes ?? { modified: 0, added: 0, deleted: 0, conflicted: 0 }
    return (
      <span className="g-msg g-wip-msg" title={`Uncommitted changes in worktree ${wt.path}`}>
        <span className="g-wip-label">// WIP</span>
        <span className="g-wt-chip">
          <Icon name="worktree" size={12} />
          <span className="ellipsis">{worktreeLabel(wt)}</span>
        </span>
        <FilesReadout {...c} />
        {p.selected && (
          <button
            className="btn small primary g-wt-open"
            onClick={(e) => {
              e.stopPropagation()
              p.onOpenWorktree(wt.path)
            }}
          >
            Open worktree
          </button>
        )}
      </span>
    )
  }
  if (node.kind === 'wip') {
    const w = p.wip
    return (
      <span className="g-msg g-wip-msg">
        <span className="g-wip-label">{w.operation ? `// ${w.operation.toUpperCase()} IN PROGRESS` : '// WIP'}</span>
        <FilesReadout {...w} />
      </span>
    )
  }
  if (node.kind === 'stash') {
    return (
      <span className="g-msg g-stash-msg">
        <Highlight text={node.stash?.message ?? 'stash'} q={p.query} />
      </span>
    )
  }
  const c = node.commit
  if (!c) return null
  return (
    <span className="g-msg">
      <CiBadge repo={p.repo.path} sha={c.sha} />
      <IssueText repo={p.repo.path} text={c.summary} render={(t) => <Highlight text={t} q={p.query} />} />
      {p.showDescription && c.body && (
        <span className="g-body">
          {'  '}
          <IssueText repo={p.repo.path} text={c.body.replace(/\s+/g, ' ')} render={(t) => <Highlight text={t} q={p.query} />} />
        </span>
      )}
    </span>
  )
}

/** Coloured per-kind file counts shown on WIP rows. */
function FilesReadout(w: { modified: number; added: number; deleted: number; conflicted: number }) {
  return (
    <span className="g-files-readout">
      {w.conflicted > 0 && (
        <span className="conflicted" title="Conflicted files">
          <Icon name="warning" size={12} /> {w.conflicted}
        </span>
      )}
      {w.modified > 0 && (
        <span className="modified" title="Modified files">
          <Icon name="edit" size={12} /> {w.modified}
        </span>
      )}
      {w.added > 0 && (
        <span className="added" title="Added files">
          <Icon name="plus" size={12} /> {w.added}
        </span>
      )}
      {w.deleted > 0 && (
        <span className="deleted" title="Deleted files">
          <Icon name="minus" size={12} /> {w.deleted}
        </span>
      )}
    </span>
  )
}

interface GraphCellProps {
  row: GraphRow
  m: GraphMetrics
  width: number
  selected: boolean
  hasRefs: boolean
  active: boolean
  conflict: boolean
  showAvatars: boolean
}

const GraphCell = memo(function GraphCell({ row, m, width, selected, hasRefs, active, conflict, showAvatars }: GraphCellProps) {
  const node = row.node
  const lane = laneX(m, row.column)
  const half = m.nodeSize / 2
  // Keep the node visible when the graph column is narrower than its lanes.
  const nodeX = Math.max(half + 2, Math.min(lane, width - half - 2))
  const clamped = nodeX !== lane
  const color = laneColor(row.column)
  const paths = rowEdgePaths(m, row, nodeX)
  const strip = node.kind !== 'wip'

  return (
    <div className="g-cell g-c-graph" style={{ width }}>
      <svg width={width} height={m.rowH} className="g-lanes">
        {strip && (
          <rect
            x={nodeX}
            y={m.innerTop}
            width={Math.max(0, width - nodeX)}
            height={m.innerH}
            fill={color}
            fillOpacity={selected ? 0.5 : 0.1}
          />
        )}
        {hasRefs && (
          <line
            x1={0}
            y1={m.mid}
            x2={nodeX}
            y2={m.mid}
            stroke={color}
            strokeWidth={active ? 2 : 1}
            strokeOpacity={active ? 1 : 0.25}
          />
        )}
        {paths.map((p, i) => (
          <path
            key={i}
            d={p.d}
            stroke={laneColor(p.col)}
            strokeWidth={m.lineWidth}
            strokeDasharray={p.dashed ? '2 2' : undefined}
            fill="none"
          />
        ))}
      </svg>
      <NodeView row={row} m={m} x={nodeX} color={color} faded={clamped} conflict={conflict} showAvatars={showAvatars} />
    </div>
  )
})

function NodeView({ row, m, x, color, faded, conflict, showAvatars }: { row: GraphRow; m: GraphMetrics; x: number; color: string; faded: boolean; conflict: boolean; showAvatars: boolean }) {
  const node = row.node
  const style = (size: number) => ({ left: x - size / 2, top: m.mid - size / 2, width: size, height: size, opacity: faded ? 0.5 : 1, ['--lane' as string]: color })

  if (conflict) {
    return <span className="g-node g-node-merge g-node-conflict" style={style(m.mergeSize)} title="Merge conflict" />
  }
  if (node.kind === 'wip') {
    const s = m.nodeSize
    const r = (s - m.lineWidth) / 2
    return (
      <span className="g-node g-node-wip" style={style(s)} title="Work in progress">
        <svg width={s} height={s}>
          <circle cx={s / 2} cy={s / 2} r={r} fill="none" stroke={color} strokeWidth={m.lineWidth} strokeDasharray="2 3" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (node.kind === 'stash') {
    return (
      <span className={`g-node g-node-stash ${m.compact ? 'compact' : ''}`} style={style(m.nodeSize)} title="Stash">
        {!m.compact && <Icon name="stash" size={12} />}
      </span>
    )
  }
  if (row.isMerge || m.compact || !node.commit) {
    return <span className="g-node g-node-merge" style={style(m.mergeSize)} title={node.commit ? `${node.commit.author.name} <${node.commit.author.email}>` : undefined} />
  }
  const a = node.commit.author
  return (
    <span className="g-node g-node-commit" style={style(m.nodeSize)} title={`${a.name} <${a.email}>`}>
      <Avatar name={a.name} email={a.email} size={m.nodeSize - 2 * m.lineWidth - 2} remote={showAvatars} />
    </span>
  )
}

function ChangesBar({ stats, max, width }: { stats: CommitStats; max: number; width: number }) {
  const total = stats.additions + stats.deletions
  const full = Math.max(10, width) * Math.min(1, total / max)
  const add = total ? (full * stats.additions) / total : 0
  const del = total ? full - add : 0
  return (
    <span className="g-changes" title={`${stats.files} file${stats.files === 1 ? '' : 's'}, +${stats.additions} −${stats.deletions}`}>
      <span className="g-changes-bar">
        {stats.additions > 0 && <span className="added" style={{ width: Math.max(5, add) }} />}
        {stats.deletions > 0 && <span className="deleted" style={{ width: Math.max(5, del) }} />}
      </span>
      <span className="g-changes-files">
        <Icon name="file" size={11} />
        {stats.files}
      </span>
    </span>
  )
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < text.length) {
    const j = lower.indexOf(q, i)
    if (j === -1) {
      parts.push(text.slice(i))
      break
    }
    if (j > i) parts.push(text.slice(i, j))
    parts.push(<mark key={k++}>{text.slice(j, j + q.length)}</mark>)
    i = j + q.length
  }
  return <>{parts}</>
}

/** Very short relative time for a narrow date column: "5m", "3h", "2d", "4mo", "1y". */
export function compactAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`
  return `${Math.floor(s / (86400 * 365))}y`
}
