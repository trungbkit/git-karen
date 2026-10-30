// AI help for merge conflicts: a prompt with each conflict of a file (base, both sides and the lines around it), and
// the parser for the merged lines that come back. Pure functions only; the conflict view does the AI call.
import type { Chunk } from '../diff/merge3'

/** Unchanged lines shown before and after each conflict. */
const CONTEXT_LINES = 12
/** Beyond this the reply could not hold every resolution. */
const MAX_CONFLICT_CHARS = 60_000

export interface ConflictPromptInput {
  path: string
  chunks: Chunk[]
  /** The operation that stopped on the conflict ("merge", "rebase", "cherry-pick"…), when known */
  operation?: string | null
}

/** Lines of the non-conflict chunks next to chunk `index`, walking backwards (`dir` -1) or forwards (+1). */
function around(chunks: Chunk[], index: number, dir: -1 | 1): string[] {
  const out: string[] = []
  for (let i = index + dir; i >= 0 && i < chunks.length && out.length < CONTEXT_LINES; i += dir) {
    const c = chunks[i]
    if (c.kind === 'conflict') break
    const lines = dir < 0 ? [...c.lines].reverse() : c.lines
    for (const l of lines) {
      if (out.length >= CONTEXT_LINES) break
      out.push(l)
    }
  }
  return dir < 0 ? out.reverse() : out
}

const block = (label: string, lines: string[]) => `${label}:\n${lines.length ? lines.join('\n') : '(nothing)'}`

/** Sides as the conflict view labels them; a rebase replays the incoming commits onto the current branch. */
function sidesNote(operation?: string | null): string {
  if (operation === 'rebase') return 'This is a rebase: OURS is the branch being rebased onto, THEIRS is the commit being replayed on top of it.'
  if (operation === 'cherry-pick' || operation === 'revert') return `This is a ${operation}: OURS is the current branch, THEIRS is the change being applied.`
  return 'OURS is the current branch, THEIRS is the branch being merged in.'
}

/** Reply budget: roughly what the two sides add up to, plus room for the notes. */
export function conflictMaxTokens(chunks: Chunk[]): number {
  const chars = chunks.reduce((n, c) => (c.kind === 'conflict' ? n + [...c.ours, ...c.theirs].join('\n').length : n), 0)
  const conflicts = chunks.filter((c) => c.kind === 'conflict').length
  return Math.min(8192, Math.max(1000, Math.ceil(chars / 3) + 150 * conflicts))
}

/** Null when there are no conflicts, or too much conflicting text for one reply to resolve. */
export function buildConflictPrompt({ path, chunks, operation }: ConflictPromptInput): string | null {
  const parts: string[] = []
  let n = 0
  let chars = 0
  chunks.forEach((c, i) => {
    if (c.kind !== 'conflict') return
    n++
    chars += [...c.base, ...c.ours, ...c.theirs].join('\n').length
    parts.push(
      [
        `### Conflict ${n}`,
        block('Lines before', around(chunks, i, -1)),
        block('BASE (common ancestor)', c.base),
        block('OURS', c.ours),
        block('THEIRS', c.theirs),
        block('Lines after', around(chunks, i, 1))
      ].join('\n\n')
    )
  })
  if (n === 0 || chars > MAX_CONFLICT_CHARS) return null
  return `You are resolving git merge conflicts in the file \`${path}\`. ${sidesNote(operation)}

For each conflict you get the common ancestor (BASE), both versions (OURS, THEIRS) and the unchanged lines around it. Write the lines that should replace the conflict.

## Rules
- Keep the intent of both sides. When they are compatible (both add imports, cases, fields, tests…), combine them, without duplicates.
- When they truly contradict, pick the version that fits the surrounding code and the other changes, and say so in the note.
- Compare each side with BASE to tell what each one actually changed; a side identical to BASE changed nothing there.
- Write exact file content: same indentation and style, no conflict markers, no line numbers, no code fences, no comments about the merge.
- Never repeat the "Lines before" or "Lines after"; they stay in the file as they are.

## Conflicts

${parts.join('\n\n')}

## Reply format
Exactly one resolution and one note per conflict, in order, and nothing else:
<resolution id="1">
the merged lines (leave it empty to remove the lines)
</resolution>
<note id="1">One short sentence: what you kept from each side and why.</note>`
}

export interface ConflictResolutions {
  /** Merged lines per conflict; null where the reply had no usable resolution */
  lines: (string[] | null)[]
  notes: (string | null)[]
}

const MARKER = /^(<{7}|={7}|>{7}|\|{7})( |$)/

/** Read the reply's resolution blocks for `count` conflicts. A block that still has conflict markers is unusable. */
export function parseConflictResolutions(raw: string, count: number): ConflictResolutions {
  const lines: (string[] | null)[] = Array.from({ length: count }, () => null)
  const notes: (string | null)[] = Array.from({ length: count }, () => null)
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\r/g, '')
  for (const m of text.matchAll(/<resolution id="(\d+)">\n?([\s\S]*?)<\/resolution>/g)) {
    const i = Number(m[1]) - 1
    if (i < 0 || i >= count) continue
    let body = m[2].replace(/\n$/, '')
    // a fence around the block is formatting, not content
    const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(body.trim())
    if (fenced) body = fenced[1]
    const out = body === '' ? [] : body.split('\n')
    lines[i] = out.some((l) => MARKER.test(l)) ? null : out
  }
  for (const m of text.matchAll(/<note id="(\d+)">([\s\S]*?)<\/note>/g)) {
    const i = Number(m[1]) - 1
    if (i >= 0 && i < count) notes[i] = m[2].trim() || null
  }
  return { lines, notes }
}
