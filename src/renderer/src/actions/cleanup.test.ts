import { describe, expect, it } from 'vitest'
import type { MergedBranch, Ref, SquashCheck } from '@shared/types'
import {
  DIRTY_CURRENT,
  baseCandidates,
  cachedChecks,
  checkoutTarget,
  cleanupRows,
  defaultBase,
  filterCandidates,
  groupRows,
  groupSelection,
  hintCount,
  hintNames,
  isSelected,
  rangeChoices,
  rememberChecks,
  remoteDeletions,
  selectedByDefault,
  squashBatches
} from './cleanup'

const branch = (name: string, reason: MergedBranch['reason'], extra: Partial<MergedBranch> = {}): MergedBranch => ({
  name,
  sha: `${name}-sha`,
  reason,
  gone: reason === 'gone',
  upstreamMerged: false,
  upstreamMatches: false,
  ...extra
})

const check = (name: string, squashed: boolean): SquashCheck => ({ name, squashed, unmerged: [], unmergedCount: 0 })

const opts = { checking: false, currentBranch: null, dirty: 0 }

describe('cleanupRows', () => {
  it('shows merged, squash merged and upstream-deleted branches, and hides the rest', () => {
    const branches = [branch('m', 'merged'), branch('g', 'gone'), branch('gs', 'gone'), branch('u', 'unknown'), branch('us', 'unknown')]
    const checks = { gs: check('gs', true), us: check('us', true), u: check('u', false), g: check('g', false) }
    const rows = cleanupRows(branches, checks, opts)
    expect(rows.map((r) => [r.branch.name, r.status])).toEqual([
      ['m', 'merged'],
      ['g', 'gone'],
      ['gs', 'squashed'],
      ['us', 'squashed']
    ])
  })

  it('shows upstream-deleted branches as checking until their check is in, and hides unknown ones', () => {
    const rows = cleanupRows([branch('g', 'gone'), branch('u', 'unknown')], {}, { ...opts, checking: true })
    expect(rows.map((r) => [r.branch.name, r.status])).toEqual([['g', 'checking']])
    // a check that failed leaves them as upstream deleted
    expect(cleanupRows([branch('g', 'gone')], {}, opts)[0].status).toBe('gone')
  })

  it('locks branches checked out elsewhere, and the current branch while it has changes', () => {
    const branches = [branch('here', 'merged', { worktree: '/repo' }), branch('there', 'merged', { worktree: '/wt/there' })]
    const clean = cleanupRows(branches, {}, { ...opts, currentBranch: 'here' })
    expect(clean.map((r) => [r.current, r.locked])).toEqual([
      [true, undefined],
      [false, '/wt/there']
    ])
    const dirty = cleanupRows(branches, {}, { ...opts, currentBranch: 'here', dirty: 2 })
    expect(dirty[0].locked).toBe(DIRTY_CURRENT)
  })
})

describe('selection', () => {
  const rows = cleanupRows(
    [branch('m', 'merged'), branch('s', 'unknown'), branch('g', 'gone'), branch('cur', 'merged', { worktree: '/repo' }), branch('wt', 'merged', { worktree: '/wt' })],
    { s: check('s', true), g: check('g', false) },
    { ...opts, currentBranch: 'cur' }
  )
  const byName = (name: string) => rows.find((r) => r.branch.name === name)!

  it('ticks merged and squash merged branches, but not upstream-deleted, current or locked ones', () => {
    expect(rows.map((r) => [r.branch.name, selectedByDefault(r)])).toEqual([
      ['m', true],
      ['s', true],
      ['g', false],
      ['cur', false],
      ['wt', false]
    ])
  })

  it('follows the user, except that a locked branch is never selected', () => {
    expect(isSelected(byName('g'), { g: true })).toBe(true)
    expect(isSelected(byName('m'), { m: false })).toBe(false)
    expect(isSelected(byName('cur'), { cur: true })).toBe(true)
    expect(isSelected(byName('wt'), { wt: true })).toBe(false)
  })
})

describe('remoteDeletions', () => {
  it('deletes merged upstreams, and upstreams matching a squash-merged branch', () => {
    const up = (name: string) => `refs/remotes/origin/${name}`
    const rows = cleanupRows(
      [
        branch('merged-up', 'merged', { upstream: up('merged-up'), upstreamMerged: true }),
        branch('kept-up', 'merged', { upstream: up('kept-up') }),
        branch('squash-up', 'unknown', { upstream: up('squash-up'), upstreamMatches: true }),
        branch('moved-up', 'unknown', { upstream: up('moved-up') }),
        branch('matches-but-unmerged', 'gone', { upstreamMatches: true })
      ],
      { 'squash-up': check('squash-up', true), 'moved-up': check('moved-up', true), 'matches-but-unmerged': check('matches-but-unmerged', false) },
      opts
    )
    expect(remoteDeletions(rows).map((r) => r.branch.name)).toEqual(['merged-up', 'squash-up'])
  })
})

describe('checkoutTarget', () => {
  const ref = (fullName: string, extra: Partial<Ref> = {}): Ref => ({
    fullName,
    name: fullName.replace(/^refs\/(heads|remotes)\//, ''),
    type: fullName.startsWith('refs/heads/') ? 'local' : 'remote',
    sha: 'x',
    ...extra
  })
  const remotes = [{ name: 'origin' }, { name: 'origin/fork' }] as never
  const base = 'refs/remotes/origin/main'

  it('prefers the local branch tracking the base', () => {
    const refs = [ref('refs/heads/main'), ref('refs/heads/trunk-copy', { upstream: base }), ref(base)]
    expect(checkoutTarget({ refs, remotes }, base)).toEqual({ name: 'trunk-copy' })
  })

  it('then the local branch named like the base', () => {
    expect(checkoutTarget({ refs: [ref('refs/heads/main'), ref(base)], remotes }, base)).toEqual({ name: 'main' })
  })

  it('then a new branch tracking the base', () => {
    expect(checkoutTarget({ refs: [ref(base)], remotes }, base)).toEqual({ name: 'main', remoteRef: base })
    const fork = 'refs/remotes/origin/fork/dev'
    expect(checkoutTarget({ refs: [], remotes }, fork)).toEqual({ name: 'dev', remoteRef: fork })
  })
})

describe('squashBatches', () => {
  it('checks upstream-deleted branches first, at most 8 at a time, and skips merged ones', () => {
    const branches = [
      ...Array.from({ length: 5 }, (_, i) => branch(`u${i}`, 'unknown')),
      branch('m', 'merged'),
      ...Array.from({ length: 6 }, (_, i) => branch(`g${i}`, 'gone'))
    ]
    expect(squashBatches(branches)).toEqual([
      ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'u0', 'u1'],
      ['u2', 'u3', 'u4']
    ])
    expect(squashBatches([branch('m', 'merged')])).toEqual([])
  })
})

describe('squash check cache', () => {
  it('keeps results by repo, base commit and branch commit', () => {
    const branches = [branch('a', 'gone'), branch('b', 'unknown')]
    rememberChecks('/repo', 'base1', branches, [check('a', true)])
    expect(cachedChecks('/repo', 'base1', branches)).toEqual({ a: check('a', true) })
    expect(cachedChecks('/repo', 'base2', branches)).toEqual({})
    expect(cachedChecks('/other', 'base1', branches)).toEqual({})
    // a renamed branch at the same commit keeps its answer under the new name
    expect(cachedChecks('/repo', 'base1', [branch('renamed', 'gone', { sha: 'a-sha' })])).toEqual({ renamed: check('renamed', true) })
    expect(cachedChecks('/repo', undefined, branches)).toEqual({})
  })
})

describe('groupRows', () => {
  it('groups by reason in a fixed order, newest commit first, and leaves out empty groups', () => {
    const rows = cleanupRows(
      [
        branch('old-gone', 'gone', { date: 1 }),
        branch('old-merged', 'merged', { date: 1 }),
        branch('checking', 'gone', { date: 3 }),
        branch('new-merged', 'merged', { date: 5 }),
        branch('undated', 'merged')
      ],
      {},
      { ...opts, checking: true }
    )
    expect(groupRows(rows).map((g) => [g.title, g.rows.map((r) => r.branch.name)])).toEqual([
      ['Merged', ['new-merged', 'old-merged', 'undated']],
      ['Upstream deleted', ['checking', 'old-gone']]
    ])
  })
})

describe('group and range selection', () => {
  const rows = cleanupRows(
    [branch('a', 'merged'), branch('b', 'merged', { worktree: '/wt' }), branch('c', 'gone'), branch('d', 'merged'), branch('e', 'gone')],
    { c: check('c', false), e: check('e', false) },
    opts
  )

  it('reads a group as all, none or some of its unlocked rows', () => {
    const merged = rows.filter((r) => r.status === 'merged')
    expect(groupSelection(merged, {})).toBe('all')
    expect(groupSelection(merged, { a: false })).toBe('some')
    expect(groupSelection(merged, { a: false, d: false })).toBe('none')
    expect(groupSelection(rows.filter((r) => r.status === 'gone'), {})).toBe('none')
  })

  it('sets every unlocked row between the anchor and the clicked row, in either direction', () => {
    expect(rangeChoices(rows, 'a', 'd', false)).toEqual({ a: false, c: false, d: false })
    expect(rangeChoices(rows, 'e', 'c', true)).toEqual({ c: true, d: true, e: true })
    expect(rangeChoices(rows, 'gone-by-now', 'c', true)).toEqual({})
  })
})

describe('cleanup hint', () => {
  it('counts merged and upstream-deleted branches not checked out anywhere', () => {
    const names = hintNames([branch('m', 'merged'), branch('g', 'gone'), branch('u', 'unknown'), branch('wt', 'merged', { worktree: '/wt' })])
    expect(names).toEqual(['m', 'g'])
  })

  it('leaves out branches the dialog already showed', () => {
    expect(hintCount(['m', 'g'], undefined)).toBe(2)
    expect(hintCount(['m', 'g'], ['m', 'g', 'x'])).toBe(0)
    expect(hintCount(['m', 'g', 'new'], ['m', 'g'])).toBe(1)
    expect(hintCount(undefined, ['m'])).toBe(0)
  })
})

describe('base branches', () => {
  const ref = (fullName: string, extra: Partial<Ref> = {}): Ref => ({
    fullName,
    name: fullName.replace(/^refs\/(heads|remotes)\//, ''),
    type: fullName.startsWith('refs/heads/') ? 'local' : 'remote',
    sha: 'x',
    ...extra
  })
  const origin = [{ name: 'origin' }] as never

  it('lists remote branches, the default first, then local ones', () => {
    const refs = [ref('refs/heads/zeta'), ref('refs/remotes/origin/b'), ref('refs/heads/main'), ref('refs/remotes/origin/main', { isDefault: true, remote: 'origin' }), ref('refs/tags/v1', { type: 'tag' })]
    expect(baseCandidates({ refs }).map((r) => r.fullName)).toEqual(['refs/remotes/origin/main', 'refs/remotes/origin/b', 'refs/heads/main', 'refs/heads/zeta'])
  })

  it("prefers the remote's default branch, and falls back to the local default branch", () => {
    const withRemote = baseCandidates({ refs: [ref('refs/heads/main'), ref('refs/remotes/origin/main', { remote: 'origin' })] })
    expect(defaultBase({ remotes: origin }, withRemote)).toBe('refs/remotes/origin/main')
    const localOnly = baseCandidates({ refs: [ref('refs/heads/trunk'), ref('refs/heads/develop'), ref('refs/heads/stable')] })
    expect(defaultBase({ remotes: [] }, localOnly)).toBe('refs/heads/develop')
    expect(defaultBase({ remotes: [] }, localOnly, 'stable')).toBe('refs/heads/stable')
    expect(defaultBase({ remotes: [] }, baseCandidates({ refs: [ref('refs/heads/feature')] }))).toBeNull()
  })

  it('filters by name and keeps the chosen base', () => {
    const refs = baseCandidates({ refs: [ref('refs/heads/main'), ref('refs/heads/release/2'), ref('refs/remotes/origin/main')] })
    expect(filterCandidates(refs, 'rel', 'refs/heads/main').map((r) => r.fullName)).toEqual(['refs/heads/main', 'refs/heads/release/2'])
    expect(filterCandidates(refs, '  ', null)).toHaveLength(3)
  })
})
