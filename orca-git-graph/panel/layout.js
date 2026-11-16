// Commit graph lane layout, ported from Karen's src/renderer/src/graph/layout.ts. Pure functions.
//
// How the graph is shaped:
//  * Each row has one node in a column. A commit's first parent continues in the commit's own
//    column; extra (merge) parents get a column of their own, reserved until that parent's row.
//  * When two lanes wait for the same parent, the parent keeps the left-most one; the other lane
//    runs down to the parent row and curves into it there ("branch out" shape).
//  * Every row stores, per column, the edge segments drawn inside it:
//      pass  - lane crossing the row (vertical line, full height)
//      start - edge leaving this row's node toward a parent
//      end   - edge arriving at this row's node
//  * Colours are per column, so an edge takes the colour of the column it runs in.
//
// Commits use the worker's short wire format: { h, p, a, e, t, ct, s, r? }.

/** @typedef {'commit' | 'wip' | 'stash'} NodeKind */
/** @typedef {{ sha: string, parents: string[], kind: NodeKind, commit?: any, stash?: any }} GraphNode */
/** @typedef {{ parent: string, dashed: boolean }} Edge */
/** @typedef {{ pass?: Edge, start?: Edge, end?: Edge }} EdgeCell */
/** @typedef {{ node: GraphNode, column: number, edges: (EdgeCell | undefined)[], isMerge: boolean, truncated: boolean, width: number }} GraphRow */

export const WIP_SHA = '__wip__'

function nodeDate(node) {
  return node.commit?.ct ?? node.stash?.date ?? Number.MAX_SAFE_INTEGER
}

/** Pass 1: assign a column to every node. */
function assignColumns(nodes, known) {
  const used = []
  const reserved = new Map()
  const freeWhenFound = new Map()
  const hasMergeChild = new Set()
  const columns = []

  const allocate = () => {
    let i = 0
    while (used[i]) i++
    used[i] = true
    return i
  }
  const freeLater = (sha, col) => {
    const list = freeWhenFound.get(sha)
    if (list) list.push(col)
    else freeWhenFound.set(sha, [col])
  }
  const isReserved = (col) => {
    for (const r of reserved.values()) if (r.column === col) return true
    return false
  }

  for (const node of nodes) {
    for (const col of freeWhenFound.get(node.sha) ?? []) used[col] = false
    freeWhenFound.delete(node.sha)
    hasMergeChild.delete(node.sha)

    const own = reserved.get(node.sha)
    reserved.delete(node.sha)
    const column = own ? own.column : allocate()
    columns.push(column)

    const parents = node.parents.filter((p) => known.has(p))
    const isMerge = node.kind === 'commit' && parents.length > 1
    parents.forEach((parent, k) => {
      if (isMerge) hasMergeChild.add(parent)
      const existing = reserved.get(parent)
      if (k === 0 && existing && existing.column !== column) {
        // Two lanes lead to the same parent: the parent keeps the left-most lane, unless a
        // merge child already routes into it. Stash lanes yield to newer real branches.
        const stashYields = existing.kind === 'stash' && node.kind !== 'stash' && (own?.date ?? 0) > existing.date
        if ((existing.column > column || stashYields) && !hasMergeChild.has(parent)) {
          reserved.set(parent, { column, kind: node.kind, date: own?.date ?? nodeDate(node) })
          freeLater(parent, existing.column)
        } else {
          freeLater(parent, column)
        }
      } else if (!existing) {
        reserved.set(parent, {
          column: k === 0 ? column : allocate(),
          kind: node.kind,
          date: own && own.column === column ? own.date : nodeDate(node)
        })
      }
    })
    // A lane whose first parent is not loaded (root commit or truncated history) ends here.
    if (parents.length === 0 || parents[0] !== node.parents[0]) {
      if (!isReserved(column)) used[column] = false
    }
  }
  return columns
}

/** @returns {{ rows: GraphRow[], maxColumns: number, index: Map<string, number> }} */
export function computeLayout(nodes) {
  const known = new Set(nodes.map((n) => n.sha))
  const columns = assignColumns(nodes, known)
  const index = new Map()
  nodes.forEach((n, i) => index.set(n.sha, i))

  const rows = []
  let prev = []
  let maxColumns = 0

  nodes.forEach((node, i) => {
    const column = columns[i]
    const edges = []

    // Edges carried over from the row above either end at this node or pass through.
    prev.forEach((cell, c) => {
      if (!cell) return
      const { pass, start } = cell
      const edge = pass && !pass.dashed ? pass : start && !start.dashed ? start : (pass ?? start)
      if (!edge) return
      edges[c] = edge.parent === node.sha ? { end: edge } : { pass: edge }
    })

    const parents = node.parents.filter((p) => known.has(p))
    const dashed = node.kind !== 'commit'
    parents.forEach((parent, k) => {
      const c = k === 0 ? column : columns[index.get(parent)]
      const cell = (edges[c] ??= {})
      cell.start = { parent, dashed }
    })

    let width = column + 1
    edges.forEach((cell, c) => {
      if (cell) width = Math.max(width, c + 1)
    })
    maxColumns = Math.max(maxColumns, width)

    rows.push({
      node,
      column,
      edges,
      isMerge: node.kind === 'commit' && parents.length > 1,
      truncated: parents.length < node.parents.length,
      width
    })
    prev = edges
  })

  return { rows, maxColumns, index }
}

/**
 * Turn commits (newest first) into graph nodes: drops stash-internal commits, inserts stash rows
 * above their base commit (by date) and the WIP row on top when `wipHeadSha` is given.
 */
export function buildNodes(commits, { stashes = [], wipHeadSha } = {}) {
  const stashShas = new Set(stashes.map((s) => s.sha))
  const internal = new Set()
  for (const c of commits) {
    if (stashShas.has(c.h)) for (const p of c.p.slice(1)) internal.add(p)
  }
  const plain = commits.filter((c) => !stashShas.has(c.h) && !internal.has(c.h))
  const nodes = plain.map((commit) => ({ sha: commit.h, parents: commit.p, kind: 'commit', commit }))

  if (stashes.length > 0) {
    const pos = new Map(nodes.map((n, i) => [n.sha, i]))
    // Insert oldest-first so newer stashes end up above older ones at the same position.
    const ordered = [...stashes].sort((a, b) => a.date - b.date)
    const inserts = []
    for (const stash of ordered) {
      const base = pos.get(stash.baseSha)
      let at = nodes.findIndex((n) => (n.commit?.ct ?? 0) < stash.date)
      if (at === -1) at = nodes.length
      if (base !== undefined) at = Math.min(at, base)
      else if (at === nodes.length) continue // its base is beyond the loaded history
      inserts.push({ at, date: stash.date, node: { sha: stash.sha, parents: base !== undefined ? [stash.baseSha] : [], kind: 'stash', stash } })
    }
    // Apply from the back so indices stay valid; among equal positions newest goes first.
    inserts.sort((a, b) => b.at - a.at || a.date - b.date)
    for (const ins of inserts) nodes.splice(ins.at, 0, ins.node)
  }

  if (wipHeadSha !== undefined) {
    const parents = wipHeadSha && nodes.some((n) => n.sha === wipHeadSha) ? [wipHeadSha] : []
    nodes.unshift({ sha: WIP_SHA, parents, kind: 'wip' })
  }
  return nodes
}

// ------------------------------------------------------------------------------- geometry

/**
 * Sizes for a narrow sidebar. With `avatars`, commit nodes are author pictures (Karen's rich graph,
 * scaled to the row); without, Karen's compact dots.
 */
export function metrics(rowH = 24, { avatars = true } = {}) {
  const base = { rowH, mid: rowH / 2, lineWidth: 1.5, inset: 4, gutter: 8, mergeSize: 8, corner: 6 }
  if (!avatars) return { ...base, inset: 6, colWidth: 12, nodeSize: 10 }
  const nodeSize = Math.min(20, rowH - 4)
  return { ...base, colWidth: nodeSize + 2, nodeSize }
}

/** Centre x of a lane. */
export function laneX(m, col) {
  return m.inset + col * m.colWidth + m.colWidth / 2
}

/** Width needed to show every lane without clipping. */
export function contentWidth(m, columns) {
  return Math.max(1, columns) * m.colWidth + m.inset + m.gutter
}

/**
 * SVG path data for the edges of a row. `nodeX` may differ from the node's lane centre when the
 * node is clamped into a narrowed graph column.
 * @returns {{ d: string, col: number, dashed: boolean }[]}
 */
export function rowEdgePaths(m, row, nodeX) {
  const { rowH, mid } = m
  const out = []
  row.edges.forEach((cell, col) => {
    if (!cell) return
    const x = laneX(m, col)
    const own = col === row.column
    if (cell.pass) out.push({ d: `M${x} 0V${rowH}`, col, dashed: cell.pass.dashed })
    if (cell.end) {
      if (own) out.push({ d: `M${x} 0V${mid}`, col, dashed: cell.end.dashed })
      else {
        // down from the top, then turn horizontally toward the node
        const r = Math.min(m.corner, Math.abs(x - nodeX))
        const dir = nodeX < x ? -1 : 1
        const sweep = dir > 0 ? 0 : 1
        out.push({ d: `M${x} 0V${mid - r}A${r} ${r} 0 0 ${sweep} ${x + dir * r} ${mid}H${nodeX}`, col, dashed: cell.end.dashed })
      }
    }
    if (cell.start) {
      if (own) out.push({ d: `M${x} ${mid}V${rowH}`, col, dashed: cell.start.dashed })
      else {
        // leave the node horizontally, then turn down into the parent's lane
        const r = Math.min(m.corner, Math.abs(x - nodeX))
        const dir = x > nodeX ? 1 : -1
        const sweep = dir > 0 ? 1 : 0
        out.push({ d: `M${nodeX} ${mid}H${x - dir * r}A${r} ${r} 0 0 ${sweep} ${x} ${mid + r}V${rowH}`, col, dashed: cell.start.dashed })
      }
    }
  })
  return out
}

/** Very short relative time for a narrow date column: "5m", "3h", "2d", "4mo", "1y". */
export function compactAgo(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`
  return `${Math.floor(s / (86400 * 365))}y`
}

/** Branch/tag pills for one commit: a local branch and its remote twins share one pill. */
export function groupRefs(refs, currentBranch) {
  const groups = []
  const byName = new Map()
  for (const full of refs ?? []) {
    let type, name
    if (full.startsWith('refs/heads/')) [type, name] = ['local', full.slice(11)]
    else if (full.startsWith('refs/remotes/')) [type, name] = ['remote', full.slice(13)]
    else if (full.startsWith('refs/tags/')) [type, name] = ['tag', full.slice(10)]
    else [type, name] = ['other', full]
    const short = type === 'remote' ? name.slice(name.indexOf('/') + 1) : name
    const key = type === 'tag' ? `tag:${name}` : `branch:${short}`
    let g = byName.get(key)
    if (!g) {
      g = { key, name: type === 'remote' ? name : short, type, local: false, remotes: [], current: false }
      byName.set(key, g)
      groups.push(g)
    }
    if (type === 'local') {
      g.local = true
      g.name = short
      g.type = 'local'
      if (short === currentBranch) g.current = true
    } else if (type === 'remote') {
      g.remotes.push(name)
      if (!g.local) g.name = g.remotes.length > 1 ? short : name
    }
  }
  // The checked-out branch first, then local branches, remotes, tags.
  const rank = (g) => (g.current ? 0 : g.type === 'local' ? 1 : g.type === 'remote' ? 2 : 3)
  return groups.sort((a, b) => rank(a) - rank(b))
}
