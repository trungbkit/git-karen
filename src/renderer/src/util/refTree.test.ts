import { describe, expect, it } from 'vitest'
import type { Ref } from '@shared/types'
import { buildRefTree, filterRefItems, folderKeys, type RefTreeNode } from './refTree'

const ref = (name: string, date?: number): Ref => ({ fullName: `refs/heads/${name}`, name, type: 'local', sha: 'a'.repeat(40), date })
const items = (...names: (string | [string, number])[]) =>
  names.map((n) => (typeof n === 'string' ? { path: n, ref: ref(n) } : { path: n[0], ref: ref(n[0], n[1]) }))

/** Tree as nested labels: folders become `name/` with their children. */
const shape = (nodes: RefTreeNode[]): unknown[] => nodes.map((n) => (n.ref ? n.label : { [`${n.label}/`]: shape(n.children) }))

describe('buildRefTree', () => {
  it('groups branches by prefix, folders first, by name', () => {
    const tree = buildRefTree(items('main', 'feature/b', 'fix/x', 'feature/a', 'develop', 'feature/ui/menu'), 'local')
    expect(shape(tree)).toEqual([{ 'feature/': [{ 'ui/': ['menu'] }, 'a', 'b'] }, { 'fix/': ['x'] }, 'develop', 'main'])
    expect(tree[0].key).toBe('local/feature/')
    expect(tree[0].count).toBe(3)
    expect(tree[0].children[1].key).toBe('local/feature/a')
  })

  it('sorts by most recent commit, folders by their newest branch', () => {
    const tree = buildRefTree(items(['main', 50], ['feature/old', 10], ['feature/new', 90], ['zeta', 70]), 'local', 'date')
    expect(shape(tree)).toEqual([{ 'feature/': ['new', 'old'] }, 'zeta', 'main'])
    expect(tree[0].date).toBe(90)
  })

  it('keeps a branch and a folder of the same name apart', () => {
    const tree = buildRefTree(items('release', 'release/1.0'), 'local')
    expect(shape(tree)).toEqual([{ 'release/': ['1.0'] }, 'release'])
    expect(folderKeys(tree)).toEqual(['local/release/'])
  })
})

describe('filterRefItems', () => {
  it('fuzzy matches the full path and maps the match onto the branch label', () => {
    const filtered = filterRefItems(items('feature/login-form', 'fix/logout', 'main'), 'flog')
    expect(filtered.map((i) => i.path)).toEqual(['feature/login-form', 'fix/logout'])
    const tree = buildRefTree(filtered, 'local')
    const login = tree.find((n) => n.label === 'feature')!.children[0]
    // "f" falls on the folder name, "log" on the branch
    expect(login.match).toEqual([0, 1, 2])
  })

  it('returns everything for an empty query', () => {
    const all = items('a', 'b')
    expect(filterRefItems(all, '  ')).toBe(all)
  })

  it('filters and groups 2000 branches quickly', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `${['feature', 'fix', 'release', 'chore'][i % 4]}/team-${i % 37}/ticket-${i}`)
    const all = items(...many)
    const start = performance.now()
    const tree = buildRefTree(filterRefItems(all, 'fix tick 12'), 'local', 'name')
    expect(performance.now() - start).toBeLessThan(50)
    expect(tree.length).toBeGreaterThan(0)
  })
})
