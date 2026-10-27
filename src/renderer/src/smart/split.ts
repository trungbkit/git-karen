// Splitting the working-tree changes into several commits with AI: the changes are cut into units (whole files, or
// hunks of a modified file), the AI groups unit ids into commits as JSON, and each group becomes the paths and partial
// patches to stage before its commit. Pure functions only; ./workflow.ts does the git and AI calls.
import type { FileDiff } from '@shared/types'
import { buildPatch } from '../diff/patch'
import { isGeneratedFile, parseCommitMessage } from './text'

export const SPLIT_MAX_TOKENS = 2500
/** More groups than this is the AI shredding the change, not organising it. */
const MAX_GROUPS = 12

/** One piece of the change the AI can place in a commit: a whole file, or one hunk of a modified file. */
export interface SplitUnit {
  /** "F3" for a whole file, "F3.2" for its second hunk */
  id: string
  path: string
  /** Old path of a rename; staged together with the new one */
  oldPath?: string
  /** Hunk index in the file's diff; absent for a whole file */
  hunk?: number
  /** Untracked file: staged by path, no diff */
  untracked?: boolean
  additions: number
  deletions: number
  /** Diff text shown to the AI */
  text: string
}

function hunkText(diff: FileDiff, index: number): string {
  const h = diff.hunks[index]
  const mark = { context: ' ', add: '+', del: '-', meta: '' } as const
  return [h.header, ...h.lines.map((l) => mark[l.type] + l.content)].join('\n')
}

function counts(diff: FileDiff, index?: number) {
  const hunks = index === undefined ? diff.hunks : [diff.hunks[index]]
  let additions = 0
  let deletions = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.type === 'add') additions++
      else if (l.type === 'del') deletions++
    }
  return { additions, deletions }
}

/**
 * Cut the changes into units. A plainly modified text file with several hunks gives one unit per hunk; new, deleted,
 * renamed, binary and single-hunk files are one unit each, as are untracked files.
 */
export function splitUnits(diffs: FileDiff[], untracked: string[]): SplitUnit[] {
  const units: SplitUnit[] = []
  let n = 0
  for (const d of diffs) {
    n++
    const kind = d.isNew ? 'new file' : d.isDeleted ? 'deleted file' : d.oldPath ? `renamed from ${d.oldPath}` : d.binary ? 'binary file' : 'modified'
    const byHunk = kind === 'modified' && d.hunks.length > 1
    if (byHunk) {
      d.hunks.forEach((_, i) => units.push({ id: `F${n}.${i + 1}`, path: d.path, hunk: i, ...counts(d, i), text: hunkText(d, i) }))
    } else {
      const body = d.binary ? '(binary)' : d.hunks.map((_, i) => hunkText(d, i)).join('\n')
      units.push({ id: `F${n}`, path: d.path, oldPath: d.oldPath, ...counts(d), text: `(${kind})\n${body}`.trimEnd() })
    }
  }
  for (const path of untracked) {
    n++
    units.push({ id: `F${n}`, path, untracked: true, additions: 0, deletions: 0, text: '(new file, not tracked yet)' })
  }
  return units
}

/** The id of the file a unit belongs to ("F3.2" -> "F3"). */
export const fileOf = (id: string) => id.split('.')[0]

/** Changes as the AI reads them: each unit under its id, generated files and long hunks cut short. */
export function splitChangesText(units: SplitUnit[], { maxLines = 4000, maxLinesPerUnit = 120 } = {}): string {
  let budget = maxLines
  const out: string[] = []
  let lastFile = ''
  for (const u of units) {
    const file = fileOf(u.id)
    if (file !== lastFile) {
      out.push(`### ${file} ${u.path}${u.oldPath ? ` (renamed from ${u.oldPath})` : ''}`)
      lastFile = file
    }
    let lines = u.text.split('\n')
    if (isGeneratedFile(u.path)) lines = [lines[0], '(generated file, contents left out)']
    const cap = Math.max(4, Math.min(maxLinesPerUnit, budget))
    if (lines.length > cap) lines = [...lines.slice(0, cap), `… (${lines.length - cap} more lines)`]
    budget -= lines.length
    out.push(`#### ${u.id} (+${u.additions} −${u.deletions})`, ...lines)
  }
  return out.join('\n')
}

export function buildSplitPrompt(units: SplitUnit[], recentCommits: string): string {
  return `You are a senior engineer splitting uncommitted work into a series of small, focused git commits. The changes are listed below as units: a whole file ("F3") or one hunk of a modified file ("F3.2").

## Recent commits for context:
\`\`\`
${recentCommits}
\`\`\`

## Changes
${splitChangesText(units)}

## How to group
1. Each commit is one logical change: a feature, a fix, a refactor, docs, tests that belong to their code, and so on. Put related units together even when they are in different files.
2. Every unit id appears in exactly one commit. Never invent ids.
3. Order the commits so that each one makes sense on top of the previous ones (refactors and groundwork first).
4. Prefer fewer, meaningful commits over many tiny ones; a change that really is one thing stays one commit. At most ${MAX_GROUPS} commits.
5. Commit messages: a title in conventional commits format, type(scope): description, under 72 characters, imperative mood, no trailing period. Add a short description after a blank line only when the title is not enough.

## Output
Reply with JSON only, no code fence and no explanation, in exactly this shape:
{"commits":[{"message":"feat(auth): add login validation","changes":["F1","F3.2"]},{"message":"docs: describe the login flow","changes":["F2"]}]}`
}

export interface SplitGroup {
  message: string
  /** Unit ids, in the order the units were listed */
  units: string[]
}

export interface ParsedSplit {
  groups: SplitGroup[]
  /** Units the AI left out */
  unassigned: string[]
  /** What was wrong with the reply and has been corrected */
  problems: string[]
}

/** The JSON value in a reply that may carry a preamble, a reasoning block or a code fence. */
function extractJson(raw: string): unknown {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[a-z]*\n?/gi, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    const start = text.search(/[{[]/)
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
    if (start === -1 || end <= start) throw new Error('The AI reply contains no JSON.')
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch (e) {
      throw new Error(`The AI reply is not valid JSON: ${(e as Error).message}`)
    }
  }
}

/**
 * Validate the AI's grouping against the known unit ids. Throws when the reply is not a list of commits at all;
 * smaller faults (unknown or repeated ids, a file id given for a file split into hunks, an unusable message) are
 * corrected and reported in `problems`. Units in no group come back in `unassigned`.
 */
export function parseSplitPlan(raw: string, unitIds: string[]): ParsedSplit {
  const json = extractJson(raw)
  const list = Array.isArray(json) ? json : (json as { commits?: unknown } | null)?.commits
  if (!Array.isArray(list)) throw new Error('The AI reply has no "commits" list.')

  const known = new Set(unitIds)
  const order = new Map(unitIds.map((id, i) => [id, i]))
  const taken = new Set<string>()
  const problems: string[] = []
  const groups: SplitGroup[] = []

  list.forEach((entry, i) => {
    const n = i + 1
    if (!entry || typeof entry !== 'object') {
      problems.push(`Commit ${n} is not an object; ignored.`)
      return
    }
    const e = entry as Record<string, unknown>
    const ids = e.changes ?? e.units ?? e.files ?? e.hunks
    const units: string[] = []
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== 'string') continue
      const key = id.trim().toUpperCase()
      // a file id for a file that was split into hunks means all of its hunks still free
      const expanded = known.has(key) ? [key] : unitIds.filter((u) => fileOf(u) === key && u !== key)
      if (expanded.length === 0) {
        problems.push(`Commit ${n} refers to an unknown change ${id}.`)
        continue
      }
      for (const u of expanded) {
        if (taken.has(u)) {
          if (expanded.length === 1) problems.push(`${u} is in more than one commit; kept in the first.`)
          continue
        }
        taken.add(u)
        units.push(u)
      }
    }
    if (units.length === 0) {
      problems.push(`Commit ${n} has no changes; left out.`)
      return
    }
    const message = typeof e.message === 'string' ? parseCommitMessage(e.message) : null
    if (!message) problems.push(`Commit ${n} came without a usable message.`)
    units.sort((a, b) => order.get(a)! - order.get(b)!)
    groups.push({ message: message ?? '', units })
  })
  if (groups.length > MAX_GROUPS) problems.push(`The AI proposed ${groups.length} commits; consider merging some.`)
  return { groups, unassigned: unitIds.filter((id) => !taken.has(id)), problems }
}

/** What to stage for one group: paths to add whole, and patches for files only partly in the group. */
export interface GroupStaging {
  paths: string[]
  patches: string[]
}

/**
 * Turn a group into staging work against an index at HEAD plus the earlier groups. Whole files and files whose every
 * hunk is in the group are added by path; otherwise the group's hunks become a patch built from the original diff
 * (later groups apply at an offset, which `git apply` allows).
 */
export function groupStaging(units: SplitUnit[], diffs: FileDiff[], ids: string[]): GroupStaging {
  const byId = new Map(units.map((u) => [u.id, u]))
  const diffByPath = new Map(diffs.map((d) => [d.path, d]))
  const paths: string[] = []
  const hunksByPath = new Map<string, number[]>()
  for (const id of ids) {
    const u = byId.get(id)
    if (!u) continue
    if (u.hunk === undefined) {
      paths.push(u.path)
      if (u.oldPath) paths.push(u.oldPath)
    } else hunksByPath.set(u.path, [...(hunksByPath.get(u.path) ?? []), u.hunk])
  }
  const patches: string[] = []
  for (const [path, hunks] of hunksByPath) {
    const diff = diffByPath.get(path)
    if (!diff) continue
    if (hunks.length === diff.hunks.length) paths.push(path)
    else {
      const patch = buildPatch(diff, hunks.sort((a, b) => a - b).map((hunkIndex) => ({ hunkIndex })), 'stage')
      if (patch) patches.push(patch)
    }
  }
  return { paths, patches }
}
