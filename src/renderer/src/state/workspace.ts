// Workspace helpers: which repositories "Pull all" may touch, and running git over many repositories at once.
import type { RepoSummary, Workspace } from '@shared/types'

export type SkipReason = 'changes' | 'operation' | 'detached' | 'no-upstream' | 'up-to-date' | 'unknown'

export const SKIP_LABELS: Record<Exclude<SkipReason, 'up-to-date'>, string> = {
  changes: 'uncommitted changes',
  operation: 'an operation in progress',
  detached: 'detached HEAD',
  'no-upstream': 'no upstream branch',
  unknown: 'status unavailable'
}

/** Pull all only fast-forwards clean repositories that are behind their upstream. */
export function pullPlan(repos: string[], summaries: Record<string, RepoSummary | undefined>) {
  const pull: string[] = []
  const skipped: { path: string; reason: SkipReason }[] = []
  for (const path of repos) {
    const s = summaries[path]
    const reason: SkipReason | null = !s
      ? 'unknown'
      : s.operation
        ? 'operation'
        : s.changes > 0
          ? 'changes'
          : s.detached || !s.branch
            ? 'detached'
            : !s.upstream
              ? 'no-upstream'
              : s.behind === 0
                ? 'up-to-date'
                : null
    if (reason) skipped.push({ path, reason })
    else pull.push(path)
  }
  return { pull, skipped }
}

/** "2 with uncommitted changes, 1 with no upstream branch" for the skipped repositories (up-to-date ones are not news). */
export function describeSkipped(skipped: { reason: SkipReason }[]): string {
  const counts = new Map<string, number>()
  for (const { reason } of skipped) if (reason !== 'up-to-date') counts.set(SKIP_LABELS[reason], (counts.get(SKIP_LABELS[reason]) ?? 0) + 1)
  return [...counts].map(([label, n]) => `${n} with ${label}`).join(', ')
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Problem with a workspace name, or null. */
export function validateWorkspaceName(name: string, workspaces: Workspace[], current?: string): string | null {
  const n = name.trim()
  if (!n) return 'Name is required'
  if (n !== current && workspaces.some((w) => w.name === n)) return 'A workspace with this name exists'
  return null
}
