import { describe, expect, it } from 'vitest'
import { count, patchImpact } from './impact'

describe('patchImpact', () => {
  it('counts changed lines inside hunks only', () => {
    const patch = ['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' keep', '-old', '---dashes', '+new', '\\ No newline at end of file', ''].join('\n')
    expect(patchImpact(patch)).toEqual([{ text: '+1 −2 lines will be discarded', tone: 'danger' }])
  })
})

describe('count', () => {
  it('pluralises', () => {
    expect(count(1, 'commit')).toBe('1 commit')
    expect(count(2, 'commit')).toBe('2 commits')
    expect(count(0, 'binary file')).toBe('0 binary files')
  })
})
