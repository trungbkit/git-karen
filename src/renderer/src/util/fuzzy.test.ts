import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyMatch } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches subsequences and rejects non-matches', () => {
    expect(fuzzyMatch('ftch', 'Fetch all remotes')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'Fetch all remotes')).toBeNull()
  })

  it('returns matched indices', () => {
    expect(fuzzyMatch('pu', 'Push')!.indices).toEqual([0, 1])
    expect(fuzzyMatch('cb', 'Create branch')!.indices).toEqual([0, 7])
  })

  it('ranks substring and word-boundary matches higher', () => {
    const items = ['Checkout feature/abc', 'Create branch', 'Toggle left panel']
    const ranked = fuzzyFilter(items, 'cb', (s) => s).map((r) => r.item)
    expect(ranked[0]).toBe('Create branch')
    expect(fuzzyFilter(['Pull (rebase)', 'Push'], 'push', (s) => s)[0].item).toBe('Push')
  })

  it('keeps original order for an empty query', () => {
    expect(fuzzyFilter(['b', 'a'], '', (s) => s).map((r) => r.item)).toEqual(['b', 'a'])
  })
})
