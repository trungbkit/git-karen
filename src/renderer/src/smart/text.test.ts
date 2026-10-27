import { describe, expect, it } from 'vitest'
import type { SmartStatus } from '@shared/types'
import {
  buildHumanPrDescription,
  buildHumanPrTitle,
  buildPrContext,
  buildPrDescriptionPrompt,
  commitDiffText,
  condenseDiff,
  contextKey,
  hasPrMaterial,
  parseBranchList,
  parseCommitMessage,
  resolvePlan,
  sanitizePrDescription,
  sanitizeTitle,
  type SmartIntent
} from './text'

const fileDiff = (path: string, lines: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n` +
  Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n') +
  '\n'

describe('condenseDiff', () => {
  it('drops generated files and keeps small diffs whole', () => {
    const diff = fileDiff('package-lock.json', 50) + fileDiff('src/a.ts', 3)
    const c = condenseDiff(diff)
    expect(c.generated).toEqual(['package-lock.json'])
    expect(c.diff).toBe(fileDiff('src/a.ts', 3))
  })

  it('falls back to generated files when nothing else changed', () => {
    const diff = fileDiff('yarn.lock', 2)
    expect(condenseDiff(diff)).toEqual({ diff, generated: [], omitted: [] })
  })

  it('caps every file and omits what no longer fits', () => {
    const diff = fileDiff('a.ts', 100) + fileDiff('b.ts', 100) + fileDiff('c.ts', 100)
    const c = condenseDiff(diff, { maxLines: 120, maxLinesPerFile: 60 })
    expect(c.diff).toContain('more changed lines in a.ts')
    expect(c.diff).toContain('more changed lines in b.ts')
    expect(c.omitted).toEqual(['c.ts'])
  })
})

describe('commitDiffText', () => {
  it('names new files, skipping generated ones', () => {
    const text = commitDiffText({ diff: fileDiff('a.ts', 1), untracked: ['src/new.ts', 'dist/bundle.js'] })
    expect(text).toContain('+++ b/src/new.ts (new file)')
    expect(text).not.toContain('dist/bundle.js')
  })
})

describe('sanitizeTitle', () => {
  it('strips fences, preambles, labels, quotes and trailing periods', () => {
    expect(sanitizeTitle('Sure, here is the title:\n```\n"Feat(Auth): add SSO login."\n```')).toBe('feat(auth): add SSO login')
    expect(sanitizeTitle('<think>hmm</think>PR title: fix(api): handle nulls')).toBe('fix(api): handle nulls')
    expect(sanitizeTitle('- ## chore: bump deps')).toBe('chore: bump deps')
  })

  it('rejects refusals and fragments', () => {
    expect(sanitizeTitle("I can't help with that")).toBeNull()
    expect(sanitizeTitle('ok')).toBeNull()
    expect(sanitizeTitle('')).toBeNull()
  })

  it('cuts long titles at a word boundary', () => {
    const t = sanitizeTitle('feat: ' + 'word '.repeat(30))!
    expect(t.length).toBeLessThanOrEqual(72)
    expect(t.endsWith('word')).toBe(true)
  })
})

describe('parseCommitMessage', () => {
  it('keeps the title and description', () => {
    expect(parseCommitMessage('Here is the message:\n\nFix(Api): retry on 503\n\n\n\nThe gateway returns 503.\n')).toBe(
      'fix(api): retry on 503\n\nThe gateway returns 503.'
    )
  })

  it('returns a bare title for trivial changes and null for garbage', () => {
    expect(parseCommitMessage('docs(readme): fix typo')).toBe('docs(readme): fix typo')
    expect(parseCommitMessage('Sorry, I cannot do that')).toBeNull()
  })
})

describe('sanitizePrDescription', () => {
  it('unwraps a fence around the whole reply and drops preambles', () => {
    const raw = "Here's the description:\n```markdown\n## Summary\n\nAdds retries.\n\n```js\nx()\n```\n```"
    expect(sanitizePrDescription(raw)).toBe('## Summary\n\nAdds retries.\n\n```js\nx()\n```')
    expect(sanitizePrDescription('too short')).toBeNull()
  })
})

describe('human fallbacks', () => {
  it('builds titles from the commit, the commits, then the branch', () => {
    expect(buildHumanPrTitle('main', 'Feat(x): add y\n\nbody', 'feature/z')).toBe('feat(x): add y')
    expect(buildHumanPrTitle('main', null, 'feature/z', ['update docs'])).toBe('Update docs')
    expect(buildHumanPrTitle('main', null, 'feature/login-form')).toBe('Login form')
    expect(buildHumanPrTitle('main', null, null)).toBe('Merge changes into main')
  })

  it('lists commit subjects in the description', () => {
    const c = buildPrContext('topic', 'main', { targetExists: true, commits: ['a', 'b'], stat: '', diff: '' }, { diff: '', commitMessage: 'c', untracked: [] })
    expect(buildHumanPrDescription(c)).toBe('## Summary\n\nc\n\n## Changes\n\n- c\n- a\n- b')
  })
})

describe('PR contexts', () => {
  const comparison = { targetExists: true, commits: ['feat: a'], stat: ' a | 1 +', diff: fileDiff('a.ts', 1) }

  it('share a key when the material is identical', () => {
    const pending = { diff: '', commitMessage: null, untracked: [] }
    const uat = buildPrContext('topic', 'uat', comparison, pending)
    const main = buildPrContext('topic', 'main', comparison, pending)
    expect(contextKey(uat)).toBe(contextKey(main))
    expect(contextKey(buildPrContext('topic', 'main', { ...comparison, commits: [] }, pending))).not.toBe(contextKey(uat))
  })

  it('knows when there is nothing to describe', () => {
    const empty = buildPrContext('topic', 'main', { targetExists: false, commits: [], stat: '', diff: '' }, { diff: '', commitMessage: null, untracked: [] })
    expect(hasPrMaterial(empty)).toBe(false)
  })

  it('fills in a repository template', () => {
    const c = buildPrContext('topic', 'main', comparison, { diff: '', commitMessage: null, untracked: [] })
    expect(buildPrDescriptionPrompt(c, { path: '.github/pull_request_template.md', content: '## Why' })).toContain('````markdown\n## Why\n````')
    expect(buildPrDescriptionPrompt(c)).toContain('## How to test')
  })
})

describe('resolvePlan', () => {
  const all: SmartIntent = { stage: true, commit: true, push: true, pr: true }
  const status = (patch: Partial<SmartStatus>): SmartStatus => ({
    branch: 'topic',
    remote: 'origin',
    hasCommits: true,
    unstaged: false,
    untracked: false,
    staged: false,
    unpushed: false,
    gh: true,
    ...patch
  })

  it('runs every step in a dirty tree', () => {
    const p = resolvePlan(all, status({ unstaged: true }))
    expect(p.run).toEqual({ stage: true, commit: true, push: true, pr: true })
    expect(p.caveats).toEqual([])
  })

  it('only opens the PR on a clean, pushed branch', () => {
    const p = resolvePlan(all, status({}))
    expect(p.run).toEqual({ stage: false, commit: false, push: false, pr: true })
    expect(p.reasons).toMatchObject({ stage: 'working tree clean', commit: 'nothing staged', push: 'origin already up to date' })
  })

  it('commits only the index when staging is off, and says what is left behind', () => {
    const p = resolvePlan({ ...all, stage: false }, status({ staged: true, untracked: true }))
    expect(p.run).toMatchObject({ stage: false, commit: true, push: true })
    expect(p.caveats).toEqual(['Unstaged and new files are left out of the commit.'])
  })

  it('never stages without committing', () => {
    const p = resolvePlan({ ...all, commit: false }, status({ unstaged: true, unpushed: true }))
    expect(p.run).toMatchObject({ stage: false, commit: false, push: true })
    expect(p.reasons.stage).toBe('turned off')
  })

  it('warns when a commit stays local', () => {
    const p = resolvePlan({ ...all, push: false }, status({ staged: true }))
    expect(p.caveats).toContain('The new commit stays local — nothing will be pushed.')
  })

  it('cannot push or open PRs without a remote or gh', () => {
    expect(resolvePlan(all, status({ remote: null, staged: true })).reasons).toMatchObject({ push: 'no remote', pr: 'no remote' })
    expect(resolvePlan(all, status({ gh: false })).reasons.pr).toBe('GitHub CLI (gh) not installed')
  })
})

it('parses branch lists', () => {
  expect(parseBranchList(' uat, main,,uat ')).toEqual(['uat', 'main'])
})
