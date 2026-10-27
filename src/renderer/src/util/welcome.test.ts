import { describe, expect, it } from 'vitest'
import type { DiscoveredRepo, RecentRepo } from '@shared/types'
import { DISCOVERED_SHOWN, matchesRepo, welcomeLists } from './welcome'

const recent = (name: string, lastOpened: number, favorite = false): RecentRepo => ({ path: `/code/${name}`, name, lastOpened, favorite })
const found = (name: string, dir = '/code'): DiscoveredRepo => ({ path: `${dir}/${name}`, name, modified: 0 })

describe('welcomeLists', () => {
  const recents = [recent('api', 1), recent('web', 3), recent('docs', 2, true)]

  it('splits favorites from recent, newest first, and leaves known repositories out of the discovered ones', () => {
    const lists = welcomeLists(recents, [found('api'), found('tools'), found('infra')], '')
    expect(lists.favorites.map((r) => r.name)).toEqual(['docs'])
    expect(lists.recent.map((r) => r.name)).toEqual(['web', 'api'])
    expect(lists.discovered.map((r) => r.name)).toEqual(['tools', 'infra'])
    expect(lists.hidden).toBe(0)
  })

  it('filters every list, best match first', () => {
    const lists = welcomeLists([...recents, recent('my-api-client', 9)], [found('apix'), found('zz', '/work/api-stuff')], 'api')
    expect(lists.recent.map((r) => r.name)).toEqual(['api', 'my-api-client'])
    expect(lists.favorites).toEqual([])
    // a name match ranks above a match in the folder path
    expect(lists.discovered.map((r) => r.name)).toEqual(['apix', 'zz'])
  })

  it('caps the discovered repositories unless filtering or showing all', () => {
    const many = Array.from({ length: DISCOVERED_SHOWN + 3 }, (_, i) => found(`r${i}`))
    expect(welcomeLists([], many, '')).toMatchObject({ hidden: 3 })
    expect(welcomeLists([], many, '').discovered).toHaveLength(DISCOVERED_SHOWN)
    expect(welcomeLists([], many, '', true).discovered).toHaveLength(DISCOVERED_SHOWN + 3)
    expect(welcomeLists([], many, 'r1').hidden).toBe(0)
  })
})

describe('matchesRepo', () => {
  it('matches the name or the path', () => {
    expect(matchesRepo('gc', { name: 'git-client', path: '/x/git-client' })).toBe(true)
    expect(matchesRepo('personal', { name: 'git-client', path: '/Users/me/Personal/git-client' })).toBe(true)
    expect(matchesRepo('zzz', { name: 'git-client', path: '/x' })).toBe(false)
    expect(matchesRepo('  ', { name: 'a', path: '/a' })).toBe(true)
  })
})
