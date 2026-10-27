// Unchanged lines between the hunks of a diff, which the diff view can reveal ("expand context") from the file's
// content at the diff's new side. Revealing is display only: the hunks themselves never change, so line
// selection, hunk focus and the patches built from them for staging stay exactly as they were.
import type { DiffHunk } from '@shared/types'

/** Lines revealed by one click on "expand up/down" */
export const EXPAND_STEP = 10

/** Unchanged lines before hunk `before` (or after the last hunk when `before` is the hunk count). */
export interface Gap {
  before: number
  /** First and last line of the gap on the new side, 1-based and inclusive (empty when last < first) */
  first: number
  last: number
  /** Old-side line number = new-side line number + oldOffset */
  oldOffset: number
}

/** Inclusive range of new-side line numbers */
export type LineRange = [number, number]

export type GapPart = { kind: 'lines' | 'hidden'; first: number; last: number }

/** Last line of a hunk on one side; a hunk without lines on that side sits after line `start`. */
const lastLine = (start: number, count: number) => (count === 0 ? start : start + count - 1)
/** First line of a hunk on one side */
const firstLine = (start: number, count: number) => (count === 0 ? start + 1 : start)

/**
 * The gaps around `hunks` in a file of `fileLines` lines (new side). Includes the gap before the first hunk and,
 * when `fileLines` is known, after the last one; empty gaps are left out.
 */
export function diffGaps(hunks: DiffHunk[], fileLines: number): Gap[] {
  const gaps: Gap[] = []
  let prevNew = 0
  let prevOld = 0
  hunks.forEach((h, i) => {
    const first = prevNew + 1
    const nextNew = firstLine(h.newStart, h.newLines)
    const nextOld = firstLine(h.oldStart, h.oldLines)
    if (nextNew - 1 >= first) gaps.push({ before: i, first, last: nextNew - 1, oldOffset: nextOld - nextNew })
    prevNew = lastLine(h.newStart, h.newLines)
    prevOld = lastLine(h.oldStart, h.oldLines)
  })
  if (fileLines > prevNew) gaps.push({ before: hunks.length, first: prevNew + 1, last: fileLines, oldOffset: prevOld - prevNew })
  return gaps
}

/** Adds [first, last] to sorted, non-overlapping `ranges`, merging touching ranges. */
export function revealLines(ranges: readonly LineRange[], first: number, last: number): LineRange[] {
  if (last < first) return [...ranges]
  const out: LineRange[] = []
  let cur: LineRange = [first, last]
  let placed = false
  for (const r of ranges) {
    if (r[1] + 1 < cur[0]) out.push(r)
    else if (cur[1] + 1 < r[0]) {
      if (!placed) out.push(cur)
      placed = true
      out.push(r)
    } else cur = [Math.min(cur[0], r[0]), Math.max(cur[1], r[1])]
  }
  if (!placed) out.push(cur)
  return out
}

/** A gap split into revealed lines and hidden runs, in order. */
export function gapParts(gap: Gap, revealed: readonly LineRange[]): GapPart[] {
  const parts: GapPart[] = []
  let at = gap.first
  for (const [a, b] of revealed) {
    if (b < at || a > gap.last) continue
    const from = Math.max(a, at)
    if (from > at) parts.push({ kind: 'hidden', first: at, last: from - 1 })
    const to = Math.min(b, gap.last)
    parts.push({ kind: 'lines', first: from, last: to })
    at = to + 1
  }
  if (at <= gap.last) parts.push({ kind: 'hidden', first: at, last: gap.last })
  return parts
}

/**
 * Whether `lines` (the new side's content) is the file the hunks were made from: every added and context line is
 * where the hunk says. A stale diff or file must not reveal the wrong lines. Lines compare without whitespace when
 * the diff ignores it (git prints context lines from the old side then).
 */
export function contextMatches(hunks: DiffHunk[], lines: readonly string[], ignoreWhitespace = false): boolean {
  // a working copy with CRLF endings diffs (after git's conversion) with LF ones
  const squash = (s: string) => (ignoreWhitespace ? s.replace(/\s+/g, '') : s.replace(/\r$/, ''))
  for (const h of hunks) {
    let n = h.newStart
    for (const l of h.lines) {
      if (l.type === 'del' || l.type === 'meta') continue
      const at = l.newLine ?? n
      n = at + 1
      const text = lines[at - 1]
      if (text === undefined) return false
      if (squash(text) !== squash(l.content)) return false
    }
  }
  return true
}

/** File content as lines, the way a diff shows them (no trailing empty line for the final newline). */
export function splitFileLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
