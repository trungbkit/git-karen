import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGraphNav, revealScrollTop, scrollToSha } from './nav'

const v = { scrollTop: 0, height: 226, headerHeight: 26, rowHeight: 20 }

describe('revealScrollTop', () => {
  it('leaves the scroll position alone when the row is fully visible', () => {
    expect(revealScrollTop(0, v)).toBe(0)
    expect(revealScrollTop(9, v)).toBe(0)
    expect(revealScrollTop(12, { ...v, scrollTop: 100 })).toBe(100)
  })

  it('centres rows above or below the view', () => {
    // 200px of rows visible: row 50 starts at 1000 and is centred at 1000 - 90
    expect(revealScrollTop(50, v)).toBe(910)
    expect(revealScrollTop(10, v)).toBe(110)
    expect(revealScrollTop(2, { ...v, scrollTop: 500 })).toBe(0)
  })
})

describe('scrollToSha', () => {
  let unregister: (() => void) | null = null
  afterEach(() => {
    unregister?.()
    unregister = null
    vi.useRealTimers()
  })

  const nav = (known: string[]) => ({ move: vi.fn(), focusFilter: vi.fn(), reveal: vi.fn((sha: string) => known.includes(sha)) })

  it('reveals through the mounted graph and reports commits it does not have', () => {
    const g = nav(['abc'])
    unregister = registerGraphNav(g)
    expect(scrollToSha('abc')).toBe(true)
    expect(scrollToSha('zzz')).toBe(false)
    expect(g.reveal).toHaveBeenCalledTimes(2)
  })

  it('waits for the next graph when none is mounted', () => {
    expect(scrollToSha('abc')).toBe(true)
    const g = nav(['abc'])
    unregister = registerGraphNav(g)
    expect(g.reveal).toHaveBeenCalledWith('abc')
    // consumed once
    unregister()
    const again = nav(['abc'])
    unregister = registerGraphNav(again)
    expect(again.reveal).not.toHaveBeenCalled()
  })

  it('drops a pending reveal that is too old', () => {
    vi.useFakeTimers()
    scrollToSha('abc')
    vi.advanceTimersByTime(5000)
    const g = nav(['abc'])
    unregister = registerGraphNav(g)
    expect(g.reveal).not.toHaveBeenCalled()
  })
})
