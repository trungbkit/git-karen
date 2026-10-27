import { describe, expect, it } from 'vitest'
import type { DiffHunk, FileDiff } from '@shared/types'
import { buildSplitPrompt, groupStaging, parseSplitPlan, splitChangesText, splitUnits } from './split'

function hunk(header: string, body: string): DiffHunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)!
  return {
    header,
    oldStart: +m[1],
    oldLines: m[2] === undefined ? 1 : +m[2],
    newStart: +m[3],
    newLines: m[4] === undefined ? 1 : +m[4],
    lines: body.split('\n').map((l) => ({ type: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'context', content: l.slice(1) }))
  }
}

const header = (path: string) => [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`]

const diffs: FileDiff[] = [
  { path: 'src/a.ts', binary: false, headerLines: header('src/a.ts'), hunks: [hunk('@@ -1,2 +1,2 @@', '-a\n+A\n b'), hunk('@@ -10,2 +10,3 @@', ' x\n+y\n z')] },
  { path: 'src/new.ts', binary: false, isNew: true, headerLines: header('src/new.ts'), hunks: [hunk('@@ -0,0 +1 @@', '+n')] },
  { path: 'docs/b.md', oldPath: 'docs/old.md', binary: false, headerLines: header('docs/b.md'), hunks: [] },
  { path: 'img.png', binary: true, headerLines: header('img.png'), hunks: [] }
]
const units = splitUnits(diffs, ['notes.txt'])
const ids = units.map((u) => u.id)

describe('splitUnits', () => {
  it('splits modified files with several hunks and keeps other files whole', () => {
    expect(ids).toEqual(['F1.1', 'F1.2', 'F2', 'F3', 'F4', 'F5'])
    expect(units[0]).toMatchObject({ path: 'src/a.ts', hunk: 0, additions: 1, deletions: 1 })
    expect(units[1]).toMatchObject({ hunk: 1, additions: 1, deletions: 0 })
    expect(units[2].hunk).toBeUndefined()
    expect(units[2]).toMatchObject({ path: 'src/new.ts', text: '(new file)\n@@ -0,0 +1 @@\n+n' })
    expect(units[3]).toMatchObject({ path: 'docs/b.md', oldPath: 'docs/old.md', text: '(renamed from docs/old.md)' })
    expect(units[4].text).toBe('(binary file)\n(binary)')
    expect(units[5]).toMatchObject({ path: 'notes.txt', untracked: true })
  })

  it('lists every unit under its file for the AI', () => {
    const text = splitChangesText(units)
    expect(text).toContain('### F1 src/a.ts\n#### F1.1 (+1 −1)\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n#### F1.2')
    expect(text).toContain('### F3 docs/b.md (renamed from docs/old.md)')
    expect(buildSplitPrompt(units, 'abc123 feat: x')).toContain('"changes":["F1","F3.2"]')
  })

  it('cuts long units and leaves generated files out', () => {
    const long: FileDiff = { path: 'a.txt', binary: false, headerLines: [], hunks: [hunk('@@ -1,3 +1,3 @@', Array.from({ length: 20 }, (_, i) => `+l${i}`).join('\n'))] }
    const lock: FileDiff = { path: 'package-lock.json', binary: false, headerLines: [], hunks: [hunk('@@ -1 +1 @@', '-a\n+b')] }
    const text = splitChangesText(splitUnits([long, lock], []), { maxLinesPerUnit: 5 })
    expect(text).toContain('… (17 more lines)')
    expect(text).toContain('(modified)\n(generated file, contents left out)')
  })
})

describe('parseSplitPlan', () => {
  it('reads groups from a fenced reply with a preamble', () => {
    const raw = 'Here you go:\n```json\n{"commits":[{"message":"Feat(api): add y.","changes":["F1.2","F2"]},{"message":"docs: rename","changes":["F3","F1.1","F4","F5"]}]}\n```'
    expect(parseSplitPlan(raw, ids)).toEqual({
      groups: [
        { message: 'feat(api): add y', units: ['F1.2', 'F2'] },
        { message: 'docs: rename', units: ['F1.1', 'F3', 'F4', 'F5'] }
      ],
      unassigned: [],
      problems: []
    })
  })

  it('accepts a bare list and expands a file id to its free hunks', () => {
    const r = parseSplitPlan('[{"message":"fix: a","changes":["F1.1"]},{"message":"feat: b","changes":["f1"]}]', ids)
    expect(r.groups.map((g) => g.units)).toEqual([['F1.1'], ['F1.2']])
    expect(r.unassigned).toEqual(['F2', 'F3', 'F4', 'F5'])
  })

  it('reports unknown and repeated ids, empty groups and missing messages', () => {
    const r = parseSplitPlan(
      '{"commits":[{"message":"fix: a","changes":["F2","F9"]},{"message":"","changes":["F2","F3"]},{"message":"chore: c","changes":[]},"x"]}',
      ids
    )
    expect(r.groups).toEqual([
      { message: 'fix: a', units: ['F2'] },
      { message: '', units: ['F3'] }
    ])
    expect(r.problems).toEqual([
      'Commit 1 refers to an unknown change F9.',
      'F2 is in more than one commit; kept in the first.',
      'Commit 2 came without a usable message.',
      'Commit 3 has no changes; left out.',
      'Commit 4 is not an object; ignored.'
    ])
  })

  it('throws when there is no commit list', () => {
    expect(() => parseSplitPlan('I cannot do that', ids)).toThrow('contains no JSON')
    expect(() => parseSplitPlan('{"groups": 1}', ids)).toThrow('no "commits" list')
    expect(() => parseSplitPlan('{"commits": [1,}', ids)).toThrow('not valid JSON')
  })
})

describe('groupStaging', () => {
  it('stages whole files by path and partial files by patch', () => {
    expect(groupStaging(units, diffs, ['F1.2', 'F3', 'F5'])).toEqual({
      paths: ['docs/b.md', 'docs/old.md', 'notes.txt'],
      patches: [[...header('src/a.ts'), '@@ -10,2 +10,3 @@', ' x', '+y', ' z', ''].join('\n')]
    })
  })

  it('adds a file by path when the group has all of its hunks', () => {
    expect(groupStaging(units, diffs, ['F1.1', 'F1.2'])).toEqual({ paths: ['src/a.ts'], patches: [] })
  })
})
