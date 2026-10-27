import { describe, expect, it } from 'vitest'
import { DIFF_CELL_BUDGET, MAX_WORD_DIFF_LINE, tokenize, wordDiff, type Range } from './wordDiff'

/** The changed text of each range, to keep expectations readable. */
const parts = (line: string, ranges: Range[]) => ranges.map(([s, e]) => line.slice(s, e))

function changed(a: string, b: string, ignoreWhitespace = false) {
  const d = wordDiff(a, b, { ignoreWhitespace })
  return d && { a: parts(a, d.a), b: parts(b, d.b) }
}

describe('tokenize', () => {
  it('splits words, whitespace runs and single symbols', () => {
    expect(tokenize('const fooBar = obj.call(1,  "x")')).toEqual(['const', ' ', 'fooBar', ' ', '=', ' ', 'obj', '.', 'call', '(', '1', ',', '  ', '"', 'x', '"', ')'])
  })

  it('keeps operators together', () => {
    expect(tokenize('a === b && c=>d;')).toEqual(['a', ' ', '===', ' ', 'b', ' ', '&&', ' ', 'c', '=>', 'd', ';'])
  })

  it('keeps letters of any script together', () => {
    expect(tokenize('xin chào_bạn!')).toEqual(['xin', ' ', 'chào_bạn', '!'])
    expect(tokenize('')).toEqual([])
  })
})

describe('wordDiff', () => {
  it('highlights only the changed word', () => {
    expect(changed('const value = 1', 'const total = 1')).toEqual({ a: ['value'], b: ['total'] })
  })

  it('finds several separate changes in one line', () => {
    expect(changed('call(alpha, beta, gamma)', 'call(alpha, BETA, gamma, delta)')).toEqual({ a: ['beta'], b: ['BETA', ', delta'] })
  })

  it('marks pure insertions and deletions on one side only', () => {
    expect(changed('foo(a)', 'foo(a, b)')).toEqual({ a: [], b: [', b'] })
    expect(changed('return x + y', 'return x')).toEqual({ a: [' + y'], b: [] })
  })

  it('joins changed words separated only by whitespace', () => {
    expect(changed('the quick brown fox jumps', 'the slow red fox jumps')).toEqual({ a: ['quick brown'], b: ['slow red'] })
  })

  it('returns character offsets into the original lines', () => {
    const d = wordDiff('  if (a == b) {', '  if (a === b) {')!
    expect(d.a).toEqual([[8, 10]])
    expect(d.b).toEqual([[8, 11]])
  })

  it('shows whitespace changes unless whitespace is ignored', () => {
    expect(changed('a  =  1', 'a = 1')).toEqual({ a: ['  ', '  '], b: [' ', ' '] })
    expect(changed('a  =  1', 'a = 1', true)).toEqual({ a: [], b: [] })
    expect(changed('foo(a,b)', 'foo(a, b)', true)).toEqual({ a: [], b: [] })
    expect(changed('\tlet x = 1', '    let x = 2', true)).toEqual({ a: ['1'], b: ['2'] })
  })

  it('does not highlight lines that were rewritten rather than edited', () => {
    expect(wordDiff('import React from "react"', 'export default function App() {}')).toBeNull()
    expect(wordDiff('a', 'b')).toBeNull()
  })

  it('identical lines have no changes', () => {
    expect(wordDiff('same', 'same')).toEqual({ a: [], b: [] })
  })

  it('skips lines of MAX_WORD_DIFF_LINE characters or more', () => {
    const long = 'x '.repeat(MAX_WORD_DIFF_LINE / 2)
    expect(long.length).toBe(MAX_WORD_DIFF_LINE)
    expect(wordDiff(long, long.slice(2) + 'y')).toBeNull()
    expect(changed(long.slice(2), long.slice(2, -2) + 'y ')).toEqual({ a: ['x'], b: ['y'] })
  })

  it('finds one changed word in a long line through the common prefix and suffix', () => {
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ')
    expect(changed(`start ${words} end`, `start ${words.replace('w150', 'v150')} end`)).toEqual({ a: ['w150'], b: ['v150'] })
  })

  it('treats a changed middle too large to compare as one change', () => {
    const prefix = 'p '.repeat(600)
    const a = prefix + 'x y '.repeat(130)
    const b = prefix + 'y x '.repeat(130)
    const d = wordDiff(a, b)!
    expect(d.a).toEqual([[prefix.length, a.length - 1]])
    expect(d.b).toEqual([[prefix.length, b.length - 1]])
  })

  it('memoizes results', () => {
    const first = wordDiff('let a = 1', 'let a = 2')
    expect(wordDiff('let a = 1', 'let a = 2')).toBe(first)
    expect(wordDiff('let a = 1', 'let a = 2', { ignoreWhitespace: true })).not.toBe(first)
  })

  it('falls back to prefix and suffix once the budget is spent, without caching that', () => {
    const a = 'const result = call(alpha, beta, gamma, delta) + somethingElse'
    const b = 'const result = call(ALPHA, beta, gamma, DELTA) + somethingElse'
    const budget = { cells: 0 }
    expect(parts(a, wordDiff(a, b, { budget })!.a)).toEqual(['alpha, beta, gamma, delta'])
    expect(changed(a, b)).toEqual({ a: ['alpha', 'delta'], b: ['ALPHA', 'DELTA'] })
    const some = { cells: 1000 }
    wordDiff('x = first(1)', 'x = second(2)', { budget: some })
    expect(some.cells).toBeLessThan(1000)
  })
})

// Word diff runs while a diff renders. These bound its cost on a 5000-line diff (generously, to stay stable on
// slow machines); the browser measurement is in docs/plans/04-diff-review.md.
describe('wordDiff cost on a 5000-line diff', () => {
  const pairs = (n: number, make: (i: number) => [string, string]) => Array.from({ length: n }, (_, i) => make(i))
  const time = (list: [string, string][]) => {
    const budget = { cells: DIFF_CELL_BUDGET }
    const t = performance.now()
    for (const [a, b] of list) wordDiff(a, b, { budget })
    return performance.now() - t
  }

  it('compares 2500 changed code line pairs quickly', () => {
    const list = pairs(2500, (i) => [
      `    const value${i} = compute(alpha${i}, beta, "string literal ${i}") // old comment`,
      `    const value${i} = compute(alpha${i}, gamma, "string literal ${i}") // new comment here`
    ])
    expect(time(list)).toBeLessThan(250)
  })

  it('stays bounded when every line is long and changed throughout', () => {
    const words = (i: number, flip: boolean) => Array.from({ length: 300 }, (_, k) => ((k + (flip ? 1 : 0)) % 7 === 0 ? `X${i}` : `w${k}`)).join(' ')
    const list = pairs(2500, (i) => [words(i, false), words(i, true)])
    expect(list[0][0].length).toBeLessThan(MAX_WORD_DIFF_LINE)
    expect(time(list)).toBeLessThan(1000)
  })
})
