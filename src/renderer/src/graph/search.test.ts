import { describe, expect, it } from 'vitest'
import type { Commit } from '@shared/types'
import { completePrefix, highlightTerm, isEmptySearch, matchCommit, matchStash, needsBackend, parseDate, parseSearch, suggestPrefixes, tokenize } from './search'

const NOW = new Date(2026, 9, 27, 15, 30).getTime()

function commit(over: Partial<Commit> & { date?: number; author?: string; email?: string } = {}): Commit {
  const date = over.date ?? NOW
  const sig = { name: over.author ?? 'Ann Lee', email: over.email ?? 'ann@example.com', date }
  return { sha: 'abc1234def', parents: [], author: sig, committer: sig, summary: 'Fix login', body: 'Details here', refs: ['refs/heads/main'], ...over }
}

describe('tokenize', () => {
  it('splits prefixed values, quoted values and plain words with their positions', () => {
    expect(tokenize('author:ann  fix "two words" message:"a b"')).toEqual([
      { field: 'author', value: 'ann', start: 0, end: 10 },
      { field: null, value: 'fix', start: 12, end: 15 },
      { field: null, value: 'two words', start: 16, end: 27 },
      { field: 'message', value: 'a b', start: 28, end: 41 }
    ])
  })

  it('treats unknown prefixes as text and accepts any case', () => {
    expect(tokenize('fix:login AUTHOR:x').map((t) => [t.field, t.value])).toEqual([
      [null, 'fix:login'],
      ['author', 'x']
    ])
  })

  it('reads an unclosed quote to the end', () => {
    expect(tokenize('path:"src/my dir')).toEqual([{ field: 'path', value: 'src/my dir', start: 0, end: 16 }])
  })
})

describe('parseDate', () => {
  it('reads calendar dates as the start or end of that day, month or year', () => {
    expect(parseDate('2026-10-01', 'start', NOW)).toBe(new Date(2026, 9, 1).getTime())
    expect(parseDate('2026-10-01', 'end', NOW)).toBe(new Date(2026, 9, 2).getTime() - 1)
    expect(parseDate('2026-02', 'end', NOW)).toBe(new Date(2026, 2, 1).getTime() - 1)
    expect(parseDate('2025', 'start', NOW)).toBe(new Date(2025, 0, 1).getTime())
    expect(parseDate('2025', 'end', NOW)).toBe(new Date(2026, 0, 1).getTime() - 1)
  })

  it('reads ages and day names relative to now', () => {
    expect(parseDate('3d', 'start', NOW)).toBe(NOW - 3 * 86_400_000)
    expect(parseDate('2w', 'start', NOW)).toBe(NOW - 14 * 86_400_000)
    expect(parseDate('12h', 'start', NOW)).toBe(NOW - 12 * 3_600_000)
    expect(parseDate('1m', 'start', NOW)).toBe(new Date(2026, 8, 27, 15, 30).getTime())
    expect(parseDate('1y', 'start', NOW)).toBe(new Date(2025, 9, 27, 15, 30).getTime())
    expect(parseDate('today', 'start', NOW)).toBe(new Date(2026, 9, 27).getTime())
    expect(parseDate('Yesterday', 'end', NOW)).toBe(new Date(2026, 9, 27).getTime() - 1)
  })

  it('rejects anything else', () => {
    for (const bad of ['', 'soon', '2026-13-01', '2026-01-32', '3x', '-2d']) expect(parseDate(bad, 'start', NOW)).toBeNull()
  })
})

describe('parseSearch', () => {
  it('collects values per field; text without a prefix is joined', () => {
    const s = parseSearch('Fix author:Ann path:src content:TODO login sha:ABC', NOW)
    expect(s).toMatchObject({ text: 'fix login', author: ['ann'], path: ['src'], content: ['TODO'], sha: ['abc'], errors: [] })
    expect(needsBackend(s)).toBe(true)
  })

  it('ignores a prefix still being typed and reports unreadable dates', () => {
    const s = parseSearch('author: since:someday until:2026-10-01', NOW)
    expect(s.author).toEqual([])
    expect(s.since).toBeNull()
    expect(s.until).toBe(new Date(2026, 9, 2).getTime() - 1)
    expect(s.errors).toEqual(['since: cannot read the date “someday”'])
    expect(isEmptySearch(parseSearch('  author: ', NOW))).toBe(true)
    expect(isEmptySearch(s)).toBe(false)
  })
})

describe('matchCommit', () => {
  const match = (q: string, c = commit()) => matchCommit(parseSearch(q, NOW), c)

  it('matches plain text against message, author, sha and refs', () => {
    expect(match('login')).toBe(true)
    expect(match('details')).toBe(true)
    expect(match('ann@')).toBe(true)
    expect(match('abc12')).toBe(true)
    expect(match('heads/main')).toBe(true)
    expect(match('logout')).toBe(false)
  })

  it('narrows by field: all fields must match, values of one field are alternatives', () => {
    expect(match('author:ann message:login')).toBe(true)
    expect(match('author:bob message:login')).toBe(false)
    expect(match('author:bob author:ann')).toBe(true)
    expect(match('message:ann')).toBe(false)
    expect(match('sha:ABC1')).toBe(true)
    expect(match('sha:bc1')).toBe(false)
  })

  it('compares since and until with the committer date', () => {
    const old = commit({ date: new Date(2026, 0, 15).getTime() })
    expect(match('since:2026-01-15', old)).toBe(true)
    expect(match('since:2026-01-16', old)).toBe(false)
    expect(match('until:2026-01-15', old)).toBe(true)
    expect(match('until:2026-01-14', old)).toBe(false)
    expect(match('since:2w')).toBe(true)
    expect(match('since:2w', old)).toBe(false)
  })

  it('leaves path and content to the backend', () => {
    expect(match('path:src content:x')).toBe(true)
  })
})

describe('matchStash', () => {
  it('matches text and message only', () => {
    expect(matchStash(parseSearch('wip'), 'WIP on main')).toBe(true)
    expect(matchStash(parseSearch('message:wip'), 'WIP on main')).toBe(true)
    expect(matchStash(parseSearch('author:ann'), 'WIP on main')).toBe(false)
    expect(matchStash(parseSearch('wip path:src'), 'WIP on main')).toBe(false)
  })
})

describe('highlightTerm', () => {
  it('marks plain text first, then the first message value', () => {
    expect(highlightTerm(parseSearch('Login author:x'))).toBe('login')
    expect(highlightTerm(parseSearch('message:Fix'))).toBe('fix')
    expect(highlightTerm(parseSearch('author:x'))).toBe('')
  })
})

describe('prefix suggestions', () => {
  it('lists every prefix in an empty box and the ones completing the word at the caret', () => {
    expect(suggestPrefixes('', 0)).toHaveLength(7)
    expect(suggestPrefixes('fix au', 6).map((p) => p.field)).toEqual(['author'])
    expect(suggestPrefixes('s', 1).map((p) => p.field)).toEqual(['sha', 'since'])
    expect(suggestPrefixes('fix ', 4)).toEqual([])
    expect(suggestPrefixes('author:s', 8)).toEqual([])
    expect(suggestPrefixes('zz', 2)).toEqual([])
  })

  it('replaces the word at the caret with the prefix', () => {
    expect(completePrefix('fix au', 6, 'author')).toEqual({ value: 'fix author:', caret: 11 })
    expect(completePrefix('si login', 2, 'since')).toEqual({ value: 'since: login', caret: 6 })
    expect(completePrefix('', 0, 'path')).toEqual({ value: 'path:', caret: 5 })
  })
})
