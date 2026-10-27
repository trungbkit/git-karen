// Consequence previews for dangerous operations, shown in their confirmation dialogs.
import type { RepoTab } from '../state/store'
import type { ImpactLine } from '../ui/dialogs'
import { shortSha } from '../util/format'

const git = () => window.git

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const lines = (add: number, del: number) => `+${add} −${del} lines`

export async function resetImpact(repo: RepoTab, sha: string, mode: 'soft' | 'mixed' | 'hard', branch: string): Promise<ImpactLine[]> {
  const [leaving, arriving, status] = await Promise.all([
    git().countCommits(repo.path, 'HEAD', [sha]),
    git().countCommits(repo.path, sha, ['HEAD']),
    git().status(repo.path)
  ])
  const out: ImpactLine[] = []
  if (leaving > 0) out.push({ text: `${count(leaving, 'commit')} will leave ${branch} (still in the reflog)`, tone: mode === 'hard' ? 'danger' : undefined })
  if (arriving > 0) out.push({ text: `${count(arriving, 'commit')} not on ${branch} yet will be added to it` })
  if (leaving === 0 && arriving === 0) out.push({ text: `${branch} already points at ${shortSha(sha)}`, tone: 'muted' })
  const tracked = new Map<string, { add: number; del: number }>()
  for (const f of [...status.staged, ...status.unstaged]) {
    if (f.status === 'untracked') continue
    const prev = tracked.get(f.path) ?? { add: 0, del: 0 }
    tracked.set(f.path, { add: prev.add + (f.additions ?? 0), del: prev.del + (f.deletions ?? 0) })
  }
  if (mode === 'hard') {
    if (tracked.size > 0) {
      const add = [...tracked.values()].reduce((n, f) => n + f.add, 0)
      const del = [...tracked.values()].reduce((n, f) => n + f.del, 0)
      out.push({ text: `Uncommitted changes to ${count(tracked.size, 'file')} will be discarded (${lines(add, del)})`, tone: 'danger' })
    } else out.push({ text: 'No uncommitted changes to lose', tone: 'muted' })
    out.push({ text: 'Untracked files are kept', tone: 'muted' })
  } else if (mode === 'mixed') {
    out.push({ text: 'Changes from those commits and staged files are kept, unstaged', tone: 'muted' })
  } else {
    out.push({ text: 'Changes from those commits are kept, staged', tone: 'muted' })
  }
  return out
}

export async function deleteBranchImpact(repo: RepoTab, branch: string, current: string | null): Promise<ImpactLine[]> {
  const { unmerged, orphaned } = await git().branchImpact(repo.path, branch)
  const into = current ?? 'HEAD'
  const out: ImpactLine[] = [
    unmerged === 0 ? { text: `Fully merged into ${into}`, tone: 'muted' } : { text: `Not merged into ${into}: ${count(unmerged, 'commit')} missing there` }
  ]
  out.push(
    orphaned > 0
      ? { text: `${count(orphaned, 'commit')} will no longer belong to any branch or tag`, tone: 'danger' }
      : { text: 'Every commit stays on another branch or tag', tone: 'muted' }
  )
  return out
}

/** `upstream` is the remote-tracking branch, e.g. "origin/main"; counts are as of the last fetch. */
export async function forcePushImpact(repo: RepoTab, upstream: string): Promise<ImpactLine[]> {
  const remoteRef = `refs/remotes/${upstream}`
  const [overwritten, pushed] = await Promise.all([
    git().countCommits(repo.path, remoteRef, ['HEAD']),
    git().countCommits(repo.path, 'HEAD', [remoteRef])
  ])
  return [
    overwritten > 0
      ? { text: `${count(overwritten, 'commit')} on ${upstream} will be removed from the remote`, tone: 'danger' }
      : { text: `Nothing on ${upstream} is overwritten (a normal push would do)`, tone: 'muted' },
    { text: `${count(pushed, 'local commit')} will be pushed` },
    { text: 'As of the last fetch', tone: 'muted' }
  ]
}

export async function discardImpact(repo: RepoTab, paths: string[]): Promise<ImpactLine[]> {
  const i = await git().discardImpact(repo.path, paths)
  const out: ImpactLine[] = []
  const changed = i.files - i.untracked
  if (changed > 0 || i.additions + i.deletions > 0) out.push({ text: `${lines(i.additions, i.deletions)} in ${count(i.files, 'file')} will be lost`, tone: 'danger' })
  if (i.untracked > 0) out.push({ text: `${count(i.untracked, 'untracked file')} will be deleted`, tone: 'danger' })
  if (i.binary > 0) out.push({ text: `${count(i.binary, 'binary file')} included`, tone: 'muted' })
  if (out.length === 0) out.push({ text: 'Only staged changes here; they are kept', tone: 'muted' })
  return out
}

/** Lines a (partial) patch discards; `+` lines are work-tree additions that disappear. */
export function patchImpact(patch: string): ImpactLine[] {
  let add = 0
  let del = 0
  let inHunk = false
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git')) inHunk = false
    else if (l.startsWith('@@')) inHunk = true
    else if (inHunk && l.startsWith('+')) add++
    else if (inHunk && l.startsWith('-')) del++
  }
  return [{ text: `${lines(add, del)} will be discarded`, tone: 'danger' }]
}
