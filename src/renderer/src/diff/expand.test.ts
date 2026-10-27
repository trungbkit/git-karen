import { describe, expect, it } from 'vitest'
import type { DiffHunk, DiffLine, FileDiff } from '@shared/types'
import { contextMatches, diffGaps, gapParts, revealLines, splitFileLines, type Gap } from './expand'
import { buildPatch } from './patch'

function lines(body: string): DiffLine[] {
  return body.split('\n').map((l) => {
    const c = l[0]
    if (c === '+') return { type: 'add', content: l.slice(1) }
    if (c === '-') return { type: 'del', content: l.slice(1) }
    return { type: 'context', content: l.slice(1) }
  })
}

function hunk(header: string, body: string): DiffHunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)!
  return { header, oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: lines(body) }
}

const fileDiff = (hunks: DiffHunk[]): FileDiff => ({
  path: 'f.txt',
  binary: false,
  hunks,
  headerLines: ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt']
})

// old: l1..l30. new: "n1" inserted after l3, l10 changed to "X", l20 removed.
const OLD = Array.from({ length: 30 }, (_, i) => `l${i + 1}`)
const NEW = [...OLD.slice(0, 3), 'n1', ...OLD.slice(3, 9), 'X', ...OLD.slice(10, 19), ...OLD.slice(20)]

/** The same change without context (hunks with zero-line sides) and with git's default 3 lines. */
const zeroContext = [hunk('@@ -3,0 +4 @@', '+n1'), hunk('@@ -10 +11 @@', '-l10\n+X'), hunk('@@ -20 +20,0 @@', '-l20')]
const threeContext = [
  hunk('@@ -1,6 +1,7 @@', ' l1\n l2\n l3\n+n1\n l4\n l5\n l6'),
  hunk('@@ -7,7 +8,7 @@', ' l7\n l8\n l9\n-l10\n+X\n l11\n l12\n l13'),
  hunk('@@ -17,7 +18,6 @@', ' l17\n l18\n l19\n-l20\n l21\n l22\n l23')
]

/** Every gap line is the same text on the new side and, through oldOffset, on the old side. */
function expectAligned(gaps: Gap[]) {
  for (const g of gaps) for (let n = g.first; n <= g.last; n++) expect([n, OLD[n + g.oldOffset - 1]]).toEqual([n, NEW[n - 1]])
}

/** Applies a unified patch to `file` like `git apply` (with `--reverse`) does, checking context and removed lines. */
function applyPatch(file: string[], patch: string, reverse = false): string[] {
  const [take, give] = reverse ? ['+', '-'] : ['-', '+']
  const out: string[] = []
  let at = 0
  const body = patch.split('\n').filter((l) => l !== '' && !l.startsWith('--- ') && !l.startsWith('+++ '))
  for (let i = 0; i < body.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(body[i])
    if (!m) continue
    const [start, count] = reverse ? [+m[3], m[4]] : [+m[1], m[2]]
    out.push(...file.slice(at, start - (count === '0' ? 0 : 1)))
    at = start - (count === '0' ? 0 : 1)
    while (i + 1 < body.length && /^[ +-]/.test(body[i + 1])) {
      const l = body[++i]
      if (l[0] === give) out.push(l.slice(1))
      else {
        if (file[at] !== l.slice(1)) throw new Error(`patch does not apply at line ${at + 1}: ${l}`)
        if (l[0] !== take) out.push(file[at])
        at++
      }
    }
  }
  return [...out, ...file.slice(at)]
}

describe('diffGaps', () => {
  it('finds the unchanged lines around zero-context hunks', () => {
    const gaps = diffGaps(zeroContext, NEW.length)
    expect(gaps.map((g) => [g.before, g.first, g.last])).toEqual([
      [0, 1, 3],
      [1, 5, 10],
      [2, 12, 20],
      [3, 21, 30]
    ])
    expectAligned(gaps)
  })

  it('finds the gaps between hunks with context', () => {
    const gaps = diffGaps(threeContext, NEW.length)
    expect(gaps.map((g) => [g.before, g.first, g.last])).toEqual([
      [2, 15, 17],
      [3, 24, 30]
    ])
    expectAligned(gaps)
  })

  it('leaves out the trailing gap until the file length is known, and empty gaps', () => {
    expect(diffGaps(threeContext, 0).map((g) => g.before)).toEqual([2])
    expect(diffGaps([hunk('@@ -0,0 +1,2 @@', '+a\n+b')], 2)).toEqual([])
    expect(diffGaps([hunk('@@ -1,2 +0,0 @@', '-a\n-b')], 0)).toEqual([])
  })
})

describe('revealLines and gapParts', () => {
  it('merges overlapping and touching ranges', () => {
    let r = revealLines([], 10, 12)
    r = revealLines(r, 1, 3)
    r = revealLines(r, 20, 25)
    expect(r).toEqual([
      [1, 3],
      [10, 12],
      [20, 25]
    ])
    expect(revealLines(r, 4, 9)).toEqual([
      [1, 12],
      [20, 25]
    ])
    expect(revealLines(r, 11, 22)).toEqual([
      [1, 3],
      [10, 25]
    ])
    expect(revealLines(r, 5, 4)).toEqual(r)
  })

  it('splits a gap into revealed and hidden parts', () => {
    const gap: Gap = { before: 1, first: 5, last: 30, oldOffset: 0 }
    expect(gapParts(gap, [])).toEqual([{ kind: 'hidden', first: 5, last: 30 }])
    expect(
      gapParts(gap, [
        [1, 7],
        [12, 14],
        [28, 40]
      ])
    ).toEqual([
      { kind: 'lines', first: 5, last: 7 },
      { kind: 'hidden', first: 8, last: 11 },
      { kind: 'lines', first: 12, last: 14 },
      { kind: 'hidden', first: 15, last: 27 },
      { kind: 'lines', first: 28, last: 30 }
    ])
    expect(gapParts(gap, [[1, 100]])).toEqual([{ kind: 'lines', first: 5, last: 30 }])
  })
})

describe('contextMatches', () => {
  it('accepts the file the hunks were made from', () => {
    expect(contextMatches(threeContext, NEW)).toBe(true)
    expect(contextMatches(zeroContext, NEW)).toBe(true)
  })

  it('rejects a file that changed since', () => {
    expect(contextMatches(threeContext, ['new first line', ...NEW])).toBe(false)
    expect(contextMatches(threeContext, NEW.slice(0, 20))).toBe(false)
  })

  it('ignores whitespace and CRLF endings where the diff does', () => {
    const spaced = NEW.map((l) => `  ${l}`)
    expect(contextMatches(threeContext, spaced)).toBe(false)
    expect(contextMatches(threeContext, spaced, true)).toBe(true)
    expect(contextMatches(threeContext, NEW.map((l) => `${l}\r`))).toBe(true)
  })
})

describe('staging after expanding context', () => {
  it('reveals without touching the hunks, so line and hunk patches still apply', () => {
    const diff = fileDiff(threeContext)
    const before = JSON.stringify(diff)
    const frozen = structuredClone(diff)
    // reveal every gap fully, as "Expand all" does
    let revealed = revealLines([], 1, 0)
    for (const g of diffGaps(frozen.hunks, NEW.length)) revealed = revealLines(revealed, g.first, g.last)
    for (const g of diffGaps(frozen.hunks, NEW.length)) gapParts(g, revealed)
    expect(JSON.stringify(frozen)).toBe(before)

    // stage only "X" of the second hunk (its "-l10" is kept), then the whole third hunk
    const lineIndex = frozen.hunks[1].lines.findIndex((l) => l.content === 'X')
    const staged = applyPatch(OLD, buildPatch(frozen, [{ hunkIndex: 1, lineIndexes: [lineIndex] }], 'stage'))
    expect(staged.slice(8, 12)).toEqual(['l9', 'l10', 'X', 'l11'])
    const all = applyPatch(OLD, buildPatch(frozen, [0, 1, 2].map((hunkIndex) => ({ hunkIndex })), 'stage'))
    expect(all).toEqual(NEW)
    // discarding (reverse) a hunk from the new side gives the old lines back there
    const reverted = applyPatch(NEW, buildPatch(frozen, [{ hunkIndex: 2 }], 'discard'), true)
    expect(reverted.slice(18, 22)).toEqual(['l18', 'l19', 'l20', 'l21'])
  })
})

describe('splitFileLines', () => {
  it('drops the empty line after the final newline only', () => {
    expect(splitFileLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitFileLines('a\nb')).toEqual(['a', 'b'])
    expect(splitFileLines('a\n\n')).toEqual(['a', ''])
    expect(splitFileLines('')).toEqual([])
  })
})
