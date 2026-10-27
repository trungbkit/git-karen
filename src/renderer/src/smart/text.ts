// Smart commit text logic, ported from git-smart-commit: diff condensing, AI prompts for commit messages and pull
// request titles/descriptions, sanitizers for the replies, human fallbacks, and the stage -> commit -> push -> PR plan.
// Pure functions only; ./workflow.ts does the git and AI calls.
import type { BranchComparison, PendingDiff, PrTemplate, SmartStatus } from '@shared/types'

// ------------------------------------------------------------------ diffs

/**
 * Files whose diffs are machine-generated: huge, dominating the token budget, and saying nothing about intent.
 * Dropping them is what stops titles like "chore: update package-lock.json".
 */
const GENERATED_FILE_PATTERNS = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum|Podfile\.lock)$/i,
  /(^|\/)(dist|build|out|vendor|node_modules|coverage|__snapshots__|\.next|\.nuxt)\//,
  /\.(min\.js|min\.css|map|snap|lock)$/i,
  /(^|\/)\.pnp\.[cm]?js$/
]

export function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE_PATTERNS.some((re) => re.test(path))
}

/** One entry per file of a unified diff, so it can be filtered and budgeted per file. */
export function splitDiffByFile(diff: string): { path: string; text: string }[] {
  if (!diff) return []
  return diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m)
      return { path: header ? header[2] : '(unknown)', text: chunk }
    })
}

export interface Condensed {
  diff: string
  /** Generated files left out */
  generated: string[]
  /** Files that didn't fit the budget */
  omitted: string[]
}

/**
 * Trim a diff to something a model can read while keeping it representative. Slicing the first N lines biases toward
 * whatever sorts first, so a lockfile or an assets/ folder could use the whole budget before the code that explains
 * the change. Instead: drop generated files, cap each remaining file, then apply the overall budget.
 */
export function condenseDiff(diff: string, { maxLines = 6000, maxLinesPerFile = 400 } = {}): Condensed {
  const empty: Condensed = { diff: '', generated: [], omitted: [] }
  if (!diff) return empty

  const files = splitDiffByFile(diff)
  if (!files.length) {
    const lines = diff.split('\n')
    return { ...empty, diff: lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : diff }
  }

  const generated: string[] = []
  const interesting = files.filter((file) => {
    if (!isGeneratedFile(file.path)) return true
    generated.push(file.path)
    return false
  })
  // a change that is only generated files still needs describing, so fall back to showing them
  const source = interesting.length ? interesting : files
  if (!interesting.length) generated.length = 0

  // per-file caps only exist to share a scarce budget
  const totalLines = source.reduce((sum, file) => sum + file.text.split('\n').length, 0)
  if (totalLines <= maxLines) return { diff: source.map((file) => file.text).join(''), generated, omitted: [] }

  const omitted: string[] = []
  const chunks: string[] = []
  let budget = maxLines
  for (const file of source) {
    if (budget <= 0) {
      omitted.push(file.path)
      continue
    }
    const lines = file.text.split('\n')
    const cap = Math.min(maxLinesPerFile, budget)
    if (lines.length > cap) {
      chunks.push(lines.slice(0, cap).join('\n') + `\n… (${lines.length - cap} more changed lines in ${file.path})\n`)
      budget -= cap
    } else {
      chunks.push(file.text)
      budget -= lines.length
    }
  }
  return { diff: chunks.join(''), generated, omitted }
}

const MAX_UNTRACKED_IN_PROMPT = 40

/** New files that matter for describing a change (generated ones dropped). */
export function relevantUntracked(untracked: string[]): string[] {
  return untracked.filter((path) => !isGeneratedFile(path)).slice(0, MAX_UNTRACKED_IN_PROMPT)
}

/**
 * The diff a commit message should describe. New files appear in no diff but get committed, so they are named
 * explicitly or the message misses the point of the change.
 */
export function commitDiffText(pending: PendingDiff): string {
  const untracked = relevantUntracked(pending.untracked)
  const diff = untracked.length
    ? `${pending.diff}\n${untracked.map((file) => `+++ b/${file} (new file)`).join('\n')}`.trim()
    : pending.diff
  return condenseDiff(diff, { maxLines: 5000, maxLinesPerFile: 500 }).diff
}

// ---------------------------------------------------------- commit message

export const COMMIT_TITLE_MAX_LENGTH = 72
const COMMIT_BODY_WRAP = 72
export const PR_TITLE_MAX_LENGTH = 72
export const PR_DESCRIPTION_MAX_TOKENS = 1500

export function buildCommitPrompt(diff: string, recentCommits: string): string {
  return `You are a professional git commit message generator. Analyze the following code changes and generate a meaningful commit message with a title and a description.

## Recent commits for context:
\`\`\`
${recentCommits}
\`\`\`

## Code changes to analyze:
\`\`\`diff
${diff}
\`\`\`

## Requirements:
1. The first line is the title, in conventional commits format: type(scope): description
2. Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build
3. Keep the title under 50 characters, with no trailing period
4. Size the description to the change. There is no fixed length or number of points:
   - A trivial or self-explanatory change (typo, version bump, rename) needs no description — return only the title
   - A focused change gets a sentence or two of plain prose
   - Only a change with several distinct parts gets bullet points starting with "- ", one per part — as many as there are parts, never padded or merged to reach a count
5. When there is a description, leave one blank line after the title. Explain what changed and why — behaviour and intent, not file names or line counts
6. Wrap description lines at ${COMMIT_BODY_WRAP} characters
7. Use imperative mood (e.g., "add" not "added") in both title and description
8. Return ONLY the commit message, with no labels like "Title:", no quotes, and no code fences

Examples of different sizes:

docs(readme): fix typo in install steps

fix(api): retry requests on 503 responses

The upstream gateway returns 503 during deploys, which surfaced as a hard
failure. Retry up to three times with backoff before giving up.

feat(auth): add login validation

- Reject empty and malformed emails before hitting the API
- Show inline field errors instead of a generic toast
- Lock the form after five failed attempts
`
}

/** A conversational lead-in ("Here's the title:") or a bare label line, rather than the answer itself. */
function isPreambleLine(line: string): boolean {
  return /^(sure|okay|ok|here('s| is)|certainly|based on)\b/i.test(line) || /^((pr|commit)\s+)?(title|message)\s*:?$/i.test(line)
}

const REFUSAL = /^(i (can|cannot|can't|'m|am)\b|as an ai\b|sorry\b|unable to\b)/i

/**
 * Reduce whatever came back (fences, quotes, a "Sure, here's..." preamble, a reasoning block) to one clean title,
 * or null so the caller can fall back.
 */
export function sanitizeTitle(raw: string | null | undefined, { maxLength = PR_TITLE_MAX_LENGTH } = {}): string | null {
  if (!raw) return null
  const lines = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[a-z]*/gi, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return null

  let title = lines.find((line) => !isPreambleLine(line)) ?? lines[0]
  title = title
    .replace(/^(?:(?:pr|commit)\s+)?(?:title|message)\s*[:\-—]\s*/i, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^#+\s*/, '')
    .replace(/^["'`“‘]+|["'`”’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim()

  if (title.length < 5 || !/[a-z]/i.test(title) || REFUSAL.test(title)) return null

  // "Feat(Auth): ..." -> "feat(auth): ..."
  title = title.replace(/^([A-Za-z]+)(\(([^)]*)\))?(!?):\s*/, (full, type: string, _paren, scope: string | undefined, bang: string) => {
    if (!/^(feat|fix|refactor|chore|docs|test|style|perf|ci|build|revert)$/i.test(type)) return full
    return `${type.toLowerCase()}${scope ? `(${scope.toLowerCase()})` : ''}${bang}: `
  })

  if (title.length > maxLength) {
    const cut = title.slice(0, maxLength)
    const lastSpace = cut.lastIndexOf(' ')
    title = (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:\-–—]+$/, '').trim()
  }
  return title || null
}

/** Reduce the model's reply to "title\n\ndescription" (or just the title), or null when no usable title came back. */
export function parseCommitMessage(raw: string | null | undefined): string | null {
  if (!raw) return null
  const lines = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[a-z]*/gi, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())

  const start = lines.findIndex((line) => line.trim() && !isPreambleLine(line.trim()))
  if (start === -1) return null
  const title = sanitizeTitle(lines[start], { maxLength: COMMIT_TITLE_MAX_LENGTH })
  if (!title) return null

  const body = lines
    .slice(start + 1)
    .join('\n')
    .replace(/^\s*(description|body)\s*:\s*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return body ? `${title}\n\n${body}` : title
}

/** The title line of a commit message. */
export function commitTitle(message: string | null | undefined): string {
  return message ? message.split('\n')[0] : ''
}

// ----------------------------------------------------------- pull requests

export interface PrContext {
  fromBranch: string
  toBranch: string
  /** The commit this run is about to create and push, if any */
  commitMessage: string | null
  commits: string[]
  stat: string
  diff: string
  /** Uncommitted work this run will commit and push (PR texts are generated before the commit exists) */
  pendingDiff: string
  untracked: string[]
  generated: string[]
}

export function buildPrContext(
  fromBranch: string,
  toBranch: string,
  comparison: BranchComparison,
  pending: { diff: string; commitMessage: string | null; untracked: string[] }
): PrContext {
  const branchDiff = condenseDiff(comparison.diff)
  const pendingDiff = condenseDiff(pending.diff, { maxLines: 2000, maxLinesPerFile: 300 })
  return {
    fromBranch,
    toBranch,
    commitMessage: pending.commitMessage,
    commits: comparison.commits,
    stat: comparison.stat,
    diff: branchDiff.diff,
    pendingDiff: pendingDiff.diff,
    untracked: relevantUntracked(pending.untracked),
    generated: [...new Set([...branchDiff.generated, ...pendingDiff.generated])]
  }
}

/** Identity of a context: targets with identical material share one AI call (and one answer). */
export function contextKey(c: PrContext): string {
  return [c.commitMessage ?? '', c.commits.join('\n'), c.stat, c.diff, c.pendingDiff, c.untracked.join('\n')].join('\u0000')
}

/** False when there is nothing at all to summarize. */
export function hasPrMaterial(c: PrContext): boolean {
  return Boolean(c.diff) || Boolean(c.pendingDiff) || c.commits.length > 0 || c.untracked.length > 0
}

function promptSection(heading: string, body: string): string {
  return body && body.trim() ? `\n## ${heading}\n${body}\n` : ''
}

/** The branch material shared by the title and description prompts, so both describe the same change. */
function prContextSections(c: PrContext): string {
  return [
    promptSection('Source branch', `\`${c.fromBranch}\``),
    promptSection('Commits already on this branch (newest first)', c.commits.map((s) => `- ${s}`).join('\n')),
    promptSection('Commit about to be added', c.commitMessage ? `\`\`\`\n${c.commitMessage}\n\`\`\`` : ''),
    promptSection('Files changed', c.stat ? `\`\`\`\n${c.stat}\n\`\`\`` : ''),
    promptSection('New files not yet tracked by git', c.untracked.map((f) => `- ${f}`).join('\n')),
    promptSection('Committed changes', c.diff ? `\`\`\`diff\n${c.diff}\n\`\`\`` : ''),
    promptSection('Uncommitted changes that this PR will also include', c.pendingDiff ? `\`\`\`diff\n${c.pendingDiff}\n\`\`\`` : ''),
    promptSection('Excluded from the diff above (generated files, ignore them)', c.generated.map((f) => `- ${f}`).join('\n'))
  ].join('')
}

export function buildPrTitlePrompt(c: PrContext): string {
  return `You are a senior engineer writing the title of a pull request. Read every section below, then output one title.

${prContextSections(c)}
## How to choose the title
1. Identify the single most important user- or developer-visible outcome of the whole branch. That is the title. Supporting refactors, test updates, and formatting are not the title.
2. Format: \`type(scope): description\` — types: feat, fix, refactor, chore, docs, test, style, perf, ci, build.
3. Pick the type from that main outcome, not from whichever file changed the most lines. New capability → feat. Corrected behaviour → fix. Same behaviour, better structure → refactor.
4. Scope is the feature area, module, or package touched (e.g. auth, api, cli, checkout), lowercase. Omit the scope entirely if the branch spans several unrelated areas.
5. Description: imperative mood ("add", not "added"/"adds"), specific, and about behaviour or intent — never about file names, line counts, or the fact that files were "updated".
6. Under ${PR_TITLE_MAX_LENGTH} characters total. No trailing period.
7. Banned as vague: "update code", "various changes", "improvements", "misc fixes", "changes to files", "refactor code". If you are tempted by one of these, name the concrete thing that changed instead.
8. If the branch genuinely does two things, name the dominant one; use "and" at most once.
9. Do not mention the target branch, the word "PR", or the branch name itself.

Output only the title, on one line, with no quotes, no code fences, and no explanation.

Good: feat(auth): add SSO login with session refresh
Good: fix(checkout): prevent double-charge on retried payments
Bad: chore: update files
Bad: feat: various improvements and refactoring`
}

const STANDARD_PR_LAYOUT = `## Summary
1-3 sentences: what this PR does and why it is needed.

## Changes
- The notable changes as bullets, most important first, grouped by area when there are several.

## How to test
- Concrete steps or commands a reviewer can run to verify the change. If the diff adds or updates tests, name them.

## Notes
- Breaking changes, migrations, new environment variables or config, deployment steps, known limitations, or follow-ups. Omit this whole section when there are none.`

export function buildPrDescriptionPrompt(c: PrContext, template: PrTemplate | null = null): string {
  const layout = template
    ? `This repository has a pull request template. Fill it in: keep its headings, their order, and any checklists. Replace placeholder text and HTML comments with real content, tick a checklist box only when the material above shows it is done, and write "N/A" under a heading that does not apply.

\`\`\`\`markdown
${template.content}
\`\`\`\``
    : `Use exactly these sections:

${STANDARD_PR_LAYOUT}`

  return `You are a senior engineer writing the description of a pull request for its reviewers. Read every section below, then write the description.

${prContextSections(c)}
## Layout
${layout}

## Rules
1. GitHub-flavoured Markdown.
2. Describe behaviour and intent — what changed and why — not file names or line counts, unless a file is itself the point (a new config file, a migration).
3. Base every statement on the material above. Never invent ticket or issue numbers, links, screenshots, benchmarks, or test results. You do not know how the author tested this, so give reviewers steps to verify it rather than claiming it was tested.
4. Be concise: a reviewer should grasp the PR in under a minute. Leave filler out rather than padding a section.
5. Do not repeat the PR title as a heading, and do not mention the target branch.

Output only the description, with no preamble and no code fence around it.`
}

/** Reduce the model's reply to the Markdown description itself, or null when nothing usable came back. */
export function sanitizePrDescription(raw: string | null | undefined): string | null {
  if (!raw) return null
  const lines = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r/g, '')
    .split('\n')
  while (lines.length && (!lines[0].trim() || isPreambleLine(lines[0].trim()) || /^(pr\s+)?description\s*:?$/i.test(lines[0].trim()))) {
    lines.shift()
  }
  let text = lines.join('\n').trim()
  // unwrap a fence around the whole reply, keeping fences inside it
  const fenced = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i)
  if (fenced) text = fenced[1]
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  if (text.length < 20 || REFUSAL.test(text)) return null
  return text
}

/** A PR title without the AI: the commit message, then the branch's commit subjects, then the branch name. */
export function buildHumanPrTitle(targetBranch: string, commitMessage: string | null, currentBranch: string | null, commits: string[] = []): string {
  const fromCommit = commitTitle(commitMessage) || commits[0]
  if (fromCommit) {
    // keep a conventional-commit prefix, it means something in a PR title too
    const match = fromCommit.match(/^([a-z]+(?:\([^)]*\))?!?):\s*(.+)$/i)
    if (match && match[2].trim()) return `${match[1].toLowerCase()}: ${match[2].trim()}`.slice(0, 120)
    const summary = fromCommit.trim()
    if (summary) return summary.charAt(0).toUpperCase() + summary.slice(1)
  }
  if (currentBranch) {
    // "feature/login-form" -> "Login form"
    const readable = currentBranch
      .replace(/^(feature|feat|fix|bugfix|hotfix|chore|release|docs)\//i, '')
      .replace(/[-_/]+/g, ' ')
      .trim()
    if (readable) return readable.charAt(0).toUpperCase() + readable.slice(1)
  }
  return `Merge changes into ${targetBranch}`
}

/** A description without the AI, from the commit subjects. Never names the target: targets may share it. */
export function buildHumanPrDescription(c: PrContext): string {
  const items = [...new Set([commitTitle(c.commitMessage), ...c.commits].filter(Boolean))]
  const summary = items[0] || `Changes from \`${c.fromBranch}\`.`
  const changes = items.length > 1 ? items.map((s) => `- ${s}`).join('\n') : ''
  return changes ? `## Summary\n\n${summary}\n\n## Changes\n\n${changes}` : `## Summary\n\n${summary}`
}

// -------------------------------------------------------------------- plan

export type SmartStep = 'stage' | 'commit' | 'push' | 'pr'
export const SMART_STEPS: SmartStep[] = ['stage', 'commit', 'push', 'pr']

/** Which steps the user allows. Whether an allowed step runs depends on what the repository needs. */
export type SmartIntent = Record<SmartStep, boolean>

export interface SmartPlan {
  run: Record<SmartStep, boolean>
  /** Why each step that won't run is skipped */
  reasons: Record<SmartStep, string | null>
  /** Consequences easy to misread from the checklist alone, chiefly work being left behind */
  caveats: string[]
}

/**
 * Intersect what the user allows with what the repository needs, once, so the preview and the run can never
 * disagree. Committing is what staging is for, so staging is off whenever committing is.
 */
export function resolvePlan(intent: SmartIntent, s: SmartStatus): SmartPlan {
  const stageable = s.unstaged || s.untracked
  const stage = intent.stage && intent.commit && stageable
  const committable = stage || s.staged
  const commit = intent.commit && committable
  // a commit made by this run is unpushed by definition
  const pushable = !!s.remote && (commit || s.unpushed)
  const push = intent.push && pushable
  const pr = intent.pr && !!s.remote && s.gh

  const reason = (off: boolean, needed: boolean, idle: string) => (off ? 'turned off' : needed ? null : idle)
  const run = { stage, commit, push, pr }
  const caveats = [
    commit && !push && 'The new commit stays local — nothing will be pushed.',
    pr && !push && `Pull requests will describe what ${s.remote}/${s.branch} already has, not local work.`,
    s.staged && !commit && 'Staged changes are left in the index, uncommitted.',
    stageable && !stage && (commit ? 'Unstaged and new files are left out of the commit.' : 'Working-tree changes are left behind.')
  ].filter((c): c is string => !!c)

  return {
    run,
    reasons: {
      stage: reason(!intent.stage || !intent.commit, stageable, 'working tree clean'),
      commit: reason(!intent.commit, committable, 'nothing staged'),
      push: reason(!intent.push, pushable, s.remote ? `${s.remote} already up to date` : 'no remote'),
      pr: !intent.pr ? 'turned off' : !s.remote ? 'no remote' : !s.gh ? 'GitHub CLI (gh) not installed' : null
    },
    caveats
  }
}

/** Comma-separated branch list -> unique, trimmed names. */
export function parseBranchList(value: string): string[] {
  return [...new Set(value.split(',').map((b) => b.trim()).filter(Boolean))]
}
