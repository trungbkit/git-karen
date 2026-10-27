// Build (partial) unified patches from a parsed FileDiff, for staging/unstaging/discarding
// whole hunks or individual lines via `git apply`.
//
// DiffLine.content is expected WITHOUT the leading '+', '-' or ' ' marker. 'meta' lines carry
// the "\ No newline at end of file" marker.
import type { DiffHunk, DiffLine, FileDiff } from '@shared/types'

export type PatchMode = 'stage' | 'unstage' | 'discard'

export interface HunkSelection {
  hunkIndex: number
  /** Indexes into hunk.lines. Undefined selects the whole hunk. */
  lineIndexes?: number[]
}

/** `stage` is applied forwards; `unstage` and `discard` are applied with `--reverse`. */
export function isReverse(mode: PatchMode): boolean {
  return mode !== 'stage'
}

const NO_NEWLINE = '\\ No newline at end of file'

function metaText(line: DiffLine): string {
  return line.content.startsWith('\\') ? line.content : NO_NEWLINE
}

interface BuiltHunk {
  lines: string[]
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  heading: string
  changed: boolean
}

function buildHunk(hunk: DiffHunk, selected: Set<number> | null, reverse: boolean): BuiltHunk {
  const out: string[] = []
  let oldCount = 0
  let newCount = 0
  let changed = false
  // Whether the previous diff line was emitted; a "no newline" marker follows its line's fate.
  let prevEmitted = false

  hunk.lines.forEach((line, i) => {
    const isSelected = selected === null || selected.has(i)
    switch (line.type) {
      case 'context':
        out.push(' ' + line.content)
        oldCount++
        newCount++
        prevEmitted = true
        break
      case 'del':
        if (isSelected) {
          out.push('-' + line.content)
          oldCount++
          changed = true
          prevEmitted = true
        } else if (!reverse) {
          // The removal stays unapplied: the line remains on both sides.
          out.push(' ' + line.content)
          oldCount++
          newCount++
          prevEmitted = true
        } else {
          // Reverse: the line does not exist in the target we revert, drop it.
          prevEmitted = false
        }
        break
      case 'add':
        if (isSelected) {
          out.push('+' + line.content)
          newCount++
          changed = true
          prevEmitted = true
        } else if (reverse) {
          // Reverse: the added line exists in the target and must be kept.
          out.push(' ' + line.content)
          oldCount++
          newCount++
          prevEmitted = true
        } else {
          prevEmitted = false
        }
        break
      case 'meta':
        if (prevEmitted) out.push(metaText(line))
        break
    }
  })

  const m = /^@@ [^@]* @@(.*)$/.exec(hunk.header)
  return {
    lines: out,
    oldStart: hunk.oldStart,
    oldCount,
    newStart: hunk.newStart,
    newCount,
    heading: m ? m[1] : '',
    changed
  }
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`
}

/** Header for a patch where only some lines of a new/deleted file are touched: rewrite it as a modification. */
function rewriteHeader(diff: FileDiff, asModification: boolean): string[] {
  if (!asModification) return diff.headerLines
  const path = diff.path
  const oldPath = diff.oldPath ?? diff.path
  return diff.headerLines
    .filter((l) => !/^(new|deleted) file mode /.test(l) && !l.startsWith('index '))
    .map((l) => {
      if (l === '--- /dev/null') return `--- a/${oldPath}`
      if (l === '+++ /dev/null') return `+++ b/${path}`
      return l
    })
}

function ensureFileHeaders(header: string[], diff: FileDiff): string[] {
  // `git apply` needs ---/+++ lines when there are hunks.
  if (header.some((l) => l.startsWith('--- ')) && header.some((l) => l.startsWith('+++ '))) return header
  const oldPath = diff.oldPath ?? diff.path
  return [
    ...header,
    diff.isNew ? '--- /dev/null' : `--- a/${oldPath}`,
    diff.isDeleted ? '+++ /dev/null' : `+++ b/${diff.path}`
  ]
}

/**
 * Build a unified patch containing only the selected hunks/lines.
 * Returns '' when the selection contains no changes.
 */
export function buildPatch(diff: FileDiff, selection: HunkSelection[], mode: PatchMode): string {
  const reverse = isReverse(mode)
  const byHunk = new Map<number, Set<number> | null>()
  for (const s of selection) {
    if (s.lineIndexes === undefined) byHunk.set(s.hunkIndex, null)
    else if (byHunk.get(s.hunkIndex) !== null) {
      const set = byHunk.get(s.hunkIndex) ?? new Set<number>()
      s.lineIndexes.forEach((i) => set.add(i))
      byHunk.set(s.hunkIndex, set)
    }
  }

  const built: BuiltHunk[] = []
  let partial = false
  diff.hunks.forEach((hunk, i) => {
    if (!byHunk.has(i)) {
      if (hunk.lines.some((l) => l.type === 'add' || l.type === 'del')) partial = true
      return
    }
    const sel = byHunk.get(i) ?? null
    const b = buildHunk(hunk, sel, reverse)
    if (sel !== null) {
      const changeIdx = hunk.lines.flatMap((l, j) => (l.type === 'add' || l.type === 'del' ? [j] : []))
      if (changeIdx.some((j) => !sel.has(j))) partial = true
    }
    if (b.changed) built.push(b)
  })
  if (built.length === 0) return ''

  // Recompute starts. The side that is left untouched keeps its original positions;
  // the other side shifts by the cumulative line delta of preceding emitted hunks.
  let delta = 0
  const hunkText: string[] = []
  for (const b of built) {
    let { oldStart, newStart } = b
    if (!reverse) {
      newStart = oldStart + delta
      if (b.oldCount === 0) newStart += 1
      if (b.newCount === 0) newStart -= 1
      delta += b.newCount - b.oldCount
    } else {
      oldStart = newStart + delta
      if (b.newCount === 0) oldStart += 1
      if (b.oldCount === 0) oldStart -= 1
      delta += b.oldCount - b.newCount
    }
    hunkText.push(`@@ -${range(Math.max(0, oldStart), b.oldCount)} +${range(Math.max(0, newStart), b.newCount)} @@${b.heading}`)
    hunkText.push(...b.lines)
  }

  // A partial selection of a new file applied in reverse (or of a deleted file applied forwards)
  // no longer creates/deletes the file, so it must be expressed as a modification.
  const asModification = partial && ((reverse && !!diff.isNew) || (!reverse && !!diff.isDeleted))
  const header = ensureFileHeaders(rewriteHeader(diff, asModification), diff)
  return [...header, ...hunkText].join('\n') + '\n'
}

/** Convenience: select the given hunk entirely. */
export function hunkPatch(diff: FileDiff, hunkIndex: number, mode: PatchMode): string {
  return buildPatch(diff, [{ hunkIndex }], mode)
}

// ---------------------------------------------------------------------------------------------
// Editing a hunk before staging it (like `git add -e`)

const MARK: Record<DiffLine['type'], string> = { context: ' ', add: '+', del: '-', meta: '' }

/** What the hunk editor starts from: the hunk header, then every line with its marker. */
export function hunkEditText(hunk: DiffHunk): string {
  return [hunk.header, ...hunk.lines.map((l) => (l.type === 'meta' ? metaText(l) : MARK[l.type] + l.content))].join('\n') + '\n'
}

export type EditedHunk = { patch: string } | { error: string }

/**
 * Turn an edited hunk back into a patch that stages it (forwards, with `git apply --cached`). As in `git add -e`:
 * added lines may be changed or deleted, a removed line is kept by turning its '-' into a space, and context and
 * removed lines must otherwise stay as they were. Lines starting with '#' are comments; an empty line is empty context.
 */
export function buildEditedHunkPatch(diff: FileDiff, hunkIndex: number, text: string): EditedHunk {
  const hunk = diff.hunks[hunkIndex]
  if (!hunk) return { error: 'The hunk no longer exists.' }
  const raw = text.replace(/\r/g, '').split('\n')
  if (raw[raw.length - 1] === '') raw.pop()

  const out: string[] = []
  // old-side lines (context and removed) with the editor line they came from, to compare with the original
  const oldSide: { content: string; line: number }[] = []
  let oldCount = 0
  let newCount = 0
  let changed = false
  let hasContext = false
  let seenBody = false
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]
    const n = i + 1
    if (line.startsWith('#')) continue
    if (line.startsWith('@@')) {
      if (seenBody) return { error: `Line ${n}: only one hunk can be edited at a time.` }
      continue
    }
    seenBody = true
    const mark = line === '' ? ' ' : line[0]
    const content = line.slice(1)
    if (mark === '\\') {
      // "\ No newline at end of file" belongs to the line before it
      if (out.length === 0) return { error: `Line ${n}: a "\\ No newline" marker must follow a line.` }
      out.push(line)
    } else if (mark === ' ') {
      out.push(' ' + content)
      oldSide.push({ content, line: n })
      oldCount++
      newCount++
      hasContext = true
    } else if (mark === '-') {
      out.push(line)
      oldSide.push({ content, line: n })
      oldCount++
      changed = true
    } else if (mark === '+') {
      out.push(line)
      newCount++
      changed = true
    } else {
      return { error: `Line ${n} starts with "${mark}": every line must start with a space, + or -.` }
    }
  }

  const original = hunk.lines.filter((l) => l.type === 'context' || l.type === 'del').map((l) => l.content)
  const k = original.findIndex((content, i) => oldSide[i]?.content !== content)
  if (k !== -1 || oldSide.length > original.length) {
    // every remaining line still in the original, in order: lines were deleted rather than changed
    let j = 0
    for (const o of original) if (j < oldSide.length && oldSide[j].content === o) j++
    if (j === oldSide.length)
      return { error: 'Context or removed lines were deleted. To keep a removed line, change its "-" to a space instead of deleting it.' }
    const edited = oldSide[k === -1 ? original.length : Math.min(k, oldSide.length - 1)]
    return { error: `Line ${edited.line}: "${edited.content}" is not in the original hunk. Only added lines can be changed.` }
  }
  if (!changed) return { error: 'Nothing is left to stage in this hunk.' }

  const oldStart = hunk.oldStart
  const newStart = oldStart + (oldCount === 0 ? 1 : 0) - (newCount === 0 ? 1 : 0)
  const heading = /^@@ [^@]* @@(.*)$/.exec(hunk.header)?.[1] ?? ''
  // keeping lines of a deleted file means the file stays: stage it as a modification
  const header = ensureFileHeaders(rewriteHeader(diff, !!diff.isDeleted && hasContext), diff)
  const hunkHeader = `@@ -${range(oldStart, oldCount)} +${range(Math.max(0, newStart), newCount)} @@${heading}`
  return { patch: [...header, hunkHeader, ...out].join('\n') + '\n' }
}
