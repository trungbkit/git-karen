// diff3-style three-way merge of line arrays.

export type Chunk =
  | { kind: 'stable'; lines: string[] }
  /** Changed on one side only (or identically on both): resolved automatically to `lines`. */
  | { kind: 'resolved'; side: 'ours' | 'theirs' | 'both'; base: string[]; ours: string[]; theirs: string[]; lines: string[] }
  | { kind: 'conflict'; base: string[]; ours: string[]; theirs: string[] }

/** Beyond this many DP cells the middle section is treated as entirely changed. */
const MAX_CELLS = 16_000_000

/**
 * For each line of `a`, the index of the matching line in `b` (or -1), per a longest common subsequence.
 * Common prefix/suffix are trimmed before the O(n·m) LCS table.
 */
export function lcsMatches(a: string[], b: string[]): Int32Array {
  const match = new Int32Array(a.length).fill(-1)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    match[start] = start
    start++
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
    match[endA] = endB
  }
  const n = endA - start
  const m = endB - start
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) return match

  // dp[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[start + i] === b[start + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      match[start + i] = start + j
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
    else j++
  }
  return match
}

function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i])
}

export function merge3(base: string[], ours: string[], theirs: string[]): Chunk[] {
  const mo = lcsMatches(base, ours)
  const mt = lcsMatches(base, theirs)
  const chunks: Chunk[] = []
  const pushStable = (line: string) => {
    const last = chunks[chunks.length - 1]
    if (last?.kind === 'stable') last.lines.push(line)
    else chunks.push({ kind: 'stable', lines: [line] })
  }

  let i = 0
  let j = 0
  let k = 0
  while (i < base.length || j < ours.length || k < theirs.length) {
    // Stable run: base line matched to the current position on both sides.
    if (i < base.length && mo[i] === j && mt[i] === k) {
      pushStable(base[i])
      i++
      j++
      k++
      continue
    }
    // Next sync point: a base line matched on both sides.
    let ni = i
    while (ni < base.length && (mo[ni] < 0 || mt[ni] < 0)) ni++
    const nj = ni < base.length ? mo[ni] : ours.length
    const nk = ni < base.length ? mt[ni] : theirs.length

    const b = base.slice(i, ni)
    const o = ours.slice(j, nj)
    const t = theirs.slice(k, nk)
    if (eq(o, b)) chunks.push({ kind: 'resolved', side: 'theirs', base: b, ours: o, theirs: t, lines: t })
    else if (eq(t, b)) chunks.push({ kind: 'resolved', side: 'ours', base: b, ours: o, theirs: t, lines: o })
    else if (eq(o, t)) chunks.push({ kind: 'resolved', side: 'both', base: b, ours: o, theirs: t, lines: o })
    else chunks.push({ kind: 'conflict', base: b, ours: o, theirs: t })
    i = ni
    j = nj
    k = nk
  }
  return chunks
}

/** Split file content into lines; a trailing newline does not produce an extra empty line. */
export function splitLines(text: string | null): string[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export interface ConflictChoice {
  ours: boolean
  theirs: boolean
}

/**
 * Render merged output; conflict chunks take the chosen sides (ours first), or the lines of `overrides` where it has
 * them (e.g. an AI resolution).
 */
export function renderMerge(chunks: Chunk[], choices: ConflictChoice[], overrides: (string[] | null)[] = []): string[] {
  const out: string[] = []
  let c = 0
  for (const chunk of chunks) {
    if (chunk.kind === 'conflict') {
      const override = overrides[c]
      const choice = choices[c++] ?? { ours: false, theirs: false }
      if (override) out.push(...override)
      else if (choice.ours) out.push(...chunk.ours)
      if (choice.theirs) out.push(...chunk.theirs)
    } else out.push(...chunk.lines)
  }
  return out
}
