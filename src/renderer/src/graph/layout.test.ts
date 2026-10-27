import { describe, expect, it } from 'vitest'
import type { Commit, Stash } from '@shared/types'
import { branchCommits, buildNodes, commitsBetween, computeLayout, filterByRefs, firstParentChain, inheritedRefs, isAncestor, WIP_SHA, worktreeWipSha, type GraphLayout, type GraphNode } from './layout'

let t = 1_000_000
function c(sha: string, parents: string[] = [], refs: string[] = []): Commit {
  t -= 1000
  const sig = { name: 'A', email: 'a@x', date: t }
  return { sha, parents, author: sig, committer: sig, summary: sha, body: '', refs }
}
const nodes = (commits: Commit[]): GraphNode[] => commits.map((commit) => ({ sha: commit.sha, parents: commit.parents, kind: 'commit', commit }))
const cols = (l: GraphLayout) => l.rows.map((r) => r.column)

/** Columns that carry an edge out of the bottom of row i. */
const outCols = (l: GraphLayout, i: number) =>
  l.rows[i].edges.flatMap((cell, c) => (cell && (cell.pass || cell.start) ? [c] : []))
/** Columns where an edge enters row i from the top. */
const inCols = (l: GraphLayout, i: number) =>
  l.rows[i].edges.flatMap((cell, c) => (cell && (cell.pass || cell.end) ? [c] : []))

/** Every edge leaving the bottom of row i must enter row i+1 in the same column, and vice versa. */
function assertContinuity(l: GraphLayout) {
  expect(inCols(l, 0)).toEqual([])
  for (let i = 0; i < l.rows.length - 1; i++) {
    expect(inCols(l, i + 1), `rows ${i} -> ${i + 1}`).toEqual(outCols(l, i))
  }
  expect(outCols(l, l.rows.length - 1)).toEqual([])
}

/** Every end edge must land on the node of its row, and every start must begin at its node. */
function assertEdgesTargetNodes(l: GraphLayout) {
  l.rows.forEach((row) => {
    row.edges.forEach((cell) => {
      if (cell?.end) expect(cell.end.parent).toBe(row.node.sha)
      if (cell?.start) expect(row.node.parents).toContain(cell.start.parent)
    })
  })
}

const starts = (l: GraphLayout, i: number) => l.rows[i].edges.flatMap((cell, c) => (cell?.start ? [c] : []))
const ends = (l: GraphLayout, i: number) => l.rows[i].edges.flatMap((cell, c) => (cell?.end ? [c] : []))

describe('computeLayout', () => {
  it('lays out a linear history in one column', () => {
    const l = computeLayout(nodes([c('c', ['b']), c('b', ['a']), c('a')]))
    expect(cols(l)).toEqual([0, 0, 0])
    expect(l.maxColumns).toBe(1)
    assertContinuity(l)
    expect(l.rows[0].edges).toEqual([{ start: { parent: 'b', dashed: false } }])
    expect(l.rows[2].edges).toEqual([{ end: { parent: 'a', dashed: false } }])
  })

  it('draws a feature branch to the right of its parent and curves it back in', () => {
    //  m (merge of b1, f1)
    //  |\
    //  | f1
    //  b1 |
    //  |/
    //  a
    const l = computeLayout(nodes([c('m', ['b1', 'f1']), c('f1', ['a']), c('b1', ['a']), c('a')]))
    expect(l.rows[0].isMerge).toBe(true)
    expect(cols(l)).toEqual([0, 1, 0, 0])
    expect(l.maxColumns).toBe(2)
    // merge row: first parent straight down, second parent leaves horizontally into column 1
    expect(starts(l, 0)).toEqual([0, 1])
    // the parent row receives the side lane (column 1) with a curve into column 0
    expect(ends(l, 3)).toEqual([0, 1])
    assertContinuity(l)
    assertEdgesTargetNodes(l)
  })

  it('keeps the left-most lane when two tips share a parent', () => {
    const l = computeLayout(nodes([c('x', ['a']), c('y', ['a']), c('a')]))
    expect(cols(l)).toEqual([0, 1, 0])
    expect(ends(l, 2)).toEqual([0, 1])
    assertContinuity(l)
  })

  it('handles octopus merges', () => {
    const l = computeLayout(nodes([c('m', ['p1', 'p2', 'p3']), c('p3', ['r']), c('p2', ['r']), c('p1', ['r']), c('r')]))
    expect(l.rows[0].isMerge).toBe(true)
    expect(starts(l, 0)).toEqual([0, 1, 2])
    expect(cols(l)).toEqual([0, 2, 1, 0, 0])
    expect(l.maxColumns).toBe(3)
    assertContinuity(l)
    assertEdgesTargetNodes(l)
  })

  it('handles criss-cross merges', () => {
    // m1 = merge(a1, b1), m2 = merge(b1, a1); both a1 and b1 come from r
    const l = computeLayout(nodes([c('m1', ['a1', 'b1']), c('m2', ['b1', 'a1']), c('b1', ['r']), c('a1', ['r']), c('r')]))
    assertContinuity(l)
    assertEdgesTargetNodes(l)
    expect(l.maxColumns).toBeLessThanOrEqual(3)
    expect(cols(l)).toEqual([0, 2, 1, 0, 0])
    // m2 keeps its own lane for its first parent and joins the existing lane of its merge parent
    expect(starts(l, 1)).toEqual([0, 2])
  })

  it('ends lanes for parents beyond the loaded history', () => {
    const l = computeLayout(nodes([c('b', ['a']), c('a', ['missing'])]))
    expect(l.rows[1].truncated).toBe(true)
    expect(starts(l, 1)).toEqual([])
    assertContinuity(l)
  })

  it('reuses freed lanes instead of growing', () => {
    // two short-lived side branches one after another should both use column 1
    const l = computeLayout(nodes([c('m2', ['m1', 's2']), c('s2', ['m1']), c('m1', ['x', 's1']), c('s1', ['x']), c('x')]))
    expect(cols(l)).toEqual([0, 1, 0, 1, 0])
    expect(l.maxColumns).toBe(2)
    assertContinuity(l)
  })

  it('gives unrelated roots separate columns and frees them afterwards', () => {
    const l = computeLayout(nodes([c('a2', ['a1']), c('b2', ['b1']), c('a1'), c('b1'), c('z2', ['z1']), c('z1')]))
    expect(cols(l)).toEqual([0, 1, 0, 1, 0, 0])
    assertContinuity(l)
  })
})

describe('pin to left', () => {
  it('keeps the pinned branch in column 0 and moves others right', () => {
    // feature tip is newest, so without pinning it would take column 0
    const list = nodes([c('f2', ['f1']), c('m2', ['m1']), c('f1', ['m1']), c('m1', ['r']), c('r')])
    expect(cols(computeLayout(list))).toEqual([0, 1, 0, 0, 0])
    const pinned = firstParentChain(list, 'm2')
    expect([...pinned]).toEqual(['m2', 'm1', 'r'])
    const l = computeLayout(list, { pinned })
    expect(cols(l)).toEqual([1, 0, 1, 0, 0])
    assertContinuity(l)
    assertEdgesTargetNodes(l)
  })
})

describe('computeLayout fuzz', () => {
  it('keeps every lane continuous on random histories', () => {
    let seed = 42
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    let lostParents = 0
    let parentEdges = 0
    for (let run = 0; run < 20; run++) {
      // Build oldest -> newest, then reverse so the input is newest first (a valid topo order).
      const list: Commit[] = []
      for (let i = 0; i < 200; i++) {
        const parents: string[] = []
        if (i > 0) parents.push(`c${Math.max(0, i - 1 - Math.floor(rand() * Math.min(i, 8)))}`)
        if (i > 3 && rand() < 0.2) {
          const p = `c${Math.floor(rand() * (i - 1))}`
          if (!parents.includes(p)) parents.push(p)
        }
        list.push(c(`c${i}`, parents))
      }
      const l = computeLayout(nodes(list.reverse()))
      assertContinuity(l)
      assertEdgesTargetNodes(l)
      for (const r of l.rows) expect(r.column).toBeLessThan(r.width)
      // Every child -> parent link should arrive as an end edge at the parent row.
      const arrived = new Set<string>()
      l.rows.forEach((row) => row.edges.forEach((cell) => cell?.end && arrived.add(row.node.sha)))
      for (const r of l.rows) {
        for (const p of r.node.parents) {
          parentEdges++
          if (!arrived.has(p)) lostParents++
        }
      }
    }
    expect(lostParents / parentEdges).toBeLessThan(0.01)
  })
})

describe('buildNodes', () => {
  it('adds a WIP row attached to HEAD', () => {
    const commits = [c('h', ['p']), c('p')]
    const n = buildNodes(commits, { wipHeadSha: 'h' })
    expect(n[0]).toMatchObject({ sha: WIP_SHA, parents: ['h'], kind: 'wip' })
    const l = computeLayout(n)
    expect(l.rows[0].edges[0]?.start?.dashed).toBe(true)
    assertContinuity(l)
  })

  it('adds a WIP row for another worktree right above its HEAD without moving that commit', () => {
    // m2 continues main's lane (column 0); the worktree sits on m1, which main's lane already reserves
    const commits = [c('f2', ['f1']), c('m2', ['m1']), c('f1', ['m1']), c('m1')]
    const plain = computeLayout(buildNodes(commits))
    const n = buildNodes(commits, { worktreeWips: [{ path: '/wt', headSha: 'm1' }, { path: '/gone', headSha: 'missing' }] })
    expect(n.map((x) => x.sha)).toEqual(['f2', 'm2', 'f1', worktreeWipSha('/wt'), 'm1'])
    expect(n[3]).toMatchObject({ kind: 'wip', parents: ['m1'], worktree: '/wt' })
    const l = computeLayout(n)
    expect(l.rows[4].column).toBe(plain.rows[3].column)
    expect(l.rows[3].edges[l.rows[3].column]?.start?.dashed).toBe(true)
    assertContinuity(l)
  })

  it('inserts stash rows above their base and drops stash internals', () => {
    const newer = c('newer', ['base'])
    // `git log --all` would include the stash commit and its index commit
    const stashCommit = c('st', ['base', 'idx'])
    const idx = c('idx', ['base'])
    const base = c('base', ['root'])
    const root = c('root')
    const stash: Stash = { index: 0, ref: 'stash@{0}', sha: 'st', message: 'wip', date: base.committer.date + 10, baseSha: 'base' }
    const n = buildNodes([newer, stashCommit, idx, base, root], { stashes: [stash] })
    expect(n.map((x) => x.sha)).toEqual(['newer', 'st', 'base', 'root'])
    expect(n[1].kind).toBe('stash')
    assertContinuity(computeLayout(n))
  })
})

describe('ref helpers', () => {
  const commits = [c('f2', ['f1'], ['refs/heads/feat']), c('m2', ['m1'], ['refs/heads/main']), c('f1', ['m1']), c('m1')]
  const refs = [
    { fullName: 'refs/heads/feat', sha: 'f2', type: 'local' },
    { fullName: 'refs/heads/main', sha: 'm2', type: 'local' }
  ]

  it('hides commits only reachable from hidden refs', () => {
    const v = filterByRefs(commits, refs, ['refs/heads/feat'], [], 'm2').map((x) => x.sha)
    expect(v).toEqual(['m2', 'm1'])
  })

  it('solo shows only the soloed ref history', () => {
    const v = filterByRefs(commits, refs, [], ['refs/heads/feat'], 'm2').map((x) => x.sha)
    expect(v).toEqual(['f2', 'f1', 'm1'])
  })

  it('computes commits between head and base oldest first', () => {
    expect(commitsBetween(commits, 'f2', 'm1')).toEqual(['f1', 'f2'])
    expect(isAncestor(commits, 'm1', 'f2')).toBe(true)
    expect(isAncestor(commits, 'm2', 'f2')).toBe(false)
  })

  it('finds the commits that belong to a branch', () => {
    expect([...branchCommits(commits, 'f2', ['m2'])].sort()).toEqual(['f1', 'f2'])
    // fully merged branch falls back to its first-parent chain
    expect([...branchCommits(commits, 'm1', ['m2'])]).toEqual(['m1'])
  })
})

describe('inheritedRefs', () => {
  it('gives ref-less commits the refs of their nearest first-parent descendant', () => {
    const list = [c('f2', ['f1']), c('m2', ['m1', 'f1']), c('f1', ['m1']), c('m1')]
    const refs = new Map([
      ['f2', ['feat']],
      ['m2', ['main']]
    ])
    const got = inheritedRefs(nodes(list), refs)
    expect(got.get('f1')).toEqual(['feat'])
    expect(got.get('m1')).toEqual(['main'])
    expect(got.has('f2')).toBe(false)
  })
})
