import { describe, expect, it } from 'vitest'
import { lcsMatches, merge3, renderMerge, splitLines } from './merge3'

const L = (s: string) => (s === '' ? [] : s.split(' '))

describe('lcsMatches', () => {
  it('matches identical sequences', () => {
    expect(Array.from(lcsMatches(L('a b c'), L('a b c')))).toEqual([0, 1, 2])
  })
  it('finds an LCS with insertions and deletions', () => {
    expect(Array.from(lcsMatches(L('a b c d'), L('a x c d e')))).toEqual([0, -1, 2, 3])
  })
  it('handles empty inputs', () => {
    expect(Array.from(lcsMatches([], L('a')))).toEqual([])
    expect(Array.from(lcsMatches(L('a'), []))).toEqual([-1])
  })
})

describe('merge3', () => {
  it('returns one stable chunk when nothing changed', () => {
    expect(merge3(L('a b c'), L('a b c'), L('a b c'))).toEqual([{ kind: 'stable', lines: L('a b c') }])
  })

  it('takes a change made only on our side', () => {
    const r = merge3(L('a b c'), L('a B c'), L('a b c'))
    expect(r.map((c) => c.kind)).toEqual(['stable', 'resolved', 'stable'])
    expect(r[1]).toMatchObject({ side: 'ours', lines: ['B'] })
    expect(renderMerge(r, [])).toEqual(L('a B c'))
  })

  it('takes a change made only on their side', () => {
    const r = merge3(L('a b c'), L('a b c'), L('a b C d'))
    expect(renderMerge(r, [])).toEqual(L('a b C d'))
    expect(r.some((c) => c.kind === 'conflict')).toBe(false)
  })

  it('merges non-overlapping changes from both sides', () => {
    const r = merge3(L('a b c d e'), L('A b c d e'), L('a b c d E'))
    expect(renderMerge(r, [])).toEqual(L('A b c d E'))
  })

  it('treats identical changes on both sides as resolved', () => {
    const r = merge3(L('a b c'), L('a X c'), L('a X c'))
    expect(r[1]).toMatchObject({ kind: 'resolved', side: 'both', lines: ['X'] })
  })

  it('reports overlapping different changes as a conflict', () => {
    const r = merge3(L('a b c'), L('a O c'), L('a T c'))
    expect(r).toEqual([
      { kind: 'stable', lines: ['a'] },
      { kind: 'conflict', base: ['b'], ours: ['O'], theirs: ['T'] },
      { kind: 'stable', lines: ['c'] }
    ])
    expect(renderMerge(r, [{ ours: true, theirs: false }])).toEqual(L('a O c'))
    expect(renderMerge(r, [{ ours: false, theirs: true }])).toEqual(L('a T c'))
    expect(renderMerge(r, [{ ours: true, theirs: true }])).toEqual(L('a O T c'))
    expect(renderMerge(r, [{ ours: false, theirs: false }])).toEqual(L('a c'))
  })

  it('handles a missing base (add/add conflict)', () => {
    const r = merge3([], L('x y'), L('x z'))
    expect(r.filter((c) => c.kind === 'conflict')).toHaveLength(1)
  })

  it('handles deletion vs. modification as a conflict', () => {
    const r = merge3(L('a b c'), L('a c'), L('a B c'))
    expect(r[1]).toEqual({ kind: 'conflict', base: ['b'], ours: [], theirs: ['B'] })
  })

  it('handles insertions at the ends', () => {
    expect(renderMerge(merge3(L('a b'), L('z a b'), L('a b y')), [])).toEqual(L('z a b y'))
  })

  it('counts multiple conflicts in order', () => {
    const r = merge3(L('a b c d e'), L('a 1 c 3 e'), L('a 2 c 4 e'))
    expect(r.filter((c) => c.kind === 'conflict')).toHaveLength(2)
    expect(renderMerge(r, [{ ours: true, theirs: false }, { ours: false, theirs: true }])).toEqual(L('a 1 c 4 e'))
  })
})

describe('splitLines', () => {
  it('drops a single trailing newline and handles null', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
    expect(splitLines(null)).toEqual([])
  })
})
