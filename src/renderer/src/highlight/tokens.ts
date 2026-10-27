// Pure helpers for syntax tokens: mapping diff lines onto old/new documents and splitting tokens
// at intra-line change boundaries. No Shiki imports here so these stay cheap to test.
import type { FileDiff } from '@shared/types'

export interface Token {
  content: string
  color?: string
  /** Bit flags: 1 italic, 2 bold, 4 underline (Shiki FontStyle) */
  fontStyle?: number
}

/** A token piece that may additionally fall inside the changed (intra-line) range. */
export interface Segment extends Token {
  changed: boolean
}

export interface LineRef {
  side: 'old' | 'new'
  line: number
}

export interface DiffSides {
  oldText: string
  newText: string
  /** refs[hunk][lineIndex] → which document line holds the tokens for that diff line (null for meta lines) */
  refs: (LineRef | null)[][]
}

/**
 * Rebuilds the old side (context + deletions) and new side (context + additions) of a diff as two documents,
 * so the tokenizer sees each side in order and multi-line constructs (comments, strings) are coloured correctly.
 */
export function diffSides(diff: FileDiff): DiffSides {
  const oldLines: string[] = []
  const newLines: string[] = []
  const refs = diff.hunks.map((hunk) =>
    hunk.lines.map((l): LineRef | null => {
      if (l.type === 'del') {
        oldLines.push(l.content)
        return { side: 'old', line: oldLines.length - 1 }
      }
      if (l.type === 'add') {
        newLines.push(l.content)
        return { side: 'new', line: newLines.length - 1 }
      }
      if (l.type === 'context') {
        oldLines.push(l.content)
        newLines.push(l.content)
        return { side: 'new', line: newLines.length - 1 }
      }
      return null
    })
  )
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n'), refs }
}

/** Resolves per-diff-line tokens from tokenized sides. Lines whose tokens don't reproduce the text get null. */
export function mapDiffTokens(diff: FileDiff, sides: DiffSides, oldTokens: Token[][] | null, newTokens: Token[][] | null): (Token[] | null)[][] {
  return diff.hunks.map((hunk, h) =>
    hunk.lines.map((l, i) => {
      const ref = sides.refs[h][i]
      if (!ref) return null
      const tokens = (ref.side === 'old' ? oldTokens : newTokens)?.[ref.line]
      return tokens && joined(tokens) === l.content ? tokens : null
    })
  )
}

function joined(tokens: Token[]): string {
  let s = ''
  for (const t of tokens) s += t.content
  return s
}

/**
 * Splits tokens so that each range [start, end) (sorted, not overlapping) becomes separate segments flagged
 * `changed`. With no range, every token becomes one unchanged segment.
 */
export function splitTokens(tokens: Token[], ranges?: [number, number] | readonly (readonly [number, number])[]): Segment[] {
  const list = !ranges ? [] : typeof ranges[0] === 'number' ? [ranges as [number, number]] : (ranges as readonly (readonly [number, number])[])
  if (list.length === 0) return tokens.map((t) => ({ ...t, changed: false }))
  const out: Segment[] = []
  let pos = 0
  let r = 0
  for (const t of tokens) {
    const start = pos
    const end = pos + t.content.length
    pos = end
    // cut the token at every range boundary inside it
    let at = start
    while (at < end) {
      while (r < list.length && list[r][1] <= at) r++
      const range = list[r]
      const inside = !!range && range[0] <= at
      const next = Math.min(end, !range ? end : inside ? range[1] : range[0])
      out.push({ ...t, content: t.content.slice(at - start, next - start), changed: inside })
      at = next
    }
  }
  return out
}

/** Cheap 32-bit FNV-1a hash used for cache keys. */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + ':' + text.length
}
