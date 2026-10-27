// Subsequence fuzzy matcher used by the command palette.

export interface FuzzyMatch {
  score: number
  /** Indices of matched characters in the text */
  indices: number[]
}

const isBoundary = (text: string, i: number) => i === 0 || /[\s/_\-.:]/.test(text[i - 1]) || (text[i] >= 'A' && text[i] <= 'Z' && text[i - 1] >= 'a' && text[i - 1] <= 'z')

/** Returns null when `query` is not a subsequence of `text`. Higher scores are better. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, indices: [] }
  const t = text.toLowerCase()

  // Exact substring gets a strong bonus and contiguous indices.
  const sub = t.indexOf(q)
  if (sub !== -1) {
    const indices = Array.from({ length: q.length }, (_, k) => sub + k)
    return { score: 1000 - sub * 2 + (isBoundary(text, sub) ? 200 : 0) - (t.length - q.length) * 0.5, indices }
  }

  const indices: number[] = []
  let score = 0
  let ti = 0
  let prev = -2
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    if (ch === ' ') continue
    // prefer a boundary occurrence if one exists ahead
    let found = -1
    for (let k = ti; k < t.length; k++) {
      if (t[k] !== ch) continue
      if (found === -1) found = k
      if (isBoundary(text, k)) {
        found = k
        break
      }
      if (k === prev + 1) break
    }
    if (found === -1) return null
    score += 10
    if (found === prev + 1) score += 15
    if (isBoundary(text, found)) score += 20
    score -= Math.min(found - ti, 10)
    indices.push(found)
    prev = found
    ti = found + 1
  }
  return { score: score - t.length * 0.2, indices }
}

export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 100): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = []
  for (const item of items) {
    const match = fuzzyMatch(query, text(item))
    if (match) out.push({ item, match })
  }
  if (query.trim()) out.sort((a, b) => b.match.score - a.match.score)
  return out.slice(0, limit)
}
