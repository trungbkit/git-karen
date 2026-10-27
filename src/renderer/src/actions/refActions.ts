// Git actions and context-menu builders for commits, branches, tags, stashes and remotes.
import type { Ref, Remote, Stash } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { confirm, prompt, validateRefName } from '../ui/dialogs'
import type { MenuItem } from '../ui/ContextMenu'
import { commitsBetween, isAncestor } from '../graph/layout'
import { shortSha } from '../util/format'
import { branchWorktreeItems, createWorktree, openWorktree, worktreeForBranch } from './worktreeActions'
import { offerUndo, runRestorable } from './undo'
import { deleteBranchImpact, forcePushImpact, resetImpact } from './impact'
import { compareRefMenuItems, openCompare, orderedPair } from './compareActions'
import { dismissBehindNotice, noteFetched, upstreamTip } from '../state/autoFetch'

const store = () => useStore.getState()
const git = () => window.git

export function copyText(text: string, what = 'Copied to clipboard') {
  void navigator.clipboard.writeText(text).then(() => store().toast({ kind: 'info', title: what }))
}

export function headSha(repo: RepoTab): string | null {
  return repo.status?.headSha ?? null
}

export function currentBranch(repo: RepoTab): string | null {
  return repo.status?.detached ? null : (repo.status?.branch ?? null)
}

function remoteOf(ref: Ref): string | undefined {
  if (ref.remote) return ref.remote
  const m = ref.upstream?.match(/^refs\/remotes\/([^/]+)\//)
  return m?.[1]
}

/** Name of a remote branch without its remote prefix: origin/feat/x -> feat/x */
export function remoteBranchName(ref: Ref): string {
  const remote = remoteOf(ref)
  return remote && ref.name.startsWith(remote + '/') ? ref.name.slice(remote.length + 1) : ref.name
}

function defaultRemote(repo: RepoTab): string | undefined {
  return repo.remotes.find((r) => r.name === 'origin')?.name ?? repo.remotes[0]?.name
}

// ---------------------------------------------------------------------------------------------
// actions

export async function createBranchAt(startPoint?: string) {
  const res = await prompt({
    title: startPoint ? `Create branch at ${shortSha(startPoint)}` : 'Create branch',
    fields: [{ name: 'name', label: 'Branch name', placeholder: 'feature/my-change', validate: validateRefName }],
    checkboxes: [{ name: 'checkout', label: 'Check out after creating', initial: true }],
    confirmLabel: 'Create branch'
  })
  if (!res) return
  await store().run('Creating branch', (r) => git().createBranch(r, res.name.trim(), startPoint, res.checks.checkout))
}

export async function createTagAt(sha: string) {
  const res = await prompt({
    title: `Create tag at ${shortSha(sha)}`,
    fields: [
      { name: 'name', label: 'Tag name', placeholder: 'v1.0.0', validate: validateRefName },
      { name: 'message', label: 'Message (creates an annotated tag)', multiline: true }
    ],
    confirmLabel: 'Create tag'
  })
  if (!res) return
  await store().run('Creating tag', (r) => git().createTag(r, res.name.trim(), sha, res.message.trim() || undefined))
}

export async function checkoutRef(repo: RepoTab, ref: Ref) {
  if (ref.type === 'local') {
    if (ref.isHead) return
    // git refuses to check out a branch that another worktree has checked out: open that worktree instead
    const wt = worktreeForBranch(repo, ref.name)
    if (wt) return openWorktree(wt.path)
    await store().run(`Checking out ${ref.name}`, (r) => git().checkout(r, ref.name))
  } else if (ref.type === 'remote') {
    const local = remoteBranchName(ref)
    const existing = repo.refs.find((r) => r.type === 'local' && r.name === local)
    const wt = existing && worktreeForBranch(repo, local)
    if (wt) {
      store().toast({ kind: 'info', title: `${local} is checked out in another worktree`, message: wt.path })
      return openWorktree(wt.path)
    }
    if (existing) {
      // Bring the local branch up to date with the remote one when it is strictly behind it.
      const loaded = new Set(repo.commits.map((c) => c.sha))
      const ahead = existing.sha === ref.sha || isAncestor(repo.commits, ref.sha, existing.sha)
      const diverged = !ahead && loaded.has(existing.sha) && loaded.has(ref.sha) && !isAncestor(repo.commits, existing.sha, ref.sha)
      const ok = await store().run(`Checking out ${local}`, async (r) => {
        await git().checkout(r, local)
        // Unknown ancestry (commits outside the loaded graph) also tries; --ff-only refuses anything else.
        if (!ahead && !diverged) await git().merge(r, ref.name, { ffOnly: true })
      })
      if (ok && diverged) {
        store().toast({ kind: 'info', title: `${local} has diverged from ${ref.name}`, message: 'Checked out without syncing. Merge or rebase to reconcile.' })
      }
    } else {
      await store().run(`Checking out ${local}`, (r) => git().checkoutRemote(r, ref.name, local))
    }
  } else if (ref.type === 'tag') {
    await checkoutDetached(ref.sha, ref.name)
  }
}

export async function checkoutDetached(sha: string, label = shortSha(sha)) {
  const ok = await confirm(
    `Check out ${label}?`,
    'This will put your repository in a "detached HEAD" state. Create a branch if you want to keep commits made from here.',
    { confirmLabel: 'Check out' }
  )
  if (ok) await store().run(`Checking out ${label}`, (r) => git().checkout(r, sha))
}

export async function fetchAll() {
  const repo = store().activeTab
  const before = upstreamTip(store().repos[repo])
  if (await store().run('Fetching', (r) => git().fetch(r, undefined, true))) noteFetched(repo, before)
}

export type PullMode = 'ff' | 'ff-only' | 'rebase'

const PULL_LABELS: Record<PullMode, string> = { ff: 'Pull', 'ff-only': 'Pull (fast-forward only)', rebase: 'Pull (rebase)' }

/** Files with uncommitted changes git would have to pull over (untracked files only matter when the pull adds them). */
export function trackedChanges(repo: RepoTab): number {
  const st = repo.status
  if (!st) return 0
  const tracked = [...st.staged, ...st.unstaged.filter((f) => f.status !== 'untracked'), ...st.conflicted]
  return new Set(tracked.map((f) => f.path)).size
}

/** Pull the current branch; with uncommitted changes, offers to stash them first and pop them back after. */
export async function pull(mode: PullMode = 'ff'): Promise<boolean> {
  const repo = store().repos[store().activeTab]
  if (!repo) return false
  const changes = trackedChanges(repo)
  let stash = false
  if (changes > 0) {
    const files = changes === 1 ? '1 file has' : `${changes} files have`
    const res = await prompt({
      title: `${PULL_LABELS[mode]} with uncommitted changes?`,
      message: `${files} uncommitted changes. Git refuses to pull over changes to files the pull touches${mode === 'rebase' ? ', and rebasing needs a clean working copy' : ''}.`,
      checkboxes: [{ name: 'stash', label: 'Stash my changes first and pop them back after pulling', initial: true }],
      confirmLabel: 'Pull'
    })
    if (!res) return false
    stash = res.checks.stash
  }
  return pullCurrent(repo, mode, stash)
}

/**
 * Pull into the checked-out branch. `stash` puts uncommitted changes to tracked files aside first and pops them back
 * after (they stay on the stash list when popping conflicts). When the branch moved, the toast offers to move it back.
 */
export async function pullCurrent(repo: RepoTab, mode: PullMode, stash: boolean): Promise<boolean> {
  const branch = currentBranch(repo)
  const rev = branch ? `refs/heads/${branch}` : 'HEAD'
  let before: string | null = null
  let stashed = false
  let kept: string | null = null
  const ok = await store().run(
    `${stash ? 'Stashing and pulling' : 'Pulling'}${mode === 'rebase' ? ' (rebase)' : ''}`,
    async (r) => {
      before = await git().resolveRef(r, rev).catch(() => null)
      if (stash) {
        // only pop what this pull stashed: with nothing to stash, git creates no entry
        const top = await git().resolveRef(r, 'refs/stash').catch(() => null)
        await git().stashSave(r, `Auto-stash before ${PULL_LABELS[mode].toLowerCase()}`, false)
        stashed = (await git().resolveRef(r, 'refs/stash').catch(() => null)) !== top
      }
      try {
        await git().pull(r, mode)
      } catch (e) {
        // put the changes back before reporting; a pull stopped by conflicts leaves them on the stash list
        if (stashed) await git().stashPop(r, 0).catch((err: Error) => void (kept = err.message))
        throw e
      }
      if (stashed) await git().stashPop(r, 0).catch((err: Error) => void (kept = err.message))
    },
    { repo: repo.path }
  )
  // assigned inside the callback, which flow analysis does not follow
  const conflict = kept as string | null
  const didStash = stashed as boolean
  if (conflict) {
    store().toast({
      kind: 'error',
      title: ok ? 'Pulled, but your stashed changes conflict' : 'Your changes are still stashed',
      message: ok
        ? 'Resolve the conflicts in the working copy. The changes also stay on the stash list as stash@{0}.'
        : 'They could not be re-applied after the failed pull. Pop stash@{0} once the repository is clean again.',
      duration: 12_000
    })
  }
  const old = before as string | null
  if (!ok || conflict || !old) return ok
  dismissBehindNotice(repo.path)
  const after = await git().resolveRef(repo.path, rev).catch(() => null)
  const upstream = repo.status?.upstream ?? 'upstream'
  const message = didStash ? 'Your uncommitted changes were stashed and re-applied.' : undefined
  if (after === old) store().toast({ kind: 'success', title: `${branch ?? 'HEAD'} is up to date with ${upstream}`, message })
  else {
    offerUndo(repo.path, `Pull into ${branch ?? 'HEAD'}`, (r) => git().restoreBranch(r, branch, old), {
      title: `Pulled ${upstream} into ${branch ?? 'HEAD'}`,
      message
    })
  }
  return ok
}

/** Push the current branch; prompts for a remote/branch when no upstream is configured. */
export async function pushCurrent(repo: RepoTab, force = false) {
  const branch = currentBranch(repo)
  if (!branch) {
    store().toast({ kind: 'error', title: 'Cannot push', message: 'HEAD is detached. Check out a branch first.' })
    return
  }
  if (repo.remotes.length === 0) {
    store().toast({ kind: 'error', title: 'Cannot push', message: 'This repository has no remotes. Add one from the left panel.' })
    return
  }
  const upstream = repo.status?.upstream
  if (upstream) {
    if (!force) {
      await store().run('Pushing', (r) => git().push(r, { force }))
      return
    }
    const ok = await confirm(`Force push ${branch}?`, `This overwrites ${upstream} with your local ${branch}.`, {
      danger: true,
      confirmLabel: 'Force push',
      impact: forcePushImpact(repo, upstream)
    })
    if (ok) await forcePush(repo, branch, upstream)
    return
  }
  await publishCurrent(repo, force)
}

/** Push the current branch to a remote branch picked in a prompt, and make that its upstream. */
export async function publishCurrent(repo: RepoTab, force = false): Promise<boolean> {
  const branch = currentBranch(repo)
  if (!branch || repo.remotes.length === 0) {
    store().toast({ kind: 'error', title: 'Cannot push', message: branch ? 'This repository has no remotes. Add one from the left panel.' : 'HEAD is detached. Check out a branch first.' })
    return false
  }
  const names = repo.remotes.map((r) => r.name)
  const res = await prompt({
    title: `Push ${branch}`,
    message: `"${branch}" has no upstream branch. Choose where to push it.`,
    fields: [
      {
        name: 'remote',
        label: `Remote (${names.join(', ')})`,
        initial: defaultRemote(repo),
        validate: (v) => (names.includes(v.trim()) ? null : 'Unknown remote')
      },
      { name: 'branch', label: 'Remote branch name', initial: branch, validate: validateRefName }
    ],
    confirmLabel: 'Push'
  })
  if (!res) return false
  const target = res.branch.trim() === branch ? branch : `${branch}:${res.branch.trim()}`
  return store().run('Pushing', (r) => git().push(r, { remote: res.remote.trim(), branch: target, setUpstream: true, force }), { repo: repo.path })
}

/** Force push the current branch; the undo pushes the commit the remote branch had back (with a lease). */
async function forcePush(repo: RepoTab, branch: string, upstream: string) {
  const remoteRef = `refs/remotes/${upstream}`
  const before = await git().resolveRef(repo.path, remoteRef).catch(() => null)
  const ok = await store().run('Force pushing', (r) => git().push(r, { force: true }))
  const after = ok && before ? await git().resolveRef(repo.path, remoteRef).catch(() => null) : null
  if (!before || !after || after === before) return
  const remote = repo.remotes.map((r) => r.name).filter((name) => upstream.startsWith(name + '/')).sort((a, b) => b.length - a.length)[0]
  if (!remote) return
  const remoteBranch = upstream.slice(remote.length + 1)
  offerUndo(repo.path, `Force push ${branch}`, (r) => git().pushSha(r, remote, before, remoteBranch, after), {
    title: `Force pushed ${branch}`,
    message: `${upstream} was at ${shortSha(before)}`,
    actionLabel: 'Push old commit back',
    confirm: {
      title: `Restore ${upstream} to ${shortSha(before)}?`,
      message: `Force pushes ${shortSha(before)} back to ${upstream}, unless someone pushed to it since. Your local ${branch} is not changed.`,
      confirmLabel: 'Force push old commit'
    }
  })
}

export async function pushBranch(repo: RepoTab, ref: Ref, remote?: string) {
  const target = remote ?? remoteOf(ref) ?? defaultRemote(repo)
  if (!target) {
    store().toast({ kind: 'error', title: 'Cannot push', message: 'This repository has no remotes.' })
    return
  }
  await store().run(`Pushing ${ref.name}`, (r) => git().push(r, { remote: target, branch: ref.name, setUpstream: !ref.upstream }))
}

export async function stashChanges() {
  const res = await prompt({
    title: 'Stash changes',
    fields: [{ name: 'message', label: 'Message (optional)' }],
    checkboxes: [{ name: 'untracked', label: 'Include untracked files', initial: true }],
    confirmLabel: 'Stash'
  })
  if (!res) return
  await store().run('Stashing', (r) => git().stashSave(r, res.message.trim() || undefined, res.checks.untracked))
}

/** Pop a stash; the undo puts the work tree back as it was and restores the stash entry. */
export async function popStash(index = 0): Promise<boolean> {
  const repo = store().activeTab
  const stash = store().repos[repo]?.stashes.find((s) => s.index === index)
  let before: string | null = null
  const ok = await store().run('Popping stash', async (r) => {
    before = await git().snapshot(r)
    await git().stashPop(r, index)
  }, stash ? {} : { success: 'Stash popped' })
  if (ok && stash) {
    offerUndo(repo, `Pop ${stash.ref}`, (r) => git().undoStashPop(r, stash.sha, stash.message, before), { title: 'Stash popped', message: stash.message })
  }
  return ok
}

/** Delete a stash after confirmation; the undo puts its commit back on the stash list. */
export async function dropStash(stash: Stash): Promise<boolean> {
  if (!(await confirm(`Delete ${stash.ref}?`, stash.message, { danger: true, confirmLabel: 'Delete' }))) return false
  const repo = store().activeTab
  const ok = await store().run('Deleting stash', (r) => git().stashDrop(r, stash.index))
  if (ok) offerUndo(repo, `Delete ${stash.ref}`, (r) => git().stashStore(r, stash.sha, stash.message), { title: `Deleted ${stash.ref}`, message: stash.message })
  return ok
}

export function startInteractiveRebase(repo: RepoTab, onto: string) {
  const head = headSha(repo)
  if (!head) return
  const shas = commitsBetween(repo.commits, head, onto)
  if (shas.length === 0) {
    store().toast({ kind: 'info', title: 'Nothing to rebase', message: 'There are no commits between HEAD and the selected commit.' })
    return
  }
  store().setCenter({ kind: 'rebase', onto, shas })
}

const RESET_MESSAGES = {
  soft: 'Moves the branch; the changes of the commits it leaves stay staged.',
  mixed: 'Moves the branch and resets the index; the changes stay in the working copy.',
  hard: 'Moves the branch and discards all uncommitted changes to tracked files.'
}

/** Reset the current branch after a confirmation listing what it changes; the undo moves it back. */
export async function resetTo(sha: string, mode: 'soft' | 'mixed' | 'hard', branch: string) {
  const repo = store().repos[store().activeTab]
  if (!repo) return
  const verb = `${mode[0].toUpperCase()}${mode.slice(1)} reset`
  const ok = await confirm(`${verb} ${branch} to ${shortSha(sha)}?`, RESET_MESSAGES[mode], {
    danger: mode === 'hard',
    confirmLabel: verb,
    impact: resetImpact(repo, sha, mode, branch)
  })
  if (!ok) return
  let before: string | null = null
  let snapshot: string | null = null
  const done = await store().run(`Resetting (${mode})`, async (r) => {
    before = await git().resolveRef(r, 'HEAD')
    // reset --hard loses uncommitted changes to tracked files: keep them as a dangling stash commit
    if (mode === 'hard') snapshot = await git().snapshot(r)
    await git().reset(r, sha, mode)
  })
  const old = before as string | null
  if (!done || !old) return
  offerUndo(
    repo.path,
    `${verb} ${branch}`,
    async (r) => {
      // the same mode back: soft and mixed never touched the working copy, hard restores it from the snapshot
      await git().reset(r, old, mode)
      if (snapshot) await git().applySnapshot(r, snapshot)
    },
    { title: `${branch} reset to ${shortSha(sha)}` }
  )
}

async function renameBranch(ref: Ref) {
  const res = await prompt({
    title: `Rename ${ref.name}`,
    fields: [{ name: 'name', label: 'New name', initial: ref.name, validate: validateRefName }],
    confirmLabel: 'Rename'
  })
  if (!res || res.name.trim() === ref.name) return
  await store().run('Renaming branch', (r) => git().renameBranch(r, ref.name, res.name.trim()))
}

async function deleteLocalBranch(repo: RepoTab, ref: Ref) {
  const upstreamRemote = ref.upstream ? remoteOf(ref) : undefined
  const res = await prompt({
    title: `Delete ${ref.name}?`,
    message: 'The local branch will be deleted.',
    impact: deleteBranchImpact(repo, ref.name, currentBranch(repo)),
    checkboxes: [
      { name: 'force', label: 'Force delete even if not fully merged' },
      ...(upstreamRemote ? [{ name: 'remote', label: `Also delete ${ref.upstream!.replace('refs/remotes/', '')}` }] : [])
    ],
    danger: true,
    confirmLabel: 'Delete'
  })
  if (!res) return
  const remoteBranch = upstreamRemote ? ref.upstream!.replace(`refs/remotes/${upstreamRemote}/`, '') : null
  let localSha: string | null = null
  let remoteSha: string | null = null
  const ok = await store().run(`Deleting ${ref.name}`, async (r) => {
    const sha = await git().resolveRef(r, `refs/heads/${ref.name}`)
    await git().deleteBranch(r, ref.name, res.checks.force)
    localSha = sha
    if (res.checks.remote && upstreamRemote && remoteBranch) {
      remoteSha = await git().resolveRef(r, ref.upstream!)
      await git().deleteRemoteBranch(r, upstreamRemote, remoteBranch)
    }
  })
  const sha = localSha as string | null
  const deletedSha = remoteSha as string | null
  if (!sha) return
  offerUndo(
    repo.path,
    `Delete ${ref.name}`,
    async (r) => {
      await git().createBranch(r, ref.name, sha, false)
      if (deletedSha && upstreamRemote && remoteBranch) await git().pushSha(r, upstreamRemote, deletedSha, remoteBranch, null)
      if (ref.upstream) await git().setUpstream(r, ref.name, ref.upstream.replace('refs/remotes/', '')).catch(() => undefined)
    },
    { title: ok ? `Deleted ${ref.name}` : `Deleted the local ${ref.name}`, message: `It pointed at ${shortSha(sha)}` }
  )
}

async function deleteRemoteBranch(repo: RepoTab, ref: Ref) {
  const remote = remoteOf(ref)
  if (!remote) return
  const ok = await confirm(`Delete ${ref.name} from ${remote}?`, 'The branch will be deleted on the remote server.', { danger: true, confirmLabel: 'Delete' })
  if (!ok) return
  const name = remoteBranchName(ref)
  if (await store().run(`Deleting ${ref.name}`, (r) => git().deleteRemoteBranch(r, remote, name))) {
    offerUndo(repo.path, `Delete ${ref.name}`, (r) => git().pushSha(r, remote, ref.sha, name, null), {
      title: `Deleted ${ref.name}`,
      message: `It pointed at ${shortSha(ref.sha)}`,
      actionLabel: 'Push it back'
    })
  }
}

async function mergeIntoCurrent(repo: RepoTab, refName: string) {
  const current = currentBranch(repo) ?? 'HEAD'
  await runRestorable(`Merging ${refName}`, null, (r) => git().merge(r, refName), { success: `Merged ${refName} into ${current}`, undoLabel: `Merge into ${current}` })
}

async function rebaseCurrentOnto(repo: RepoTab, refName: string) {
  const current = currentBranch(repo) ?? 'HEAD'
  await runRestorable('Rebasing', null, (r) => git().rebase(r, refName), { success: `Rebased ${current} onto ${refName}`, undoLabel: `Rebase ${current}` })
}

export async function cherryPick(repo: RepoTab, shas: string[]) {
  const current = currentBranch(repo) ?? 'HEAD'
  const what = shas.length === 1 ? shortSha(shas[0]) : `${shas.length} commits`
  await runRestorable(`Cherry picking ${what}`, null, (r) => git().cherryPick(r, shas), {
    success: `Cherry-picked ${what} onto ${current}`,
    undoLabel: `Cherry-pick ${what}`
  })
}

const GITFLOW_PREFIXES = { feature: 'feature/', release: 'release/', hotfix: 'hotfix/' } as const

async function gitflowFinish(kind: keyof typeof GITFLOW_PREFIXES, name: string) {
  const res = await prompt({
    title: `Finish ${kind} ${name}`,
    fields: kind === 'feature' ? [] : [{ name: 'tagMessage', label: 'Tag message', initial: name }],
    checkboxes: [{ name: 'delete', label: 'Delete branch after finishing', initial: true }],
    confirmLabel: 'Finish'
  })
  if (!res) return
  await store().run(`Finishing ${kind}`, (r) =>
    git().gitflowFinish(r, kind, name, { tagMessage: res.tagMessage, deleteBranch: res.checks.delete })
  )
}

// ---------------------------------------------------------------------------------------------
// menus

export function commitMenuItems(repo: RepoTab, sha: string): MenuItem[] {
  const commit = repo.commits.find((c) => c.sha === sha)
  const head = headSha(repo)
  const branch = currentBranch(repo) ?? 'HEAD'
  const isHead = head === sha
  const ancestorOfHead = head ? !isHead && isAncestor(repo.commits, sha, head) : false
  const localsHere = repo.refs.filter((r) => r.type === 'local' && r.sha === sha && !r.isHead)
  const pair = repo.selection?.kind === 'commit' && repo.selection.shas.includes(sha) ? orderedPair(repo, repo.selection.shas) : null

  return [
    pair && { label: `Compare ${shortSha(pair[0])} and ${shortSha(pair[1])}`, onClick: () => openCompare(pair[0], pair[1]) },
    pair && 'separator',
    ...localsHere.map((ref) => ({
      label: worktreeForBranch(repo, ref.name) ? `Open worktree for ${ref.name}` : `Checkout ${ref.name}`,
      onClick: () => void checkoutRef(repo, ref)
    })),
    { label: 'Checkout this commit', onClick: () => void checkoutDetached(sha), disabled: isHead },
    { label: 'Create branch here', onClick: () => void createBranchAt(sha) },
    { label: 'Create tag here', onClick: () => void createTagAt(sha) },
    { label: 'Create worktree from this commit…', onClick: () => createWorktree(sha) },
    'separator',
    {
      label: 'Cherry pick commit',
      disabled: isHead || ancestorOfHead,
      onClick: () => void cherryPick(repo, [sha])
    },
    {
      label: 'Revert commit',
      onClick: async () => {
        if (await confirm(`Revert ${shortSha(sha)}?`, 'A new commit undoing these changes will be created.', { confirmLabel: 'Revert' }))
          await store().run('Reverting', (r) => git().revert(r, sha))
      }
    },
    {
      label: `Reset ${branch} to this commit`,
      disabled: isHead,
      submenu: [
        { label: 'Soft — keep all changes staged', onClick: () => void resetTo(sha, 'soft', branch) },
        { label: 'Mixed — keep working copy, reset index', onClick: () => void resetTo(sha, 'mixed', branch) },
        { label: 'Hard — discard all changes', danger: true, onClick: () => void resetTo(sha, 'hard', branch) }
      ]
    },
    {
      label: `Interactive rebase ${branch} children of ${shortSha(sha)}`,
      disabled: !ancestorOfHead,
      onClick: () => startInteractiveRebase(repo, sha)
    },
    { label: `Rebase ${branch} onto this commit`, disabled: isHead || ancestorOfHead, onClick: () => void rebaseCurrentOnto(repo, sha) },
    'separator',
    { label: 'Copy commit sha', onClick: () => copyText(sha, 'Commit sha copied') },
    commit && { label: 'Copy commit message', onClick: () => copyText(commit.body ? `${commit.summary}\n\n${commit.body}` : commit.summary, 'Commit message copied') }
  ]
}

export function branchMenuItems(repo: RepoTab, ref: Ref): MenuItem[] {
  const current = currentBranch(repo)
  const isCurrent = ref.type === 'local' && ref.isHead === true
  const s = store()
  const hidden = repo.hiddenRefs.includes(ref.fullName)
  const soloed = repo.soloRefs.includes(ref.fullName)
  const flowKind = (Object.keys(GITFLOW_PREFIXES) as (keyof typeof GITFLOW_PREFIXES)[]).find((k) => ref.type === 'local' && ref.name.startsWith(GITFLOW_PREFIXES[k]))
  const head = headSha(repo)
  const canInteractive = head ? head !== ref.sha && isAncestor(repo.commits, ref.sha, head) : false

  if (ref.type === 'remote') {
    const local = remoteBranchName(ref)
    return [
      { label: `Checkout ${local}`, onClick: () => void checkoutRef(repo, ref) },
      !!current && { label: `Merge ${ref.name} into ${current}`, onClick: () => void mergeIntoCurrent(repo, ref.name) },
      !!current && { label: `Rebase ${current} onto ${ref.name}`, onClick: () => void rebaseCurrentOnto(repo, ref.name) },
      !!current && canInteractive && { label: `Interactive rebase ${current} onto ${ref.name}`, onClick: () => startInteractiveRebase(repo, ref.sha) },
      ...compareRefMenuItems(repo, ref),
      { label: `Create branch here`, onClick: () => void createBranchAt(ref.sha) },
      { label: `Create worktree from ${ref.name}…`, onClick: () => createWorktree(ref.name) },
      'separator',
      { label: `Fetch ${ref.remote ?? 'remote'}`, onClick: () => void s.run('Fetching', (r) => git().fetch(r, ref.remote, true)) },
      { label: hidden ? 'Show in graph' : 'Hide in graph', onClick: () => s.toggleHidden(ref.fullName) },
      { label: soloed ? 'Unsolo' : 'Solo', onClick: () => s.toggleSolo(ref.fullName) },
      'separator',
      { label: 'Copy branch name', onClick: () => copyText(ref.name) },
      { label: `Delete ${ref.name}`, danger: true, onClick: () => void deleteRemoteBranch(repo, ref) }
    ]
  }

  const wt = worktreeForBranch(repo, ref.name)
  return [
    ...(wt ? branchWorktreeItems(repo, ref, wt).slice(0, 1) : []),
    !isCurrent && !wt && { label: `Checkout ${ref.name}`, onClick: () => void checkoutRef(repo, ref) },
    isCurrent && !!ref.upstream && { label: 'Pull (fast-forward if possible)', onClick: () => void pull('ff') },
    isCurrent ? { label: 'Push', onClick: () => void pushCurrent(repo) } : { label: `Push ${ref.name}`, onClick: () => void pushBranch(repo, ref) },
    repo.remotes.length > 0 && {
      label: 'Push to…',
      submenu: repo.remotes.map((rm) => ({ label: rm.name, onClick: () => void pushBranch(repo, ref, rm.name) }))
    },
    isCurrent && !!ref.upstream && { label: 'Force push', danger: true, onClick: () => void pushCurrent(repo, true) },
    repo.remotes.length > 0 && { label: 'Create pull request…', onClick: () => s.setModal({ kind: 'createPullRequest', head: ref.name }) },
    repo.remotes.length > 0 && {
      label: 'Set upstream…',
      onClick: async () => {
        const res = await prompt({
          title: `Set upstream for ${ref.name}`,
          fields: [{ name: 'upstream', label: 'Upstream branch', initial: ref.upstream?.replace('refs/remotes/', '') ?? `${defaultRemote(repo)}/${ref.name}` }],
          confirmLabel: 'Set upstream'
        })
        if (res) await s.run('Setting upstream', (r) => git().setUpstream(r, ref.name, res.upstream.trim()))
      }
    },
    'separator',
    !isCurrent && !!current && { label: `Merge ${ref.name} into ${current}`, onClick: () => void mergeIntoCurrent(repo, ref.name) },
    !isCurrent && !!current && { label: `Rebase ${current} onto ${ref.name}`, onClick: () => void rebaseCurrentOnto(repo, ref.name) },
    !isCurrent && !!current && canInteractive && { label: `Interactive rebase ${current} onto ${ref.name}`, onClick: () => startInteractiveRebase(repo, ref.sha) },
    ...compareRefMenuItems(repo, ref),
    flowKind && { label: `Gitflow: finish ${flowKind} ${ref.name.slice(GITFLOW_PREFIXES[flowKind].length)}`, onClick: () => void gitflowFinish(flowKind, ref.name.slice(GITFLOW_PREFIXES[flowKind].length)) },
    { label: 'Create branch here', onClick: () => void createBranchAt(ref.sha) },
    { label: 'Create tag here', onClick: () => void createTagAt(ref.sha) },
    { label: `Create worktree from ${ref.name}…`, onClick: () => createWorktree(ref.name) },
    'separator',
    { label: hidden ? 'Show in graph' : 'Hide in graph', disabled: isCurrent, onClick: () => s.toggleHidden(ref.fullName) },
    { label: soloed ? 'Unsolo' : 'Solo', onClick: () => s.toggleSolo(ref.fullName) },
    'separator',
    { label: 'Copy branch name', onClick: () => copyText(ref.name) },
    { label: `Rename ${ref.name}`, onClick: () => void renameBranch(ref) },
    wt ? branchWorktreeItems(repo, ref, wt)[1] : { label: `Delete ${ref.name}`, danger: true, disabled: isCurrent, onClick: () => void deleteLocalBranch(repo, ref) }
  ]
}

export function tagMenuItems(repo: RepoTab, ref: Ref): MenuItem[] {
  const s = store()
  return [
    { label: `Checkout ${ref.name}`, onClick: () => void checkoutRef(repo, ref) },
    { label: 'Create branch here', onClick: () => void createBranchAt(ref.sha) },
    ...compareRefMenuItems(repo, ref),
    'separator',
    repo.remotes.length > 0 && {
      label: 'Push tag to…',
      submenu: repo.remotes.map((rm) => ({ label: rm.name, onClick: () => void s.run('Pushing tag', (r) => git().pushTag(r, rm.name, ref.name)) }))
    },
    { label: repo.hiddenRefs.includes(ref.fullName) ? 'Show in graph' : 'Hide in graph', onClick: () => s.toggleHidden(ref.fullName) },
    { label: 'Copy tag name', onClick: () => copyText(ref.name) },
    'separator',
    {
      label: `Delete ${ref.name} locally`,
      danger: true,
      onClick: async () => {
        if (await confirm(`Delete tag ${ref.name}?`, undefined, { danger: true, confirmLabel: 'Delete' })) await s.run('Deleting tag', (r) => git().deleteTag(r, ref.name))
      }
    },
    repo.remotes.length > 0 && {
      label: 'Delete from remote',
      submenu: repo.remotes.map((rm) => ({
        label: rm.name,
        danger: true,
        onClick: async () => {
          if (await confirm(`Delete tag ${ref.name} from ${rm.name}?`, undefined, { danger: true, confirmLabel: 'Delete' }))
            await s.run('Deleting remote tag', (r) => git().deleteRemoteTag(r, rm.name, ref.name))
        }
      }))
    }
  ]
}

export function refMenuItems(repo: RepoTab, ref: Ref): MenuItem[] {
  if (ref.type === 'tag') return tagMenuItems(repo, ref)
  return branchMenuItems(repo, ref)
}

export function stashMenuItems(_repo: RepoTab, stash: Stash): MenuItem[] {
  const s = store()
  return [
    { label: 'Apply stash', onClick: () => void s.run('Applying stash', (r) => git().stashApply(r, stash.index)) },
    { label: 'Pop stash', onClick: () => void popStash(stash.index) },
    { label: 'Create branch from stash base', onClick: () => void createBranchAt(stash.baseSha) },
    'separator',
    { label: 'Copy stash message', onClick: () => copyText(stash.message) },
    { label: 'Delete stash', danger: true, onClick: () => void dropStash(stash) }
  ]
}

/** Context menu of a reflog entry in the recovery view. */
export function reflogMenuItems(repo: RepoTab, sha: string): MenuItem[] {
  const head = headSha(repo)
  const branch = currentBranch(repo) ?? 'HEAD'
  const loaded = repo.commits.some((c) => c.sha === sha)
  return [
    { label: 'Checkout this commit', disabled: sha === head, onClick: () => void checkoutDetached(sha) },
    { label: 'Create branch here', onClick: () => void createBranchAt(sha) },
    {
      label: `Reset ${branch} here`,
      disabled: sha === head,
      submenu: [
        { label: 'Soft — keep all changes staged', onClick: () => void resetTo(sha, 'soft', branch) },
        { label: 'Mixed — keep working copy, reset index', onClick: () => void resetTo(sha, 'mixed', branch) },
        { label: 'Hard — discard all changes', danger: true, onClick: () => void resetTo(sha, 'hard', branch) }
      ]
    },
    { label: 'Cherry pick commit', disabled: sha === head, onClick: () => void cherryPick(repo, [sha]) },
    'separator',
    { label: 'View in graph', disabled: !loaded, onClick: () => showInGraph(sha) },
    { label: 'Copy commit sha', onClick: () => copyText(sha, 'Commit sha copied') }
  ]
}

export function showInGraph(sha: string) {
  store().select({ kind: 'commit', shas: [sha] })
  store().setCenter({ kind: 'graph' })
}

export function remoteMenuItems(_repo: RepoTab, remote: Remote): MenuItem[] {
  const s = store()
  return [
    { label: `Fetch ${remote.name}`, onClick: () => void s.run(`Fetching ${remote.name}`, (r) => git().fetch(r, remote.name, true)) },
    {
      label: 'Edit remote URL',
      onClick: async () => {
        const res = await prompt({
          title: `Edit ${remote.name}`,
          fields: [{ name: 'url', label: 'URL', initial: remote.fetchUrl, validate: (v) => (v.trim() ? null : 'URL is required') }],
          confirmLabel: 'Save'
        })
        if (res) await s.run('Editing remote', (r) => git().editRemote(r, remote.name, res.url.trim()))
      }
    },
    { label: 'Copy remote URL', onClick: () => copyText(remote.fetchUrl) },
    'separator',
    {
      label: `Remove ${remote.name}`,
      danger: true,
      onClick: async () => {
        if (await confirm(`Remove remote ${remote.name}?`, 'Remote-tracking branches for this remote will be removed.', { danger: true, confirmLabel: 'Remove' }))
          await s.run('Removing remote', (r) => git().removeRemote(r, remote.name))
      }
    }
  ]
}

export async function addRemote() {
  const res = await prompt({
    title: 'Add remote',
    fields: [
      { name: 'name', label: 'Name', initial: 'origin', validate: validateRefName },
      { name: 'url', label: 'URL', placeholder: 'git@host:owner/repo.git', validate: (v) => (v.trim() ? null : 'URL is required') }
    ],
    confirmLabel: 'Add remote'
  })
  if (!res) return
  const ok = await store().run('Adding remote', (r) => git().addRemote(r, res.name.trim(), res.url.trim()))
  if (ok) await store().run('Fetching', (r) => git().fetch(r, res.name.trim(), false))
}

/** Menu shown when a branch pill is dropped onto another branch or commit row. */
export function dropMenuItems(repo: RepoTab, source: Ref, target: { ref?: Ref; sha: string }): MenuItem[] {
  const current = currentBranch(repo)
  const sourceName = source.name
  const t = target.ref
  if (t && t.fullName === source.fullName) return []
  const targetLabel = t ? t.name : shortSha(target.sha)
  const items: MenuItem[] = []

  if (t?.type === 'local') {
    const targetIsCurrent = t.isHead === true
    if (targetIsCurrent && isAncestor(repo.commits, t.sha, source.sha) && t.sha !== source.sha) {
      items.push({
        label: `Fast-forward ${t.name} to ${sourceName}`,
        onClick: () =>
          void runRestorable('Fast-forwarding', t.name, (r) => git().merge(r, sourceName, { ffOnly: true }), {
            success: `Fast-forwarded ${t.name} to ${sourceName}`,
            undoLabel: `Fast-forward ${t.name}`
          })
      })
    }
    items.push({
      label: `Merge ${sourceName} into ${t.name}`,
      onClick: () =>
        void runRestorable(
          `Merging ${sourceName}`,
          t.name,
          async (r) => {
            if (!targetIsCurrent) await git().checkout(r, t.name)
            await git().merge(r, sourceName)
          },
          { success: `Merged ${sourceName} into ${t.name}`, undoLabel: `Merge into ${t.name}` }
        )
    })
  } else if (current) {
    items.push({ label: `Merge ${targetLabel} into ${current}`, onClick: () => void mergeIntoCurrent(repo, t ? t.name : target.sha) })
  }

  if (source.type === 'local') {
    const onto = t ? t.name : target.sha
    items.push({
      label: `Rebase ${sourceName} onto ${targetLabel}`,
      onClick: () =>
        void runRestorable(
          'Rebasing',
          sourceName,
          async (r) => {
            if (!source.isHead) await git().checkout(r, sourceName)
            await git().rebase(r, onto)
          },
          { success: `Rebased ${sourceName} onto ${targetLabel}`, undoLabel: `Rebase ${sourceName}` }
        )
    })
    if (source.isHead && isAncestor(repo.commits, target.sha, source.sha) && target.sha !== source.sha) {
      items.push({ label: `Interactive rebase ${sourceName} onto ${targetLabel}`, onClick: () => startInteractiveRebase(repo, target.sha) })
    }
  }
  return items
}
