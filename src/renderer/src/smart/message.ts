// Commit message helpers for the composer: lint warnings, Conventional Commits prefixes and scopes, trailers
// (Co-authored-by), commit.template drafts and the per-repo message history. Pure functions only.

/** Summary length that starts to be long (counter turns amber) and the limit the lint warns about. */
export const SUMMARY_SOFT_LIMIT = 50
export const SUMMARY_LIMIT = 72
export const HISTORY_LIMIT = 20

export const CONVENTIONAL_TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'style', 'perf', 'ci', 'build', 'revert'] as const

export type LintRule = 'title-length' | 'title-period' | 'blank-line' | 'conventional'

export interface LintWarning {
  rule: LintRule
  message: string
}

/** The message as git will store it with --cleanup=strip: comment lines and leading blank lines dropped. */
function stripped(message: string): string[] {
  const lines = message.replace(/\r/g, '').split('\n').filter((l) => !l.startsWith('#'))
  while (lines.length && !lines[0].trim()) lines.shift()
  return lines
}

/**
 * Style warnings for a commit message (never a reason to refuse the commit): a title over 72 characters, a title
 * ending with a period, no blank line between the title and the body and, with `conventional`, a title that is not
 * `type(scope): description`.
 */
export function lintCommitMessage(message: string, opts: { conventional?: boolean } = {}): LintWarning[] {
  const lines = stripped(message)
  const title = (lines[0] ?? '').trimEnd()
  if (!title) return []
  const out: LintWarning[] = []
  if (title.length > SUMMARY_LIMIT) out.push({ rule: 'title-length', message: `Summary is ${title.length} characters; keep it within ${SUMMARY_LIMIT}.` })
  if (/[^.]\.$/.test(title) || title === '.') out.push({ rule: 'title-period', message: 'Summary ends with a period.' })
  if (lines.length > 1 && lines[1].trim()) out.push({ rule: 'blank-line', message: 'Leave a blank line between the summary and the description.' })
  if (opts.conventional && !parseConventional(title))
    out.push({ rule: 'conventional', message: 'Summary is not in Conventional Commits form: type(scope): description.' })
  return out
}

// ------------------------------------------------------------- conventional

export interface ConventionalTitle {
  type: string
  scope: string
  breaking: boolean
  subject: string
}

const CONVENTIONAL_RE = /^([a-z]+)(?:\(([^()]*)\))?(!)?: (.*)$/i

/** Split `type(scope)!: subject`; null when the title is not in that form. */
export function parseConventional(title: string): ConventionalTitle | null {
  const m = CONVENTIONAL_RE.exec(title)
  if (!m) return null
  return { type: m[1].toLowerCase(), scope: m[2] ?? '', breaking: !!m[3], subject: m[4] }
}

/**
 * Rewrite a title's Conventional Commits prefix, keeping its subject (and a "!" breaking marker). An empty type
 * removes the prefix; a title without one gets it in front.
 */
export function withConventional(title: string, next: { type: string; scope: string }): string {
  const current = parseConventional(title)
  const subject = current ? current.subject : title.trimStart()
  if (!next.type) return subject
  const scope = next.scope.trim()
  return `${next.type}${scope ? `(${scope})` : ''}${current?.breaking ? '!' : ''}: ${subject}`
}

/** Scope suggestions: the top-level folders of the changed files, most files first. Files at the root suggest none. */
export function scopesFromPaths(paths: string[]): string[] {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const slash = p.indexOf('/')
    if (slash <= 0) continue
    const dir = p.slice(0, slash)
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([dir]) => dir)
}

// ----------------------------------------------------------------- trailers

const TRAILER_RE = /^[A-Za-z][\w-]*: \S/

export function coAuthorTrailer(author: { name: string; email: string }): string {
  return `Co-authored-by: ${author.name} <${author.email}>`
}

/**
 * Add a trailer line (e.g. "Co-authored-by: Ann <ann@x.io>") to a commit description: into the trailer block that ends
 * it, or as a new paragraph. A trailer already present (by key and value, ignoring case) is not added twice.
 */
export function addTrailer(description: string, trailer: string): string {
  const lines = description.replace(/\r/g, '').replace(/\s+$/, '').split('\n')
  if (lines.some((l) => l.trim().toLowerCase() === trailer.toLowerCase())) return description
  const text = lines.join('\n')
  if (!text.trim()) return trailer
  // the last paragraph, ignoring comment lines git strips
  const last = text.split(/\n\s*\n/).pop()!.split('\n').filter((l) => !l.startsWith('#'))
  const inTrailers = last.length > 0 && last.every((l) => TRAILER_RE.test(l))
  return `${text}${inTrailers ? '\n' : '\n\n'}${trailer}`
}

// -------------------------------------------------------- drafts & history

/** A draft from `commit.template`: its first line is the summary unless it is a comment; the rest is the description. */
export function templateDraft(template: string): { summary: string; description: string } {
  const lines = template.replace(/\r/g, '').split('\n')
  const first = lines[0] ?? ''
  const isSummary = !first.startsWith('#')
  const rest = (isSummary ? lines.slice(1) : lines).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return { summary: isSummary ? first : '', description: rest }
}

/** A message as `git commit --cleanup=strip` stores it: no comment lines, trailing spaces or repeated blank lines. */
export function cleanMessage(message: string): string {
  return stripped(message)
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Put a committed message (cleaned up) at the front of the history, without duplicates, keeping the latest `limit`. */
export function rememberMessage(history: string[], message: string, limit = HISTORY_LIMIT): string[] {
  const m = cleanMessage(message)
  if (!m) return history
  return [m, ...history.filter((h) => h !== m)].slice(0, limit)
}
