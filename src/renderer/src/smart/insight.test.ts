import { describe, expect, it } from 'vitest'
import type { PullRequest } from '@shared/integrations'
import { buildReviewPrompt, buildSummaryPrompt, cleanReport, omissionNote } from './insight'

const diff = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}\n`

const pr: PullRequest = {
  number: 12,
  title: 'Add retries',
  body: 'Retries 503s.',
  url: 'https://x/pr/12',
  author: 'ann',
  draft: false,
  headBranch: 'retry',
  headRepo: null,
  sameRepo: true,
  baseBranch: 'main',
  updatedAt: '',
  checks: null,
  reviewers: [],
  reviewRequested: false,
  mine: false
}

describe('summary prompt', () => {
  it('lists every commit with its message and diff, and notes skipped generated files', () => {
    const { prompt, omissions } = buildSummaryPrompt([
      { sha: 'aaaaaaaa1', author: 'Ann', message: 'feat: one', diff: diff('src/a.ts', 'one') + diff('package-lock.json', 'x') },
      { sha: 'bbbbbbbb2', author: 'Bo', message: 'fix: two', diff: '' }
    ])
    expect(prompt).toContain('### aaaaaaa by Ann\nfeat: one')
    expect(prompt).toContain('+one')
    expect(prompt).toContain('### bbbbbbb by Bo\nfix: two\n\n(no file changes)')
    expect(prompt).not.toContain('package-lock')
    expect(omissions.generated).toEqual(['package-lock.json'])
  })
})

describe('review prompt', () => {
  it('carries the PR, its commits, the stat and the diff', () => {
    const { prompt } = buildReviewPrompt(pr, { targetExists: true, commits: ['feat: retry'], stat: ' a.ts | 2 +-', diff: diff('a.ts', 'retry()') })
    expect(prompt).toContain('#12: Add retries')
    expect(prompt).toContain('Merging retry into main')
    expect(prompt).toContain('Retries 503s.')
    expect(prompt).toContain('- feat: retry')
    expect(prompt).toContain('+retry()')
    expect(prompt).toContain('## Verdict')
  })

  it('says when there is no description', () => {
    expect(buildReviewPrompt({ ...pr, body: ' ' }, { targetExists: true, commits: [], stat: '', diff: '' }).prompt).toContain('(no description)')
  })
})

describe('cleanReport', () => {
  it('drops reasoning, a lead-in and an outer fence', () => {
    expect(cleanReport('<think>hm</think>Here is the summary:\n## Overview\nx')).toBe('## Overview\nx')
    expect(cleanReport('```markdown\n## A\n- b\n```')).toBe('## A\n- b')
    expect(cleanReport('  ')).toBeNull()
  })
})

describe('omissionNote', () => {
  it('names what the AI did not see', () => {
    expect(omissionNote({ generated: [], omitted: [] })).toBeNull()
    expect(omissionNote({ generated: ['yarn.lock'], omitted: ['a', 'b', 'c', 'd', 'd'] })).toBe(
      'Not shown to the AI to fit its input: a, b, c and 1 more; generated files skipped: yarn.lock.'
    )
  })
})
