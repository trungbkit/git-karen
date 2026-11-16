import { describe, expect, it } from 'vitest'
import { busyKind, formatElapsed } from './busyKind'

describe('busyKind', () => {
  it('classifies the labels store.run is called with', () => {
    expect(busyKind('Pushing')).toBe('push')
    expect(busyKind('Force pushing')).toBe('push')
    expect(busyKind('Pushing tag')).toBe('push')
    expect(busyKind('Pulling (rebase)')).toBe('pull')
    expect(busyKind('Stashing and pulling')).toBe('pull')
    expect(busyKind('Fetching origin')).toBe('fetch')
    expect(busyKind('Checking out feature/x')).toBe('checkout')
    expect(busyKind('Merging main')).toBe('merge')
    expect(busyKind('Rebasing')).toBe('rebase')
    expect(busyKind('Cherry picking 2 commits')).toBe('cherry-pick')
    expect(busyKind('Popping stash')).toBe('stash')
    expect(busyKind('Creating branch')).toBe('branch')
    expect(busyKind('Staging')).toBe('other')
  })
})

describe('formatElapsed', () => {
  it('shows seconds, then minutes', () => {
    expect(formatElapsed(4_900)).toBe('4s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
  })
})
