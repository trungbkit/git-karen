// Commit search syntax of the graph search box. `author:`, `message:`, `sha:`, `since:` and `until:` filter the loaded
// commits right away; `path:` and `content:` (git log -S) need the history, so the backend answers them.
// Text without a prefix matches message, author, sha and ref names, as the plain search always did.
// Different fields must all match; several values of one field match any of them (`author:ann author:bob`).
import type { Commit } from '@shared/types'

export type SearchField = 'author' | 'message' | 'path' | 'content' | 'sha' | 'since' | 'until'

export const SEARCH_PREFIXES: { field: SearchField; hint: string }[] = [
  { field: 'author', hint: 'author name or email' },
  { field: 'message', hint: 'commit message' },
  { field: 'path', hint: 'touches a file or folder (globs work)' },
  { field: 'content', hint: 'adds or removes text (git log -S)' },
  { field: 'sha', hint: 'commit sha prefix' },
  { field: 'since', hint: 'on or after: 2026-01-31, 2w, yesterday' },
  { field: 'until', hint: 'on or before: 2026-01-31, 3d, today' }
]

const FIELDS = new Set<string>(SEARCH_PREFIXES.map((p) => p.field))

export interface SearchToken {
  /** null for text without a prefix */
  field: SearchField | null
  value: string
  /** Position in the input, end exclusive */
  start: number
  end: number
}

export interface CommitSearch {
  /** Text without a prefix, lower case */
  text: string
  author: string[]
  message: string[]
  sha: string[]
  path: string[]
  content: string[]
  /** Unix epoch milliseconds; when given several times the last one counts */
  since: number | null
  until: number | null
  /** Values that could not be read, e.g. a date */
  errors: string[]
}

/** Split the input into prefixed and plain tokens. `"…"` quotes a value with spaces; an unknown prefix is plain text. */
export function tokenize(input: string): SearchToken[] {
  const tokens: SearchToken[] = []
  let i = 0
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i++
      continue
    }
    const start = i
    const prefix = /^([a-z]+):/i.exec(input.slice(i))
    let field: SearchField | null = null
    if (prefix && FIELDS.has(prefix[1].toLowerCase())) {
      field = prefix[1].toLowerCase() as SearchField
      i += prefix[0].length
    }
    let value: string
    if (input[i] === '"') {
      const close = input.indexOf('"', i + 1)
      const end = close === -1 ? input.length : close
      value = input.slice(i + 1, end)
      i = close === -1 ? input.length : close + 1
    } else {
      const m = /^\S*/.exec(input.slice(i))![0]
      value = m
      i += m.length
    }
    tokens.push({ field, value, start, end: i })
  }
  return tokens
}

const DAY = 86_400_000

/** A date for since/until: YYYY-MM-DD (or YYYY-MM, YYYY), today, yesterday, or an age like 3d / 2w / 6m / 1y / 12h. */
export function parseDate(value: string, edge: 'start' | 'end', now = Date.now()): number | null {
  const v = value.trim().toLowerCase()
  const dayEdge = (d: Date) => (edge === 'start' ? d.setHours(0, 0, 0, 0) : d.setHours(23, 59, 59, 999))
  if (v === 'today' || v === 'yesterday') {
    const d = new Date(now - (v === 'yesterday' ? DAY : 0))
    return dayEdge(d)
  }
  const age = /^(\d+)\s*(h|d|w|m|y)$/.exec(v)
  if (age) {
    const n = Number(age[1])
    const d = new Date(now)
    if (age[2] === 'h') return now - n * 3_600_000
    if (age[2] === 'd') return now - n * DAY
    if (age[2] === 'w') return now - n * 7 * DAY
    if (age[2] === 'm') d.setMonth(d.getMonth() - n)
    else d.setFullYear(d.getFullYear() - n)
    return d.getTime()
  }
  const date = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(v)
  if (!date) return null
  const [y, m, d] = [Number(date[1]), date[2] ? Number(date[2]) - 1 : null, date[3] ? Number(date[3]) : null]
  if ((m !== null && (m < 0 || m > 11)) || (d !== null && (d < 1 || d > 31))) return null
  if (edge === 'start') return new Date(y, m ?? 0, d ?? 1).getTime()
  // the end of the day, month or year given
  const next = d !== null ? new Date(y, m!, d + 1) : m !== null ? new Date(y, m + 1, 1) : new Date(y + 1, 0, 1)
  return next.getTime() - 1
}

export function parseSearch(input: string, now = Date.now()): CommitSearch {
  const s: CommitSearch = { text: '', author: [], message: [], sha: [], path: [], content: [], since: null, until: null, errors: [] }
  const text: string[] = []
  for (const t of tokenize(input)) {
    // a prefix without a value yet (still typing) filters nothing
    if (!t.value && t.field) continue
    if (t.field === null) text.push(t.value)
    else if (t.field === 'since' || t.field === 'until') {
      const ms = parseDate(t.value, t.field === 'since' ? 'start' : 'end', now)
      if (ms === null) s.errors.push(`${t.field}: cannot read the date “${t.value}”`)
      else s[t.field] = ms
    } else if (t.field === 'path' || t.field === 'content') s[t.field].push(t.value)
    else s[t.field].push(t.value.toLowerCase())
  }
  s.text = text.join(' ').toLowerCase()
  return s
}

export function isEmptySearch(s: CommitSearch): boolean {
  return !s.text && !s.author.length && !s.message.length && !s.sha.length && !needsBackend(s) && s.since === null && s.until === null
}

/** `path:` and `content:` are answered by `git log` (window.git.searchLog). */
export function needsBackend(s: CommitSearch): boolean {
  return s.path.length > 0 || s.content.length > 0
}

const anyIn = (values: string[], text: string) => values.length === 0 || values.some((v) => text.includes(v))

/** Whether a commit passes the filters that need no history (`backend` results are checked by the caller). */
export function matchCommit(s: CommitSearch, c: Commit): boolean {
  if (s.text) {
    const all = `${c.summary}\n${c.body}\n${c.author.name}\n${c.author.email}\n${c.sha}\n${c.refs.join(' ')}`.toLowerCase()
    if (!all.includes(s.text)) return false
  }
  if (!anyIn(s.author, `${c.author.name}\n${c.author.email}`.toLowerCase())) return false
  if (!anyIn(s.message, `${c.summary}\n${c.body}`.toLowerCase())) return false
  if (s.sha.length && !s.sha.some((p) => c.sha.startsWith(p))) return false
  // like git log --since/--until: the committer date
  if (s.since !== null && c.committer.date < s.since) return false
  if (s.until !== null && c.committer.date > s.until) return false
  return true
}

/** A stash row matches plain text and `message:` only. */
export function matchStash(s: CommitSearch, message: string): boolean {
  if (s.author.length || s.sha.length || needsBackend(s) || s.since !== null || s.until !== null) return false
  const m = message.toLowerCase()
  return (!s.text || m.includes(s.text)) && anyIn(s.message, m)
}

/** Text to mark in commit summaries. */
export function highlightTerm(s: CommitSearch): string {
  return s.text || s.message[0] || ''
}

/** Prefixes that complete the word at the caret; all of them while the box is empty. */
export function suggestPrefixes(input: string, caret: number): { field: SearchField; hint: string }[] {
  if (!input.trim()) return SEARCH_PREFIXES
  const word = /(\S*)$/.exec(input.slice(0, caret))![1].toLowerCase()
  // between words, inside a value, or after a complete prefix
  if (!word || word.includes(':') || word.includes('"')) return []
  return SEARCH_PREFIXES.filter((p) => p.field.startsWith(word))
}

/** Replace the word at the caret with `field:`; returns the new input and caret. */
export function completePrefix(input: string, caret: number, field: SearchField): { value: string; caret: number } {
  const start = caret - /(\S*)$/.exec(input.slice(0, caret))![1].length
  const value = `${input.slice(0, start)}${field}:${input.slice(caret)}`
  return { value, caret: start + field.length + 1 }
}
