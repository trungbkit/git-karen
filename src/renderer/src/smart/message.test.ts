import { describe, expect, it } from 'vitest'
import {
  addTrailer,
  coAuthorTrailer,
  HISTORY_LIMIT,
  lintCommitMessage,
  parseConventional,
  rememberMessage,
  scopesFromPaths,
  templateDraft,
  withConventional
} from './message'

const rules = (message: string, conventional = false) => lintCommitMessage(message, { conventional }).map((w) => w.rule)

describe('lintCommitMessage', () => {
  it('accepts a well-formed message', () => {
    expect(rules('fix(api): retry on 503\n\nThe gateway returns 503 during deploys.')).toEqual([])
    expect(rules('')).toEqual([])
  })

  it('warns about a long summary', () => {
    expect(rules('x'.repeat(72))).toEqual([])
    const [w] = lintCommitMessage('x'.repeat(73))
    expect(w).toEqual({ rule: 'title-length', message: 'Summary is 73 characters; keep it within 72.' })
  })

  it('warns about a trailing period but not an ellipsis', () => {
    expect(rules('Fix the bug.')).toEqual(['title-period'])
    expect(rules('Wait for it...')).toEqual([])
  })

  it('warns about a missing blank line after the summary', () => {
    expect(rules('Fix the bug\nbecause it was broken')).toEqual(['blank-line'])
    expect(rules('Fix the bug\n\nbecause it was broken')).toEqual([])
  })

  it('ignores comment lines and leading blank lines, as git --cleanup=strip does', () => {
    expect(rules('# Please enter the message\n\nFix the bug\n# comment\n\nbody')).toEqual([])
    expect(rules('# only a comment')).toEqual([])
  })

  it('checks the Conventional Commits form only when asked', () => {
    expect(rules('Fix the bug')).toEqual([])
    expect(rules('Fix the bug', true)).toEqual(['conventional'])
    expect(rules('fix(ui)!: drop the old dialog', true)).toEqual([])
  })
})

describe('conventional titles', () => {
  it('parses type, scope, breaking marker and subject', () => {
    expect(parseConventional('feat(auth)!: add SSO')).toEqual({ type: 'feat', scope: 'auth', breaking: true, subject: 'add SSO' })
    expect(parseConventional('Fix: typo')).toEqual({ type: 'fix', scope: '', breaking: false, subject: 'typo' })
    expect(parseConventional('Add SSO')).toBeNull()
    expect(parseConventional('feat:no space')).toBeNull()
  })

  it('rewrites the prefix and keeps the subject', () => {
    expect(withConventional('add SSO', { type: 'feat', scope: 'auth' })).toBe('feat(auth): add SSO')
    expect(withConventional('feat(auth): add SSO', { type: 'fix', scope: '' })).toBe('fix: add SSO')
    expect(withConventional('feat(auth)!: add SSO', { type: 'feat', scope: ' api ' })).toBe('feat(api)!: add SSO')
    expect(withConventional('feat(auth): add SSO', { type: '', scope: 'auth' })).toBe('add SSO')
    expect(withConventional('', { type: 'chore', scope: '' })).toBe('chore: ')
  })

  it('suggests top-level folders as scopes, most files first', () => {
    expect(scopesFromPaths(['src/a.ts', 'docs/x.md', 'src/b/c.ts', 'README.md', 'docs/y.md', 'api/z.go'])).toEqual(['docs', 'src', 'api'])
    expect(scopesFromPaths(['README.md'])).toEqual([])
  })
})

describe('addTrailer', () => {
  const ann = coAuthorTrailer({ name: 'Ann Lee', email: 'ann@x.io' })

  it('formats a co-author trailer', () => {
    expect(ann).toBe('Co-authored-by: Ann Lee <ann@x.io>')
  })

  it('starts the description, or a new paragraph after prose', () => {
    expect(addTrailer('', ann)).toBe(ann)
    expect(addTrailer('  \n', ann)).toBe(ann)
    expect(addTrailer('Explains the change.\n', ann)).toBe(`Explains the change.\n\n${ann}`)
  })

  it('joins an existing trailer block', () => {
    expect(addTrailer('Body.\n\nSigned-off-by: Me <me@x.io>', ann)).toBe(`Body.\n\nSigned-off-by: Me <me@x.io>\n${ann}`)
    expect(addTrailer('Refs: #12', ann)).toBe(`Refs: #12\n${ann}`)
  })

  it('does not add a trailer twice', () => {
    const d = `Body.\n\n${ann}`
    expect(addTrailer(d, ann.toLowerCase())).toBe(d)
  })

  it('ignores comment lines when finding the trailer block', () => {
    expect(addTrailer('Refs: #1\n# a comment', ann)).toBe(`Refs: #1\n# a comment\n${ann}`)
  })
})

describe('templateDraft', () => {
  it('splits a template into summary and description', () => {
    expect(templateDraft('feat: \n\n# Why is this needed?\n')).toEqual({ summary: 'feat: ', description: '# Why is this needed?' })
    expect(templateDraft('# What changed?\n\n# Why?\n')).toEqual({ summary: '', description: '# What changed?\n\n# Why?' })
  })
})

describe('rememberMessage', () => {
  it('keeps the latest messages first without duplicates', () => {
    expect(rememberMessage(['b', 'a'], ' a \n')).toEqual(['a', 'b'])
    expect(rememberMessage(['a'], '  ')).toEqual(['a'])
    expect(rememberMessage([], 'feat: x  \n\n# Why?\nbecause\n\n\n\nmore\n')).toEqual(['feat: x\n\nbecause\n\nmore'])
    expect(rememberMessage(['a'], '# only a comment')).toEqual(['a'])
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => `m${i}`)
    const next = rememberMessage(full, 'new')
    expect(next).toHaveLength(HISTORY_LIMIT)
    expect(next[0]).toBe('new')
    expect(next).not.toContain(`m${HISTORY_LIMIT - 1}`)
  })
})
