import { describe, expect, it } from 'vitest'
import type { FileChange } from '@shared/types'
import { committedOpenFile } from './committedFile'

const f = (path: string, oldPath?: string): FileChange => ({ path, oldPath, status: 'modified' })

describe('committedOpenFile', () => {
  it('finds a staged file from the staged view', () => {
    const a = f('a.ts', 'old.ts')
    expect(committedOpenFile({ path: 'a.ts', staged: true }, [a], [], false)).toBe(a)
  })

  it('finds the staged entry of a partially staged file from the staged view', () => {
    const a = f('a.ts')
    expect(committedOpenFile({ path: 'a.ts', staged: true }, [a], [f('a.ts')], false)).toBe(a)
  })

  it('finds a fully staged file from the unstaged view', () => {
    const a = f('a.ts')
    expect(committedOpenFile({ path: 'a.ts', staged: false }, [a], [], false)).toBe(a)
  })

  it('keeps the unstaged view of a partially staged file', () => {
    expect(committedOpenFile({ path: 'a.ts', staged: false }, [f('a.ts')], [f('a.ts')], false)).toBeUndefined()
  })

  it('finds the file from the unstaged view when the commit stages everything', () => {
    const a = f('a.ts')
    expect(committedOpenFile({ path: 'a.ts', staged: false }, [], [a], true)).toBe(a)
  })

  it('ignores a file outside the commit', () => {
    expect(committedOpenFile({ path: 'c.ts', staged: false }, [f('a.ts')], [f('c.ts')], false)).toBeUndefined()
    expect(committedOpenFile({ path: 'c.ts', staged: true }, [f('a.ts')], [], false)).toBeUndefined()
  })

  it('ignores an unstaged file when nothing is staged and nothing is stage-all', () => {
    expect(committedOpenFile({ path: 'c.ts', staged: false }, [], [f('c.ts')], false)).toBeUndefined()
  })

  it('returns nothing without an open working diff', () => {
    expect(committedOpenFile(null, [f('a.ts')], [], false)).toBeUndefined()
  })
})
