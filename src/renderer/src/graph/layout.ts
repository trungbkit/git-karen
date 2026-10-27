// Commit graph lane layout. Pure functions, no React.
//
// How the graph is shaped:
//  * Each row has one node in a column. A commit's first parent continues in the commit's own
//    column; extra (merge) parents get a column of their own, reserved until that parent's row.
//  * When two lanes wait for the same parent, the parent keeps the left-most one; the other lane
//    runs down to the parent row and curves into it there ("branch out" shape).
//  * Every row stores, per column, the edge segments drawn inside it:
//      pass  - lane crossing the row (vertical line, full height)
//      start - edge leaving this row's node toward a parent (node column: straight down; other
//              columns: horizontal from the node, then a rounded corner down into the column)
//      end   - edge arriving at this row's node (node column: straight down into the node; other
//              columns: down from the top, then a rounded corner into the node horizontally)
//  * Colours are per column, so an edge takes the colour of the column it runs in.

import type { Commit, Stash } from '@shared/types'

export type NodeKind = 'commit' | 'wip' | 'stash'

export interface GraphNode {
  sha: string
  parents: string[]
  kind: NodeKind
  commit?: Commit
  stash?: Stash
  /** For WIP rows of other worktrees: the worktree path */
  worktree?: string
}

export interface Edge {
  /** The parent sha this edge leads to */
  parent: string
  /** WIP and stash connectors are dashed */
  dashed: boolean
}

export interface EdgeCell {
  pass?: Edge
  start?: Edge
  end?: Edge
}

export interface GraphRow {
  node: GraphNode
  column: number
  /** Edge cells indexed by column (sparse) */
  edges: (EdgeCell | undefined)[]
  isMerge: boolean
  /** True if some parent was not part of the loaded commits (history truncated) */
  truncated: boolean
  /** Number of columns spanned by this row (node and edges) */
  width: number
}

export interface GraphLayout {
  rows: GraphRow[]
  maxColumns: number
  /** sha -> row index */
  index: Map<string, number>
}

export const WIP_SHA = '__wip__'

/** Row id of another worktree's WIP row. */
export const worktreeWipSha = (path: string) => `${WIP_SHA}:${path}`

interface Reservation {
  column: number
  kind: NodeKind
  date: number
}

function nodeDate(node: GraphNode): number {
  return node.commit?.committer.date ?? node.stash?.date ?? Number.MAX_SAFE_INTEGER
}

/** Pass 1: assign a column to every node. Pinned nodes always take column 0. */
function assignColumns(nodes: GraphNode[], known: Set<string>, pinned: Set<string>): number[] {
  const used: boolean[] = []
  const reserved = new Map<string, Reservation>()
  const freeWhenFound = new Map<string, number[]>()
  const hasMergeChild = new Set<string>()
  const columns: number[] = []

  const allocate = () => {
    let i = pinned.size > 0 ? 1 : 0
    while (used[i]) i++
    used[i] = true
    return i
  }
  const freeLater = (sha: string, col: number) => {
    const list = freeWhenFound.get(sha)
    if (list) list.push(col)
    else freeWhenFound.set(sha, [col])
  }

  for (const node of nodes) {
    for (const col of freeWhenFound.get(node.sha) ?? []) used[col] = false
    freeWhenFound.delete(node.sha)
    hasMergeChild.delete(node.sha)

    const own = reserved.get(node.sha)
    reserved.delete(node.sha)
    let releaseAfterRow = -1
    let column: number
    if (pinned.has(node.sha)) {
      column = 0
      used[0] = true
      // The lane that led here ends at this row.
      if (own && own.column !== 0) releaseAfterRow = own.column
    } else {
      column = own ? own.column : allocate()
    }
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
        // Another worktree's WIP row joins its commit without pulling the commit out of its lane.
        const sideWip = node.worktree !== undefined
        if ((existing.column > column || stashYields) && !hasMergeChild.has(parent) && !sideWip) {
          reserved.set(parent, { column, kind: node.kind, date: own?.date ?? nodeDate(node) })
          freeLater(parent, existing.column)
        } else {
          freeLater(parent, column)
        }
      } else if (!existing) {
        reserved.set(parent, {
          column: pinned.has(parent) ? 0 : k === 0 ? column : allocate(),
          kind: node.kind,
          date: own && own.column === column ? own.date : nodeDate(node)
        })
      }
    })
    // A lane whose first parent is not loaded (root commit or truncated history) ends here.
    if (parents.length === 0 || parents[0] !== node.parents[0]) {
      if (![...reserved.values()].some((r) => r.column === column)) used[column] = false
    }
    if (releaseAfterRow >= 0 && ![...reserved.values()].some((r) => r.column === releaseAfterRow)) used[releaseAfterRow] = false
  }
  return columns
}

export interface LayoutOptions {
  /** Shas kept in column 0 (the first-parent chain of a branch pinned to the left) */
  pinned?: Set<string>
}

export function computeLayout(nodes: GraphNode[], opts: LayoutOptions = {}): GraphLayout {
  const known = new Set(nodes.map((n) => n.sha))
  const columns = assignColumns(nodes, known, opts.pinned ?? new Set())
  const index = new Map<string, number>()
  nodes.forEach((n, i) => index.set(n.sha, i))

  const rows: GraphRow[] = []
  let prev: (EdgeCell | undefined)[] = []
  let maxColumns = 0

  nodes.forEach((node, i) => {
    const column = columns[i]
    const edges: (EdgeCell | undefined)[] = []

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
      const c = k === 0 ? column : columns[index.get(parent)!]
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

export interface BuildOptions {
  /** HEAD sha; when set a WIP row is added on top, attached to HEAD. */
  wipHeadSha?: string | null
  stashes?: Stash[]
  /** Other worktrees with uncommitted changes; each gets a WIP row right above its HEAD commit */
  worktreeWips?: { path: string; headSha: string }[]
}

/**
 * Turn commits (newest first) into graph nodes: drops stash-internal commits that `git log --all`
 * may include, inserts stash rows above their base commit (by date) and the WIP row on top.
 */
export function buildNodes(commits: Commit[], opts: BuildOptions = {}): GraphNode[] {
  const stashes = opts.stashes ?? []
  const stashShas = new Set(stashes.map((s) => s.sha))
  const internal = new Set<string>()
  for (const c of commits) {
    if (stashShas.has(c.sha)) for (const p of c.parents.slice(1)) internal.add(p)
  }
  const plain = commits.filter((c) => !stashShas.has(c.sha) && !internal.has(c.sha))
  const nodes: GraphNode[] = plain.map((commit) => ({ sha: commit.sha, parents: commit.parents, kind: 'commit', commit }))

  if (stashes.length > 0) {
    const pos = new Map(nodes.map((n, i) => [n.sha, i]))
    // Insert oldest-first so newer stashes end up above older ones at the same position.
    const ordered = [...stashes].sort((a, b) => a.date - b.date)
    const inserts: { at: number; node: GraphNode; date: number }[] = []
    for (const stash of ordered) {
      const base = pos.get(stash.baseSha)
      let at = nodes.findIndex((n) => (n.commit?.committer.date ?? 0) < stash.date)
      if (at === -1) at = nodes.length
      if (base !== undefined) at = Math.min(at, base)
      inserts.push({ at, date: stash.date, node: { sha: stash.sha, parents: base !== undefined ? [stash.baseSha] : [], kind: 'stash', stash } })
    }
    // Apply from the back so indices stay valid; among equal positions newest goes first.
    inserts.sort((a, b) => b.at - a.at || a.date - b.date)
    for (const ins of inserts) nodes.splice(ins.at, 0, ins.node)
  }

  for (const wt of opts.worktreeWips ?? []) {
    const at = nodes.findIndex((n) => n.sha === wt.headSha)
    if (at === -1) continue
    nodes.splice(at, 0, { sha: worktreeWipSha(wt.path), parents: [wt.headSha], kind: 'wip', worktree: wt.path })
  }

  if (opts.wipHeadSha !== undefined) {
    const parents = opts.wipHeadSha && nodes.some((n) => n.sha === opts.wipHeadSha) ? [opts.wipHeadSha] : []
    nodes.unshift({ sha: WIP_SHA, parents, kind: 'wip' })
  }
  return nodes
}

/**
 * For each node without refs, the refs of its closest descendant branch tip ("ghost" refs shown
 * when hovering or selecting a commit). Preference: reached via a first-parent link, then the
 * nearest row. `refsBySha` maps commit sha -> ref ids at that commit.
 */
export function inheritedRefs<T>(nodes: GraphNode[], refsBySha: Map<string, T[]>): Map<string, T[]> {
  interface Candidate {
    refs: T[]
    parentIndex: number
    row: number
  }
  const pending = new Map<string, Candidate[]>()
  const result = new Map<string, T[]>()
  nodes.forEach((node, row) => {
    const own = refsBySha.get(node.sha)
    let inherited: T[] | undefined
    const cands = pending.get(node.sha)
    if (cands?.length) {
      cands.sort((a, b) => a.parentIndex - b.parentIndex || a.row - b.row)
      inherited = cands[0].refs
      pending.delete(node.sha)
    }
    if (inherited && !own?.length) result.set(node.sha, inherited)
    const pass = own?.length ? own : inherited
    if (!pass || node.kind !== 'commit') return
    node.parents.forEach((p, k) => {
      const list = pending.get(p) ?? []
      list.push({ refs: pass, parentIndex: k, row })
      pending.set(p, list)
    })
  })
  return result
}

/** First-parent chain of `tip` within the given nodes (used for "Pin to Left"). */
export function firstParentChain(nodes: GraphNode[], tip: string | null): Set<string> {
  const chain = new Set<string>()
  if (!tip) return chain
  const bySha = new Map(nodes.map((n) => [n.sha, n]))
  let cur: string | undefined = tip
  while (cur && bySha.has(cur) && !chain.has(cur)) {
    chain.add(cur)
    cur = bySha.get(cur)!.parents[0]
  }
  return chain
}

/**
 * Commits reachable from `starts` following parent links over the loaded commits.
 */
export function reachable(commits: Commit[], starts: Iterable<string>): Set<string> {
  const bySha = new Map(commits.map((c) => [c.sha, c]))
  const seen = new Set<string>()
  const stack = [...starts]
  while (stack.length) {
    const sha = stack.pop()!
    if (seen.has(sha)) continue
    const c = bySha.get(sha)
    if (!c) continue
    seen.add(sha)
    for (const p of c.parents) if (!seen.has(p)) stack.push(p)
  }
  return seen
}

/**
 * Commits that belong to the branch at `tip`: reachable from it but not from any of `others`.
 * Falls back to the first-parent chain when the branch is fully merged elsewhere.
 */
export function branchCommits(commits: Commit[], tip: string, others: Iterable<string>): Set<string> {
  const own = reachable(commits, [tip])
  const rest = reachable(
    commits,
    [...others].filter((s) => s !== tip)
  )
  const unique = new Set([...own].filter((s) => !rest.has(s)))
  if (unique.size > 0) return unique
  const bySha = new Map(commits.map((c) => [c.sha, c]))
  const chain = new Set<string>()
  let cur: string | undefined = tip
  while (cur && bySha.has(cur) && !chain.has(cur)) {
    chain.add(cur)
    cur = bySha.get(cur)!.parents[0]
  }
  return chain
}

/**
 * Apply hide/solo ref filters. Returns the commits that remain visible
 * (all commits when no filter is active). HEAD is always kept visible.
 */
export function filterByRefs(
  commits: Commit[],
  refs: { fullName: string; sha: string; type: string }[],
  hidden: string[],
  solo: string[],
  headSha: string | null
): Commit[] {
  if (hidden.length === 0 && solo.length === 0) return commits
  const starts: string[] = []
  if (solo.length > 0) {
    for (const r of refs) if (solo.includes(r.fullName)) starts.push(r.sha)
  } else {
    for (const r of refs) if (!hidden.includes(r.fullName) && r.type !== 'stash') starts.push(r.sha)
  }
  if (headSha && solo.length === 0) starts.push(headSha)
  // Tags may point at tag objects; also accept refs recorded on commits themselves.
  const visibleNames = new Set(refs.filter((r) => (solo.length ? solo.includes(r.fullName) : !hidden.includes(r.fullName))).map((r) => r.fullName))
  for (const c of commits) if (c.refs.some((r) => visibleNames.has(r))) starts.push(c.sha)
  const keep = reachable(commits, starts)
  return commits.filter((c) => keep.has(c.sha))
}

/** Commits reachable from `head` but not from `base`, oldest first (for interactive rebase). */
export function commitsBetween(commits: Commit[], head: string, base: string): string[] {
  const fromBase = reachable(commits, [base])
  const fromHead = reachable(commits, [head])
  return commits
    .filter((c) => fromHead.has(c.sha) && !fromBase.has(c.sha))
    .map((c) => c.sha)
    .reverse()
}

/** True if `ancestor` is reachable from `descendant` within the loaded commits. */
export function isAncestor(commits: Commit[], ancestor: string, descendant: string): boolean {
  return reachable(commits, [descendant]).has(ancestor)
}
