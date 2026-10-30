// AI write-ups that are read rather than committed: a summary of selected commits and a review of a pull request.
// Pure functions only (prompts and reply cleanup); ./assist.ts does the git and AI calls.
import type { BranchComparison, CommitPatch } from '@shared/types'
import type { PullRequest } from '@shared/integrations'
import { condenseDiff } from './text'

export const SUMMARY_MAX_TOKENS = 1500
export const REVIEW_MAX_TOKENS = 4000

/** Diff lines shared by every commit of a summary; each commit gets at least SUMMARY_MIN_LINES. */
const SUMMARY_DIFF_LINES = 5000
const SUMMARY_MIN_LINES = 80

/** What was left out of the prompt to fit it, for a note under the write-up. */
export interface Omissions {
  generated: string[]
  omitted: string[]
}

export interface BuiltPrompt {
  prompt: string
  omissions: Omissions
}

const FORMAT_RULES = `Formatting: Markdown with "## " headings, "- " bullets, **bold** and \`code\` for file paths and identifiers. No tables, no code fences around the whole reply, no preamble or closing remarks.`

/** Commits oldest first, as listed by the caller. */
export function buildSummaryPrompt(commits: CommitPatch[]): BuiltPrompt {
  const perCommit = Math.max(SUMMARY_MIN_LINES, Math.floor(SUMMARY_DIFF_LINES / Math.max(1, commits.length)))
  const omissions: Omissions = { generated: [], omitted: [] }
  const sections = commits.map((c) => {
    const condensed = condenseDiff(c.diff, { maxLines: perCommit, maxLinesPerFile: Math.min(300, perCommit) })
    omissions.generated.push(...condensed.generated)
    omissions.omitted.push(...condensed.omitted)
    const diff = condensed.diff.trim() ? `\`\`\`diff\n${condensed.diff.trimEnd()}\n\`\`\`` : '(no file changes)'
    return `### ${c.sha.slice(0, 7)} by ${c.author}\n${c.message}\n\n${diff}`
  })
  const prompt = `You are a senior engineer explaining a set of git commits to a teammate who has not read them. Summarize what changed across ALL of the commits below, taken together.

## Commits (oldest first)

${sections.join('\n\n')}

## What to write
1. "## Overview": two or three sentences on what these commits achieve as a whole and why.
2. "## Changes": the changes grouped by area or feature (not commit by commit), one bullet each. Describe behaviour and intent; mention files only when it helps.
3. "## Worth a look": breaking changes, migrations, config or dependency changes, risky or surprising edits, missing tests. Leave this section out entirely when there is nothing worth flagging.

Be concise and concrete. Describe only what the diffs show; do not guess at changes you cannot see.
${FORMAT_RULES}`
  return { prompt, omissions }
}

export function buildReviewPrompt(pr: PullRequest, comparison: BranchComparison): BuiltPrompt {
  const condensed = condenseDiff(comparison.diff, { maxLines: 6000, maxLinesPerFile: 500 })
  const commits = comparison.commits.length ? comparison.commits.map((s) => `- ${s}`).join('\n') : '(none listed)'
  const prompt = `You are an experienced code reviewer. Review the pull request below the way a careful senior teammate would.

## Pull request #${pr.number}: ${pr.title}
Author: ${pr.author}
Merging ${pr.headBranch} into ${pr.baseBranch}${pr.draft ? ' (draft)' : ''}

### Description
${pr.body.trim() || '(no description)'}

### Commits
${commits}

### Files changed
\`\`\`
${comparison.stat}
\`\`\`

### Diff
\`\`\`diff
${condensed.diff.trimEnd()}
\`\`\`

## What to write
1. "## Summary": two or three sentences on what the PR does, and whether it does what its description says.
2. "## Findings": one bullet per real problem, most severe first, in the form:
   - **blocker|major|minor|nit** \`path/to/file:line\` — the problem, why it matters, and a concrete fix
   Look for bugs, unhandled edge cases and errors, security issues, data loss, race conditions, performance traps, breaking API changes and missing tests. Write "No issues found." when there are none; never pad the list or repeat a finding.
3. "## Verdict": one of **Approve**, **Approve with suggestions** or **Request changes**, with a one-sentence reason.

Only comment on what the diff shows; if something cannot be judged without code you cannot see, say so instead of guessing. Lines starting with "+" are added, "-" removed.
${FORMAT_RULES}`
  return { prompt, omissions: { generated: condensed.generated, omitted: condensed.omitted } }
}

/** The write-up without reasoning blocks, a "Sure, here is…" lead-in or fences around the whole reply; null when empty. */
export function cleanReport(raw: string | null | undefined): string | null {
  if (!raw) return null
  let text = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\r/g, '').trim()
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/i.exec(text)
  if (fenced) text = fenced[1].trim()
  const lines = text.split('\n')
  if (lines.length > 1 && /^(sure|okay|ok|here('s| is)|certainly|below is)\b.*:$/i.test(lines[0].trim())) text = lines.slice(1).join('\n').trim()
  return text || null
}

/** A one-line note about what the AI did not see, or null. */
export function omissionNote(o: Omissions): string | null {
  const parts: string[] = []
  const list = (paths: string[]) => {
    const unique = [...new Set(paths)]
    return unique.length > 3 ? `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more` : unique.join(', ')
  }
  if (o.omitted.length) parts.push(`not shown to the AI to fit its input: ${list(o.omitted)}`)
  if (o.generated.length) parts.push(`generated files skipped: ${list(o.generated)}`)
  if (!parts.length) return null
  const text = parts.join('; ')
  return text[0].toUpperCase() + text.slice(1) + '.'
}
