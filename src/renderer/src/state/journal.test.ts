import { describe, expect, it } from 'vitest'
import { Journal, UNDO_WINDOW_MS } from './journal'

const noop = async () => undefined

describe('Journal', () => {
  it('takes an entry once', () => {
    const j = new Journal()
    const e = j.push({ repo: '/a', label: 'Reset', undo: noop }, 0)
    expect(e.expires).toBe(UNDO_WINDOW_MS)
    expect(j.get(e.id, 1)).toBe(e)
    expect(j.take(e.id, 1)).toBe(e)
    expect(j.take(e.id, 2)).toBeNull()
    expect(j.size).toBe(0)
  })

  it('expires entries after the window', () => {
    const j = new Journal()
    const e = j.push({ repo: '/a', label: 'Reset', undo: noop }, 0, 100)
    expect(j.latest('/a', 99)).toBe(e)
    expect(j.latest('/a', 100)).toBeNull()
    expect(j.take(e.id, 100)).toBeNull()
  })

  it('supersedes older entries of the same repo only', () => {
    const j = new Journal()
    const a1 = j.push({ repo: '/a', label: 'first', undo: noop }, 0)
    const b = j.push({ repo: '/b', label: 'other repo', undo: noop }, 1)
    const a2 = j.push({ repo: '/a', label: 'second', undo: noop }, 2)
    expect(j.get(a1.id, 3)).toBeNull()
    expect(j.latest('/a', 3)).toBe(a2)
    expect(j.latest('/b', 3)).toBe(b)
    expect(j.latest('/c', 3)).toBeNull()
  })

  it('prunes expired entries as new ones arrive', () => {
    const j = new Journal()
    j.push({ repo: '/a', label: 'old', undo: noop }, 0, 10)
    j.push({ repo: '/b', label: 'new', undo: noop }, 20, 10)
    expect(j.size).toBe(1)
  })

  it('clears a repo', () => {
    const j = new Journal()
    j.push({ repo: '/a', label: 'x', undo: noop }, 0)
    j.push({ repo: '/b', label: 'y', undo: noop }, 0)
    j.clear('/a')
    expect(j.latest('/a', 1)).toBeNull()
    expect(j.size).toBe(1)
  })
})
