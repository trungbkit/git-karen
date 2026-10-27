// Word-level differences between a removed line and the added line that replaced it, for highlighting the
// changed words inside a diff. Lines are split into words, whitespace runs, operators and symbols, and the longest
// common subsequence of those tokens is what stayed; everything else changed.

/** [start, end) character offsets */
export type Range = [number, number]

export interface WordDiff {
  /** Changed parts of the removed line */
  a: Range[]
  /** Changed parts of the added line */
  b: Range[]
}

export interface WordDiffOptions {
  /** Whitespace changes are not highlighted (the diff is shown ignoring whitespace) */
  ignoreWhitespace?: boolean
  /**
   * Work left for a batch of lines (one diff), in LCS cells (tokenizing counts a cell per character), used up by
   * each comparison. Once spent, lines get one range between their common prefix and suffix, so a diff full of
   * long changed lines stays fast.
   */
  budget?: { cells: number }
}

/** Work a whole diff may use: a few tens of milliseconds at most. */
export const DIFF_CELL_BUDGET = 2_000_000

/** Lines this long or longer are not compared (minified files, data): highlighting them is slow and useless. */
export const MAX_WORD_DIFF_LINE = 2000

/** Token grid cells above which only the common prefix and suffix are kept (bounds the LCS's time and memory). */
const MAX_CELLS = 250_000

/** Below this share of unchanged characters the lines are a rewrite rather than an edit, and nothing is highlighted. */
const MIN_SIMILARITY = 0.3

// words, whitespace runs, operators (`===`, `=>`, `&&`) and any other single character
const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[=!<>&|+\-*/%^~?:]+|[^\p{L}\p{N}_\s]/gu

export function tokenize(line: string): string[] {
  return line.match(TOKEN_RE) ?? []
}

const isSpace = (t: string) => t.trim() === ''

/**
 * Changed ranges of `a` (removed) and `b` (added). Null when the lines are too long to compare or too different
 * for word highlighting to help.
 */
export function wordDiff(a: string, b: string, opts: WordDiffOptions = {}): WordDiff | null {
  const key = `${opts.ignoreWhitespace ? 1 : 0}\u0000${a}\u0000${b}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const limited = { short: false }
  const result = compute(a, b, !!opts.ignoreWhitespace, opts.budget, limited)
  // a result cut short by the budget is not what the lines get with a fresh one
  if (limited.short) return result
  if (cache.size >= CACHE_SIZE) cache.clear()
  cache.set(key, result)
  return result
}

// Diffs re-render (selection, focus, expansion) and reload with the same lines; keep recent results.
const CACHE_SIZE = 5000
const cache = new Map<string, WordDiff | null>()

function compute(
  a: string,
  b: string,
  ignoreWs: boolean,
  budget: { cells: number } | undefined,
  limited: { short: boolean }
): WordDiff | null {
  if (a.length >= MAX_WORD_DIFF_LINE || b.length >= MAX_WORD_DIFF_LINE) return null
  if (a === b) return { a: [], b: [] }
  if (budget) {
    if (budget.cells < a.length + b.length) {
      limited.short = true
      return affixDiff(a, b)
    }
    budget.cells -= a.length + b.length
  }
  const ta = tokenize(a)
  const tb = tokenize(b)
  const same = (x: string, y: string) => x === y || (ignoreWs && isSpace(x) && isSpace(y))

  // common prefix and suffix first: most edits touch a small part of the line
  let pre = 0
  while (pre < ta.length && pre < tb.length && same(ta[pre], tb[pre])) pre++
  let sa = ta.length
  let sb = tb.length
  while (sa > pre && sb > pre && same(ta[sa - 1], tb[sb - 1])) {
    sa--
    sb--
  }

  const keepA = new Uint8Array(ta.length)
  const keepB = new Uint8Array(tb.length)
  keepA.fill(1, 0, pre)
  keepB.fill(1, 0, pre)
  keepA.fill(1, sa)
  keepB.fill(1, sb)
  const n = sa - pre
  const m = sb - pre
  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    if (budget && budget.cells < n * m) limited.short = true
    else {
      if (budget) budget.cells -= n * m
      lcs(ta, tb, pre, n, m, same, keepA, keepB)
    }
  }

  const ra = changedRanges(ta, keepA, ignoreWs)
  const rb = changedRanges(tb, keepB, ignoreWs)
  const kept = (tokens: string[], keep: Uint8Array) => tokens.reduce((sum, t, i) => (keep[i] && !isSpace(t) ? sum + t.length : sum), 0)
  const visible = (s: string) => s.replace(/\s+/g, '').length
  const shorter = Math.min(visible(a), visible(b))
  if (shorter > 0 && Math.min(kept(ta, keepA), kept(tb, keepB)) < shorter * MIN_SIMILARITY) return null
  return { a: ra, b: rb }
}

/** The cheap fallback: one changed range between the common prefix and suffix of the characters. */
function affixDiff(a: string, b: string): WordDiff | null {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let ea = a.length
  let eb = b.length
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  const common = start + (a.length - ea)
  if (common === 0 || common < Math.min(a.length, b.length) * MIN_SIMILARITY) return null
  return { a: ea > start ? [[start, ea]] : [], b: eb > start ? [[start, eb]] : [] }
}

/** Marks the tokens of the longest common subsequence of ta[off, off+n) and tb[off, off+m) as kept. */
function lcs(
  ta: string[],
  tb: string[],
  off: number,
  n: number,
  m: number,
  same: (x: string, y: string) => boolean,
  keepA: Uint8Array,
  keepB: Uint8Array
) {
  // len[i][j] = LCS length of the suffixes from i and j
  const w = m + 1
  const len = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] = same(ta[off + i], tb[off + j]) ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (same(ta[off + i], tb[off + j])) {
      keepA[off + i++] = 1
      keepB[off + j++] = 1
    } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++
    else j++
  }
}

/**
 * Character ranges of the tokens not kept. Neighbouring changes separated only by whitespace become one range,
 * so a rewritten phrase reads as one change rather than word by word.
 */
function changedRanges(tokens: string[], keep: Uint8Array, ignoreWs: boolean): Range[] {
  const out: Range[] = []
  let pos = 0
  let gapStart = -1 // start of kept whitespace following the last range
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const start = pos
    pos += t.length
    const space = isSpace(t)
    if (keep[i] || (ignoreWs && space)) {
      if (space && gapStart < 0 && out.length && out[out.length - 1][1] === start) gapStart = start
      else if (!space) gapStart = -1
      continue
    }
    const last = out[out.length - 1]
    if (last && (last[1] === start || gapStart >= 0)) last[1] = pos
    else out.push([start, pos])
    gapStart = -1
  }
  return out
}
