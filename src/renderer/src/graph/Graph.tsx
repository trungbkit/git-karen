import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import type { Preferences, Ref } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { dropMenuItems } from '../actions/refActions'
import { showContextMenu, type MenuItem } from '../ui/ContextMenu'
import { Icon } from '../ui/Icon'
import { COLUMNS, GRAPH_AUTO_MAX, visibleColumns, type ColumnId } from './columns'
import { contentWidth, metrics } from './geometry'
import { rowHeight } from '../ui/appearance'
import { branchCommits, buildNodes, computeLayout, filterByRefs, firstParentChain, inheritedRefs, WIP_SHA, worktreeWipSha } from './layout'
import { changeCount as worktreeChanges, openWorktree } from '../actions/worktreeActions'
import { usePins } from './pin'
import { registerGraphNav, revealScrollTop } from './nav'
import { DRAG_TYPE, groupRefs, type PillGroup } from './RefZone'
import { GraphRowView, type WipSummary } from './rows'
import { matchesPreset, presetMenuItems } from './presets'
import { useCommitStats, useStatsScale } from './stats'
import { useCiPolling } from '../state/hosting'
import { SearchBox, useCommitSearch } from './SearchBox'
import { BehindBanner } from './BehindBanner'
import { DelayedGraphSkeleton } from '../ui/Skeleton'
import './graph.css'

const HEADER_H = 26
const OVERSCAN = 12
/** View presets and column settings buttons at the end of the header */
const SETTINGS_W = 56
const MESSAGE_PREFERRED = 280
const SHRINK_ORDER: ColumnId[] = ['changes', 'sha', 'author', 'date', 'ref', 'graph']
/** Below this width a header shows an icon instead of its label. */
const HEADER_ICON_W = 72
/** How long a revealed row flashes (matches the g-flash animation) */
const FLASH_MS = 600
let flashSeq = 0

export function Graph({ repo }: { repo: RepoTab }) {
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  const select = useStore((s) => s.select)
  const updateRepo = useStore((s) => s.updateRepo)
  const m = useMemo(() => metrics(prefs.graphMode, rowHeight(prefs.density)), [prefs.graphMode, prefs.density])
  const ROW_H = m.rowH

  const status = repo.status
  const headSha = status?.headSha ?? null
  const changeCount = status ? status.staged.length + status.unstaged.length + status.conflicted.length : 0
  const hasWip = changeCount > 0 || status?.operation != null

  const pinnedRef = usePins((s) => s.pinned[repo.path])
  const worktreeWips = useMemo(
    () =>
      prefs.showWorktreeWips
        ? repo.worktrees.filter((wt) => wt.path !== repo.path && wt.head && worktreeChanges(wt) > 0).map((wt) => ({ path: wt.path, headSha: wt.head }))
        : [],
    [prefs.showWorktreeWips, repo.worktrees, repo.path]
  )
  const worktreeByPath = useMemo(() => new Map(repo.worktrees.map((wt) => [wt.path, wt])), [repo.worktrees])
  const { nodes, layout } = useMemo(() => {
    const visible = filterByRefs(repo.commits, repo.refs, repo.hiddenRefs, repo.soloRefs, headSha)
    const nodes = buildNodes(visible, { wipHeadSha: hasWip ? headSha : undefined, stashes: repo.stashes, worktreeWips })
    const pinnedSha = pinnedRef ? (repo.refs.find((r) => r.fullName === pinnedRef)?.sha ?? null) : null
    return { nodes, layout: computeLayout(nodes, { pinned: firstParentChain(nodes, pinnedSha) }) }
  }, [repo.commits, repo.refs, repo.hiddenRefs, repo.soloRefs, repo.stashes, headSha, hasWip, pinnedRef, worktreeWips])

  const pillsBySha = useMemo(() => groupRefs(repo, layout.index), [repo, layout.index])
  const ghostsBySha = useMemo(() => inheritedRefs<PillGroup>(nodes, pillsBySha), [nodes, pillsBySha])

  const wip = useMemo<WipSummary>(() => {
    const kinds = new Map<string, string>()
    for (const f of [...(status?.unstaged ?? []), ...(status?.staged ?? [])]) kinds.set(f.path, f.status)
    let modified = 0
    let added = 0
    let deleted = 0
    for (const k of kinds.values()) {
      if (k === 'added' || k === 'untracked') added++
      else if (k === 'deleted') deleted++
      else modified++
    }
    return { modified, added, deleted, conflicted: status?.conflicted.length ?? 0, operation: status?.operation ?? null }
  }, [status])

  // ---- filter / search -------------------------------------------------------------------
  const [query, setQuery] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)
  const { matches, highlight: q, pending: searching, errors: searchErrors } = useCommitSearch(repo, query, layout.rows, prefs.commitLimit)

  // ---- branch highlight while hovering a ref label --------------------------------------
  const [hoverRef, setHoverRef] = useState<Ref | null>(null)
  const highlight = useMemo(() => {
    if (!hoverRef || hoverRef.type === 'tag') return null
    const sha = hoverRef.sha
    const others = repo.refs.filter((r) => (r.type === 'local' || r.type === 'remote') && r.sha !== sha).map((r) => r.sha)
    return branchCommits(repo.commits, sha, others)
  }, [hoverRef, repo.refs, repo.commits])
  const onHoverRef = useCallback((ref: Ref | null) => setHoverRef(ref), [])

  // ---- selection -------------------------------------------------------------------------
  const selectedShas = useMemo(() => {
    const sel = repo.selection
    if (!sel) return new Set<string>()
    if (sel.kind === 'wip') return new Set([WIP_SHA])
    if (sel.kind === 'worktree') return new Set([worktreeWipSha(sel.path)])
    if (sel.kind === 'stash') {
      const st = repo.stashes.find((s) => s.index === sel.index)
      return new Set(st ? [st.sha] : [])
    }
    return new Set(sel.shas)
  }, [repo.selection, repo.stashes])

  const anchor = useRef<number | null>(null)
  const selectRow = useCallback(
    (i: number, mode: 'single' | 'toggle' | 'range' = 'single') => {
      const row = layout.rows[i]
      if (!row) return
      const node = row.node
      if (node.kind === 'wip' && node.worktree) {
        select({ kind: 'worktree', path: node.worktree })
      } else if (node.kind === 'wip') {
        select({ kind: 'wip' })
      } else if (node.kind === 'stash' && node.stash) {
        select({ kind: 'stash', index: node.stash.index })
      } else if (mode === 'toggle' && repo.selection?.kind === 'commit') {
        const shas = repo.selection.shas.includes(node.sha) ? repo.selection.shas.filter((s) => s !== node.sha) : [...repo.selection.shas, node.sha]
        select(shas.length ? { kind: 'commit', shas } : null)
      } else if (mode === 'range' && anchor.current !== null && repo.selection?.kind === 'commit') {
        const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)]
        const shas = layout.rows
          .slice(a, b + 1)
          .filter((r) => r.node.kind === 'commit')
          .map((r) => r.node.sha)
        select({ kind: 'commit', shas })
        return
      } else {
        select({ kind: 'commit', shas: [node.sha] })
      }
      anchor.current = i
    },
    [layout.rows, repo.selection, select]
  )

  // ---- virtualisation --------------------------------------------------------------------
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const [viewW, setViewW] = useState(1000)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => {
      setViewH(el.clientHeight)
      setViewW(el.clientWidth)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const scrollToRow = useCallback((i: number) => {
    const el = scroller.current
    if (!el) return
    // Rows start below the sticky header.
    const top = i * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (HEADER_H + top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = HEADER_H + top + ROW_H - el.clientHeight
  }, [ROW_H])

  const lastSelectedIndex = useMemo(() => {
    let idx = -1
    for (const sha of selectedShas) {
      const i = layout.index.get(sha)
      if (i !== undefined) idx = i
    }
    return idx
  }, [selectedShas, layout.index])

  useEffect(() => {
    if (lastSelectedIndex >= 0) scrollToRow(lastSelectedIndex)
  }, [lastSelectedIndex, scrollToRow])

  // ---- reveal (scroll to a commit and flash its row) --------------------------------------
  const [flash, setFlash] = useState<{ sha: string; id: number } | null>(null)
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash((f) => (f === flash ? null : f)), FLASH_MS)
    return () => clearTimeout(t)
  }, [flash])

  const navState = useRef({ lastSelectedIndex, selectRow, count: layout.rows.length, index: layout.index, rowH: ROW_H })
  navState.current = { lastSelectedIndex, selectRow, count: layout.rows.length, index: layout.index, rowH: ROW_H }
  useEffect(
    () =>
      registerGraphNav({
        move(delta) {
          const { lastSelectedIndex: cur, selectRow: sel, count } = navState.current
          if (count === 0) return
          sel(cur < 0 ? 0 : Math.max(0, Math.min(count - 1, cur + delta)))
        },
        focusFilter() {
          filterRef.current?.focus()
          filterRef.current?.select()
        },
        reveal(sha) {
          const i = navState.current.index.get(sha)
          const el = scroller.current
          if (i === undefined || !el) return false
          el.scrollTop = revealScrollTop(i, { scrollTop: el.scrollTop, height: el.clientHeight, headerHeight: HEADER_H, rowHeight: navState.current.rowH })
          setFlash({ sha, id: ++flashSeq })
          return true
        }
      }),
    []
  )

  const jumpToMatch = (dir: 1 | -1) => {
    if (!matches || matches.size === 0) return
    const list = [...matches].sort((a, b) => a - b)
    const cur = lastSelectedIndex
    const next = dir === 1 ? (list.find((i) => i > cur) ?? list[0]) : ([...list].reverse().find((i) => i < cur) ?? list[list.length - 1])
    selectRow(next)
  }

  // ---- columns ---------------------------------------------------------------------------
  const columns = useMemo(() => visibleColumns(prefs), [prefs])
  const [dragWidths, setDragWidths] = useState<Partial<Record<ColumnId, number>> | null>(null)
  const graphContent = contentWidth(m, layout.maxColumns)
  const widths = useMemo(() => {
    const saved = { ...prefs.graphColumnWidths, ...(dragWidths ?? {}) } as Partial<Record<ColumnId, number>>
    const w = {} as Record<ColumnId, number>
    for (const c of COLUMNS) w[c.id] = Math.max(c.min, saved[c.id] ?? c.width ?? 0)
    const graphMin = m.compact ? 30 : 45
    w.graph = Math.max(graphMin, Math.min(saved.graph ?? Math.min(graphContent, GRAPH_AUTO_MAX), graphContent))
    // Give the commit message room first: when the view is too narrow, shrink the
    // other columns (least important first) down to their minimum widths.
    if (!dragWidths) {
      const fixed = columns.filter((c) => c.id !== 'message')
      let over = fixed.reduce((sum, c) => sum + w[c.id], 0) + MESSAGE_PREFERRED + SETTINGS_W - viewW
      for (const id of SHRINK_ORDER) {
        if (over <= 0) break
        const col = fixed.find((c) => c.id === id)
        if (!col) continue
        const min = id === 'graph' ? graphMin : col.min
        const d = Math.min(over, Math.max(0, w[id] - min))
        w[id] -= d
        over -= d
      }
    }
    return w
  }, [prefs.graphColumnWidths, dragWidths, graphContent, m.compact, columns, viewW])
  const minRowWidth = columns.reduce((sum, c) => sum + (c.id === 'message' ? c.min : widths[c.id]), 0)

  const startResize = (id: ColumnId) => (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const start = widths[id]
    const def = COLUMNS.find((c) => c.id === id)!
    let latest = start
    const move = (ev: globalThis.MouseEvent) => {
      latest = Math.max(def.min, Math.min(id === 'graph' ? graphContent : 800, start + ev.clientX - startX))
      setDragWidths((d) => ({ ...(d ?? {}), [id]: latest }))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      void setPrefs({ graphColumnWidths: { ...prefs.graphColumnWidths, [id]: latest } }).then(() => setDragWidths(null))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const columnMenu = (e: MouseEvent) => {
    e.preventDefault()
    const toggle = (key: keyof Preferences, label: string): MenuItem => ({
      label: `${prefs[key] ? '✓ ' : ' '}${label}`,
      onClick: () => void setPrefs({ [key]: !prefs[key] } as Partial<Preferences>)
    })
    showContextMenu(e, [
      toggle('showAuthorColumn', 'Author'),
      toggle('showChangesColumn', 'Changes'),
      toggle('showDateColumn', 'Date / Time'),
      toggle('showShaColumn', 'SHA'),
      'separator',
      {
        label: 'Graph style',
        submenu: [
          { label: `${prefs.graphMode === 'rich' ? '✓ ' : ' '}Rich (avatars)`, onClick: () => void setPrefs({ graphMode: 'rich' }) },
          { label: `${prefs.graphMode === 'compact' ? '✓ ' : ' '}Compact`, onClick: () => void setPrefs({ graphMode: 'compact' }) }
        ]
      },
      toggle('showAvatars', 'Show author avatars'),
      toggle('showCommitDescription', 'Show commit description'),
      'separator',
      { label: 'Reset column widths', onClick: () => void setPrefs({ graphColumnWidths: {} }) }
    ])
  }

  // ---- drag and drop ---------------------------------------------------------------------
  const [dropRow, setDropRow] = useState<number | null>(null)
  const onDragOver = useCallback((e: DragEvent, i: number) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropRow((cur) => (cur === i ? cur : i))
  }, [])
  const dropCtx = useRef({ repo, layout, pillsBySha })
  dropCtx.current = { repo, layout, pillsBySha }
  const onDrop = useCallback((e: DragEvent, i: number) => {
    const { repo, layout, pillsBySha } = dropCtx.current
    const full = e.dataTransfer.getData(DRAG_TYPE)
    setDropRow(null)
    if (!full) return
    e.preventDefault()
    const source = repo.refs.find((r) => r.fullName === full)
    const row = layout.rows[i]
    if (!source || !row || row.node.kind !== 'commit') return
    const pillEl = (e.target as HTMLElement).closest<HTMLElement>('[data-ref]')
    const target = repo.refs.find((r) => r.fullName === pillEl?.dataset.ref) ?? pillsBySha.get(row.node.sha)?.find((g) => g.ref.type === 'local')?.ref
    const items = dropMenuItems(repo, source, { ref: target, sha: row.node.sha })
    if (items.length) showContextMenu(e, items)
  }, [])

  // ---- visible rows ----------------------------------------------------------------------
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(layout.rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const visibleShas = useMemo(() => {
    const out: string[] = []
    for (let i = first; i < last; i++) if (layout.rows[i].node.kind === 'commit') out.push(layout.rows[i].node.sha)
    return out
  }, [first, last, layout.rows])
  const { stats, version } = useCommitStats(repo.path, visibleShas, prefs.showChangesColumn)
  const statsMax = useStatsScale(stats, version)
  useCiPolling(repo.path, visibleShas)

  const visibleRows: ReactNode[] = []
  for (let i = first; i < last; i++) {
    const row = layout.rows[i]
    const sha = row.node.sha
    const dimmed = (matches !== null && !matches.has(i)) || (highlight !== null && row.node.kind === 'commit' && !highlight.has(sha))
    visibleRows.push(
      <GraphRowView
        key={sha}
        index={i}
        row={row}
        repo={repo}
        m={m}
        columns={columns}
        widths={widths}
        pills={pillsBySha.get(sha)}
        ghost={ghostsBySha.get(sha)}
        selected={selectedShas.has(sha)}
        dimmed={dimmed}
        query={q}
        dropTarget={dropRow === i}
        flashId={flash?.sha === sha ? flash.id : undefined}
        wip={wip}
        worktree={row.node.worktree ? worktreeByPath.get(row.node.worktree) : undefined}
        onOpenWorktree={openWorktree}
        stats={prefs.showChangesColumn ? stats.get(sha) : undefined}
        statsMax={statsMax}
        showAvatars={prefs.showAvatars}
        showDescription={prefs.showCommitDescription}
        dateMode={prefs.dateFormat}
        onSelect={selectRow}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onHoverRef={onHoverRef}
      />
    )
  }

  const hiddenCount = repo.hiddenRefs.length + repo.soloRefs.length
  const activePreset = (prefs.viewPresets[repo.path] ?? []).find((p) => matchesPreset(p, repo, prefs))

  return (
    <div className="graph">
      <BehindBanner repo={repo} />
      <div
        className="graph-scroll"
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label="Commit graph (arrow keys or J/K move between commits)"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropRow(null)
        }}
      >
        <div className="graph-header" style={{ minWidth: minRowWidth }} onContextMenu={columnMenu}>
          {columns.map((c) => (
            <div key={c.id} className={`gh-cell gh-${c.id}`} style={c.id === 'message' ? undefined : { width: widths[c.id] }}>
              {c.id !== 'message' && c.id !== 'ref' && c.id !== 'graph' && widths[c.id] < HEADER_ICON_W ? (
                <span className="gh-icon" title={c.label}>
                  <ColumnIcon id={c.id} />
                </span>
              ) : (
                <span className="gh-label">{c.label}</span>
              )}
              {c.id === 'ref' && hiddenCount > 0 && (
                <button className="gh-reset" title="Show all hidden / soloed refs" onClick={() => updateRepo(repo.path, { hiddenRefs: [], soloRefs: [] })}>
                  <Icon name="eye-off" size={11} /> {hiddenCount}
                </button>
              )}
              {c.id === 'message' && (
                <SearchBox
                  inputRef={filterRef}
                  query={query}
                  onChange={setQuery}
                  onJump={jumpToMatch}
                  count={matches ? matches.size : null}
                  pending={searching}
                  errors={searchErrors}
                />
              )}
              {c.id !== 'message' && <div className="gh-resize" onMouseDown={startResize(c.id)} />}
            </div>
          ))}
          <button
            className={`gh-settings ${activePreset ? 'on' : ''}`}
            title={activePreset ? `View presets (showing “${activePreset.name}”)` : 'View presets'} aria-label={activePreset ? `View presets (showing “${activePreset.name}”)` : 'View presets'}
            onClick={(e) => showContextMenu(e, presetMenuItems(repo))}
          >
            <Icon name="layers" size={13} />
          </button>
          <button className="gh-settings" title="Column settings" aria-label="Column settings" onClick={columnMenu}>
            <Icon name="settings" size={13} />
          </button>
        </div>

        <DelayedGraphSkeleton loading={repo.loading && layout.rows.length === 0} />
        {repo.error && <div className="graph-empty error">{repo.error}</div>}
        {!repo.loading && !repo.error && layout.rows.length === 0 && (
          <div className="graph-empty">No commits yet — make your first commit from the panel on the right.</div>
        )}
        <div className={`graph-rows ${highlight ? 'highlighting' : ''}`} style={{ height: layout.rows.length * ROW_H, minWidth: minRowWidth }}>
          {visibleRows}
        </div>
      </div>
    </div>
  )
}

function ColumnIcon({ id }: { id: ColumnId }) {
  if (id === 'author') return <PersonIcon />
  return <Icon name={id === 'changes' ? 'file' : id === 'date' ? 'history' : 'commit'} size={13} />
}

export function PersonIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
      <circle cx={8} cy={5.5} r={3} />
      <path d="M2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
    </svg>
  )
}
