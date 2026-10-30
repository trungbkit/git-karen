import { describe, expect, it } from 'vitest'
import { merge3, renderMerge } from '../diff/merge3'
import { buildConflictPrompt, conflictMaxTokens, parseConflictResolutions } from './conflict'

const L = (s: string) => s.split(' ')

describe('conflict prompt', () => {
  const chunks = merge3(L('a b c d'), L('a B1 c d'), L('a B2 c d'))

  it('shows each conflict with base, both sides and context', () => {
    const prompt = buildConflictPrompt({ path: 'f.ts', chunks, operation: 'merge' })!
    expect(prompt).toContain('`f.ts`')
    expect(prompt).toContain('### Conflict 1')
    expect(prompt).toContain('Lines before:\na')
    expect(prompt).toContain('BASE (common ancestor):\nb')
    expect(prompt).toContain('OURS:\nB1')
    expect(prompt).toContain('THEIRS:\nB2')
    expect(prompt).toContain('Lines after:\nc\nd')
    expect(prompt).not.toContain('### Conflict 2')
  })

  it('explains the sides of a rebase', () => {
    expect(buildConflictPrompt({ path: 'f', chunks, operation: 'rebase' })).toContain('commit being replayed')
  })

  it('has nothing to ask without conflicts', () => {
    expect(buildConflictPrompt({ path: 'f', chunks: merge3(L('a'), L('a'), L('b')) })).toBeNull()
  })

  it('sizes the reply to the conflicts', () => {
    expect(conflictMaxTokens(chunks)).toBe(1000)
    const big = merge3(['x'], ['y'.repeat(30000)], ['z'.repeat(30000)])
    expect(conflictMaxTokens(big)).toBe(8192)
  })
})

describe('parseConflictResolutions', () => {
  it('reads resolutions and notes by id', () => {
    const raw = 'Sure.\n<resolution id="2">\n```ts\nx\n```\n</resolution>\n<note id="2">kept x</note>\n<resolution id="1">\nB1\nB2\n</resolution>\n<note id="1"> both </note>'
    expect(parseConflictResolutions(raw, 2)).toEqual({ lines: [['B1', 'B2'], ['x']], notes: ['both', 'kept x'] })
  })

  it('treats an empty block as removing the lines, and rejects leftover markers', () => {
    const raw = '<resolution id="1">\n</resolution><resolution id="2">\n<<<<<<< HEAD\na\n</resolution><resolution id="9">\nz\n</resolution>'
    expect(parseConflictResolutions(raw, 3).lines).toEqual([[], null, null])
  })

  it('renders over the chosen sides', () => {
    const chunks = merge3(L('a b c'), L('a B1 c'), L('a B2 c'))
    expect(renderMerge(chunks, [{ ours: true, theirs: false }], [['X', 'Y']])).toEqual(L('a X Y c'))
    expect(renderMerge(chunks, [{ ours: true, theirs: false }], [null])).toEqual(L('a B1 c'))
  })
})
