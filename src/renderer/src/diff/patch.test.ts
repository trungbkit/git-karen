import { describe, expect, it } from 'vitest'
import type { DiffHunk, DiffLine, FileDiff } from '@shared/types'
import { buildEditedHunkPatch, buildPatch, hunkEditText } from './patch'

/** Parse a compact hunk body (lines prefixed with ' ', '+', '-', '\') into DiffLines. */
function lines(body: string): DiffLine[] {
  return body.split('\n').map((l) => {
    const c = l[0]
    if (c === '+') return { type: 'add', content: l.slice(1) }
    if (c === '-') return { type: 'del', content: l.slice(1) }
    if (c === '\\') return { type: 'meta', content: l }
    return { type: 'context', content: l.slice(1) }
  })
}

function hunk(header: string, body: string): DiffHunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)!
  return {
    header,
    oldStart: +m[1],
    oldLines: m[2] === undefined ? 1 : +m[2],
    newStart: +m[3],
    newLines: m[4] === undefined ? 1 : +m[4],
    lines: lines(body)
  }
}

const HEADER = ['diff --git a/f.txt b/f.txt', 'index 1111111..2222222 100644', '--- a/f.txt', '+++ b/f.txt']

function fileDiff(hunks: DiffHunk[], extra: Partial<FileDiff> = {}): FileDiff {
  return { path: 'f.txt', binary: false, hunks, headerLines: HEADER, ...extra }
}

const twoHunks = fileDiff([
  hunk('@@ -1,4 +1,4 @@ heading', ' a\n-b\n+B\n c\n d'),
  hunk('@@ -10,3 +10,5 @@', ' x\n+y1\n+y2\n z\n w')
])

describe('buildPatch – whole hunks', () => {
  it('stages a whole hunk unchanged', () => {
    const p = buildPatch(twoHunks, [{ hunkIndex: 0 }], 'stage')
    expect(p).toBe([...HEADER, '@@ -1,4 +1,4 @@ heading', ' a', '-b', '+B', ' c', ' d', ''].join('\n'))
  })

  it('recomputes new start when an earlier hunk is skipped (forward)', () => {
    const p = buildPatch(twoHunks, [{ hunkIndex: 1 }], 'stage')
    expect(p).toContain('@@ -10,3 +10,5 @@')
  })

  it('shifts later hunk by earlier hunk delta', () => {
    const d = fileDiff([hunk('@@ -1,2 +1,3 @@', ' a\n+n\n b'), hunk('@@ -10,2 +11,2 @@', '-x\n+X\n y')])
    const p = buildPatch(d, [{ hunkIndex: 0 }, { hunkIndex: 1 }], 'stage')
    expect(p).toContain('@@ -1,2 +1,3 @@')
    expect(p).toContain('@@ -10,2 +11,2 @@')
  })

  it('reverse modes keep new-side positions and recompute old side', () => {
    const d = fileDiff([hunk('@@ -1,2 +1,3 @@', ' a\n+n\n b'), hunk('@@ -10,2 +11,2 @@', '-x\n+X\n y')])
    const p = buildPatch(d, [{ hunkIndex: 1 }], 'unstage')
    // Only the second hunk is reverted; on the new side it's at 11, old side then at 11 too.
    expect(p).toContain('@@ -11,2 +11,2 @@')
  })

  it('returns empty string for an empty selection', () => {
    expect(buildPatch(twoHunks, [], 'stage')).toBe('')
  })

  it('ignores hunks with only context', () => {
    const d = fileDiff([hunk('@@ -1,2 +1,2 @@', ' a\n b')])
    expect(buildPatch(d, [{ hunkIndex: 0 }], 'stage')).toBe('')
  })
})

describe('buildPatch – line selection', () => {
  const d = fileDiff([hunk('@@ -1,4 +1,5 @@', ' a\n-b\n-c\n+B\n+C\n+D\n d')])
  // indexes: 0 ' a', 1 '-b', 2 '-c', 3 '+B', 4 '+C', 5 '+D', 6 ' d'

  it('stage: unselected deletions become context, unselected additions are dropped', () => {
    const p = buildPatch(d, [{ hunkIndex: 0, lineIndexes: [1, 3] }], 'stage')
    expect(p.split('\n').slice(4)).toEqual(['@@ -1,4 +1,4 @@', ' a', '-b', ' c', '+B', ' d', ''])
  })

  it('unstage (reverse): unselected additions become context, unselected deletions are dropped', () => {
    const p = buildPatch(d, [{ hunkIndex: 0, lineIndexes: [1, 3] }], 'unstage')
    expect(p.split('\n').slice(4)).toEqual(['@@ -1,5 +1,5 @@', ' a', '-b', '+B', ' C', ' D', ' d', ''])
  })

  it('discard behaves like unstage', () => {
    expect(buildPatch(d, [{ hunkIndex: 0, lineIndexes: [4] }], 'discard')).toBe(
      [...HEADER, '@@ -1,4 +1,5 @@', ' a', ' B', '+C', ' D', ' d', ''].join('\n')
    )
  })

  it('selecting only additions yields correct counts', () => {
    const p = buildPatch(d, [{ hunkIndex: 0, lineIndexes: [5] }], 'stage')
    expect(p.split('\n').slice(4)).toEqual(['@@ -1,4 +1,5 @@', ' a', ' b', ' c', '+D', ' d', ''])
  })

  it('selecting only context lines yields nothing', () => {
    expect(buildPatch(d, [{ hunkIndex: 0, lineIndexes: [0, 6] }], 'stage')).toBe('')
  })

  it('merges multiple selections for the same hunk', () => {
    const a = buildPatch(d, [{ hunkIndex: 0, lineIndexes: [1] }, { hunkIndex: 0, lineIndexes: [3] }], 'stage')
    const b = buildPatch(d, [{ hunkIndex: 0, lineIndexes: [1, 3] }], 'stage')
    expect(a).toBe(b)
  })

  it('whole-hunk selection wins over line selection for the same hunk', () => {
    const a = buildPatch(d, [{ hunkIndex: 0, lineIndexes: [1] }, { hunkIndex: 0 }], 'stage')
    expect(a).toBe(buildPatch(d, [{ hunkIndex: 0 }], 'stage'))
  })
})

describe('buildPatch – no newline at end of file', () => {
  const d = fileDiff([hunk('@@ -1,2 +1,2 @@', ' a\n-b\n\\ No newline at end of file\n+b')])

  it('keeps the marker attached to an emitted line', () => {
    const p = buildPatch(d, [{ hunkIndex: 0 }], 'stage')
    expect(p.split('\n').slice(4)).toEqual(['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b', ''])
  })

  it('drops the marker when its line is dropped', () => {
    // reverse, select only the '+b' line: '-b' is dropped together with its marker
    const p = buildPatch(d, [{ hunkIndex: 0, lineIndexes: [3] }], 'discard')
    expect(p.split('\n').slice(4)).toEqual(['@@ -1 +1,2 @@', ' a', '+b', ''])
  })

  it('keeps the marker when the deletion is converted to context', () => {
    const p = buildPatch(d, [{ hunkIndex: 0, lineIndexes: [3] }], 'stage')
    expect(p).toContain(' b\n\\ No newline at end of file\n+b')
  })
})

describe('buildPatch – new and deleted files', () => {
  const NEW_HEADER = ['diff --git a/n.txt b/n.txt', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/n.txt']
  const newFile: FileDiff = {
    path: 'n.txt',
    binary: false,
    isNew: true,
    headerLines: NEW_HEADER,
    hunks: [hunk('@@ -0,0 +1,3 @@', '+one\n+two\n+three')]
  }

  it('stages a whole new file with its header', () => {
    expect(buildPatch(newFile, [{ hunkIndex: 0 }], 'stage')).toBe([...NEW_HEADER, '@@ -0,0 +1,3 @@', '+one', '+two', '+three', ''].join('\n'))
  })

  it('stages part of a new file, still as a new file', () => {
    expect(buildPatch(newFile, [{ hunkIndex: 0, lineIndexes: [0, 2] }], 'stage')).toBe(
      [...NEW_HEADER, '@@ -0,0 +1,2 @@', '+one', '+three', ''].join('\n')
    )
  })

  it('partially unstaging a new file rewrites it as a modification', () => {
    const p = buildPatch(newFile, [{ hunkIndex: 0, lineIndexes: [1] }], 'unstage')
    expect(p).toBe(['diff --git a/n.txt b/n.txt', '--- a/n.txt', '+++ b/n.txt', '@@ -1,2 +1,3 @@', ' one', '+two', ' three', ''].join('\n'))
  })

  it('fully unstaging a new file keeps the new-file header', () => {
    expect(buildPatch(newFile, [{ hunkIndex: 0 }], 'unstage')).toContain('new file mode 100644\n')
  })

  const DEL_HEADER = ['diff --git a/d.txt b/d.txt', 'deleted file mode 100644', 'index 4444444..0000000', '--- a/d.txt', '+++ /dev/null']
  const delFile: FileDiff = {
    path: 'd.txt',
    binary: false,
    isDeleted: true,
    headerLines: DEL_HEADER,
    hunks: [hunk('@@ -1,2 +0,0 @@', '-one\n-two')]
  }

  it('stages a whole deletion', () => {
    expect(buildPatch(delFile, [{ hunkIndex: 0 }], 'stage')).toBe([...DEL_HEADER, '@@ -1,2 +0,0 @@', '-one', '-two', ''].join('\n'))
  })

  it('partially staging a deletion rewrites it as a modification', () => {
    expect(buildPatch(delFile, [{ hunkIndex: 0, lineIndexes: [0] }], 'stage')).toBe(
      ['diff --git a/d.txt b/d.txt', '--- a/d.txt', '+++ b/d.txt', '@@ -1,2 +1 @@', '-one', ' two', ''].join('\n')
    )
  })

  it('adds ---/+++ headers when missing', () => {
    const d: FileDiff = { path: 'x', binary: false, headerLines: ['diff --git a/x b/x'], hunks: [hunk('@@ -1 +1 @@', '-a\n+b')] }
    expect(buildPatch(d, [{ hunkIndex: 0 }], 'stage')).toBe(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', ''].join('\n'))
  })
})

describe('buildEditedHunkPatch', () => {
  const d = fileDiff([hunk('@@ -1,4 +1,5 @@ fn main', ' a\n-b\n+B\n+C\n c\n d'), hunk('@@ -10,2 +11,2 @@', '-x\n+X\n y')])
  const edit = (text: string, index = 0) => buildEditedHunkPatch(d, index, text)
  const patch = (text: string, index = 0) => {
    const r = edit(text, index)
    if ('error' in r) throw new Error(r.error)
    return r.patch
  }

  it('starts from the hunk header and marked lines', () => {
    expect(hunkEditText(d.hunks[0])).toBe('@@ -1,4 +1,5 @@ fn main\n a\n-b\n+B\n+C\n c\n d\n')
  })

  it('an unedited hunk is the plain hunk patch', () => {
    expect(patch(hunkEditText(d.hunks[0]))).toBe(buildPatch(d, [{ hunkIndex: 0 }], 'stage'))
    expect(patch(hunkEditText(d.hunks[1]), 1)).toBe([...HEADER, '@@ -10,2 +10,2 @@', '-x', '+X', ' y', ''].join('\n'))
  })

  it('recounts after removing and changing added lines', () => {
    expect(patch('@@ -1,4 +1,5 @@ fn main\n a\n-b\n+Bee\n c\n d\n')).toBe(
      [...HEADER, '@@ -1,4 +1,4 @@ fn main', ' a', '-b', '+Bee', ' c', ' d', ''].join('\n')
    )
  })

  it('keeps a removed line turned into context, without the header line, ignoring comments and CRs', () => {
    expect(patch('# edit me\r\n a\r\n b\r\n+B\r\n c\r\n d')).toBe([...HEADER, '@@ -1,4 +1,5 @@ fn main', ' a', ' b', '+B', ' c', ' d', ''].join('\n'))
  })

  it('treats an empty line as empty context', () => {
    const blank = fileDiff([hunk('@@ -3,2 +3,3 @@', ' \n+x\n y')])
    expect(buildEditedHunkPatch(blank, 0, '\n+x\n y\n')).toEqual({ patch: [...HEADER, '@@ -3,2 +3,3 @@', ' ', '+x', ' y', ''].join('\n') })
  })

  it('rejects lines without a marker', () => {
    expect(edit(' a\n-b\nB\n c\n d')).toEqual({ error: 'Line 3 starts with "B": every line must start with a space, + or -.' })
  })

  it('rejects changed or deleted context and removed lines', () => {
    expect(edit(' a\n-bee\n+B\n c\n d')).toEqual({ error: 'Line 2: "bee" is not in the original hunk. Only added lines can be changed.' })
    expect(edit(' a\n+B\n c\n d')).toMatchObject({ error: expect.stringContaining('change its "-" to a space') })
    expect(edit(' a\n-b\n c\n d\n e')).toMatchObject({ error: expect.stringContaining('"e" is not in the original hunk') })
  })

  it('rejects a hunk with nothing left to stage, or a second hunk', () => {
    expect(edit(' a\n b\n c\n d')).toEqual({ error: 'Nothing is left to stage in this hunk.' })
    expect(edit(' a\n-b\n c\n d\n@@ -10,2 +11,2 @@\n-x')).toEqual({ error: 'Line 5: only one hunk can be edited at a time.' })
  })

  it('stages part of a new file and keeps part of a deleted file', () => {
    const NEW_HEADER = ['diff --git a/n.txt b/n.txt', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/n.txt']
    const newFile: FileDiff = { path: 'n.txt', binary: false, isNew: true, headerLines: NEW_HEADER, hunks: [hunk('@@ -0,0 +1,3 @@', '+one\n+two\n+three')] }
    expect(buildEditedHunkPatch(newFile, 0, '+one\n+three\n')).toEqual({ patch: [...NEW_HEADER, '@@ -0,0 +1,2 @@', '+one', '+three', ''].join('\n') })

    const DEL_HEADER = ['diff --git a/d.txt b/d.txt', 'deleted file mode 100644', 'index 4444444..0000000', '--- a/d.txt', '+++ /dev/null']
    const delFile: FileDiff = { path: 'd.txt', binary: false, isDeleted: true, headerLines: DEL_HEADER, hunks: [hunk('@@ -1,2 +0,0 @@', '-one\n-two')] }
    expect(buildEditedHunkPatch(delFile, 0, '-one\n two\n')).toEqual({
      patch: ['diff --git a/d.txt b/d.txt', '--- a/d.txt', '+++ b/d.txt', '@@ -1,2 +1 @@', '-one', ' two', ''].join('\n')
    })
    expect(buildEditedHunkPatch(delFile, 0, '-one\n-two\n')).toEqual({ patch: [...DEL_HEADER, '@@ -1,2 +0,0 @@', '-one', '-two', ''].join('\n') })
  })

  it('keeps "no newline" markers with their line', () => {
    const nl = fileDiff([hunk('@@ -1 +1,2 @@', '-a\n\\ No newline at end of file\n+a\n+b')])
    expect(buildEditedHunkPatch(nl, 0, hunkEditText(nl.hunks[0]))).toEqual({
      patch: [...HEADER, '@@ -1 +1,2 @@', '-a', '\\ No newline at end of file', '+a', '+b', ''].join('\n')
    })
    expect(buildEditedHunkPatch(nl, 0, '\\ No newline at end of file\n-a')).toMatchObject({ error: expect.stringContaining('must follow a line') })
  })
})
