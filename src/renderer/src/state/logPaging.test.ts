import { describe, expect, it } from 'vitest'
import { LOAD_AHEAD_ROWS, logLimit, nextPageLimit, reachedEnd, revealLimits, shouldLoadMore, type LoadMoreState } from './logPaging'

describe('log limits', () => {
  it('loads the first page until the user asks for more', () => {
    expect(logLimit(2000, undefined)).toBe(2000)
    expect(nextPageLimit(2000, undefined)).toBe(4000)
  })

  it('keeps what was loaded on a refresh instead of shrinking back to the first page', () => {
    expect(logLimit(2000, 6000)).toBe(6000)
    expect(nextPageLimit(2000, 6000)).toBe(8000)
  })

  it('follows a first page raised in Preferences above what was scrolled to', () => {
    expect(logLimit(10_000, 4000)).toBe(10_000)
  })
})

describe('reachedEnd', () => {
  it('is the end of history when git returns fewer commits than asked', () => {
    expect(reachedEnd(1234, 2000)).toBe(true)
    expect(reachedEnd(0, 2000)).toBe(true)
  })

  it('is not the end when exactly the limit came back (the next load tells)', () => {
    expect(reachedEnd(2000, 2000)).toBe(false)
  })
})

describe('revealLimits', () => {
  it('doubles up to the cap', () => {
    expect(revealLimits(2000, 2000, 20_000)).toEqual([4000, 8000, 16_000, 20_000])
  })

  it('grows by at least a page from a small start', () => {
    expect(revealLimits(100, 500, 1500)).toEqual([600, 1200, 1500])
  })

  it('has nothing to try at the cap', () => {
    expect(revealLimits(20_000, 2000, 20_000)).toEqual([])
  })
})

describe('shouldLoadMore', () => {
  const base: LoadMoreState = { lastVisible: 1900, rowCount: 2000, complete: false, loading: false, rowsAtLastLoad: null }

  it('loads when the view is within the look-ahead of the end', () => {
    expect(shouldLoadMore(base)).toBe(true)
    expect(shouldLoadMore({ ...base, lastVisible: 2000 - LOAD_AHEAD_ROWS - 1 })).toBe(false)
  })

  it('waits for a load in flight and stops at the beginning of history', () => {
    expect(shouldLoadMore({ ...base, loading: true })).toBe(false)
    expect(shouldLoadMore({ ...base, complete: true })).toBe(false)
    expect(shouldLoadMore({ ...base, rowCount: 0, lastVisible: 0 })).toBe(false)
  })

  it('does not keep loading when the last page added no visible row', () => {
    expect(shouldLoadMore({ ...base, rowsAtLastLoad: 2000 })).toBe(false)
    expect(shouldLoadMore({ ...base, rowCount: 2400, lastVisible: 2400, rowsAtLastLoad: 2000 })).toBe(true)
  })
})
