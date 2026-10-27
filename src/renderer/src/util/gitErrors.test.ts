import { describe, expect, it } from 'vitest'
import { describeGitError } from './gitErrors'

// Messages as the backend reports them: git's stderr (LC_ALL=C) without the "hint:" lines.
const kind = (error: string, label?: string) => describeGitError(error, label)?.kind ?? null
const actions = (error: string, label?: string) => describeGitError(error, label)?.actions.map((a) => a.id) ?? []

describe('describeGitError', () => {
  it('offers pull (rebase) then push when the remote has new commits', () => {
    const rejected = `To github.com:owner/repo.git
 ! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs to 'github.com:owner/repo.git'`
    expect(kind(rejected, 'Pushing')).toBe('nonFastForward')
    expect(actions(rejected, 'Pushing')).toEqual(['pullRebaseThenPush'])
    const fetchFirst = ` ! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'https://github.com/owner/repo.git'`
    expect(actions(fetchFirst)).toEqual(['pullRebaseThenPush'])
    expect(describeGitError(rejected)?.actions[0].label).toBe('Pull (rebase) & push')
  })

  it('does not treat a rejected force-with-lease as non-fast-forward', () => {
    expect(kind(' ! [rejected]        main -> main (stale info)\nerror: failed to push some refs to \'origin\'')).toBeNull()
  })

  it('offers push and set upstream for a branch without one', () => {
    const push = `fatal: The current branch topic has no upstream branch.
To push the current branch and set the remote as upstream, use

    git push --set-upstream origin topic`
    expect(kind(push, 'Pushing')).toBe('noUpstream')
    expect(actions(push, 'Pushing')).toEqual(['pushSetUpstream'])
    const pull = 'There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.'
    expect(actions(pull, 'Pulling')).toEqual(['pushSetUpstream'])
    expect(describeGitError(pull, 'Pulling')?.message).toMatch(/nothing to pull/)
  })

  it('opens the conflict view after a conflicting merge, rebase, cherry-pick or stash pop', () => {
    expect(actions('Auto-merging f\nCONFLICT (content): Merge conflict in f\nAutomatic merge failed; fix conflicts and then commit the result.')).toEqual(['openConflicts'])
    expect(kind('error: could not apply 1a2b3c4... change f\nResolve all conflicts manually, mark them as resolved with')).toBe('conflict')
    expect(kind('error: you need to resolve your current index first\nf: needs merge')).toBe('conflict')
    expect(kind('error: could not apply 1a2b3c4... msg', 'Cherry picking')).toBe('conflict')
  })

  it('sends authentication failures to the Git identity preferences', () => {
    for (const error of [
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/owner/repo.git/'",
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights',
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/a/b.git/'",
      "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
      'ERROR: Repository not found.\nfatal: Could not read from remote repository.'
    ]) {
      expect(kind(error, 'Fetching')).toBe('auth')
      expect(actions(error, 'Fetching')).toEqual(['openIdentity'])
    }
  })

  it('asks for a name and email when git has no identity', () => {
    const error = '*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n\nfatal: unable to auto-detect email address'
    expect(kind(error, 'Committing')).toBe('identity')
    expect(actions(error)).toEqual(['openIdentity'])
  })

  it('explains an unknown SSH host key without an action', () => {
    expect(describeGitError('Host key verification failed.\nfatal: Could not read from remote repository.')).toMatchObject({ kind: 'hostKey', actions: [] })
  })

  it('offers stash & pull when local changes block a pull, stash otherwise', () => {
    const merge = `error: Your local changes to the following files would be overwritten by merge:
	f
Please commit your changes or stash them before you merge.
Aborting`
    expect(actions(merge, 'Pulling')).toEqual(['stashAndPull'])
    expect(actions(merge, 'Merging')).toEqual(['stashChanges'])
    const checkout = 'error: Your local changes to the following files would be overwritten by checkout:\n\tf\nPlease commit your changes or stash them before you switch branches.\nAborting'
    expect(actions(checkout, 'Checking out main')).toEqual(['stashChanges'])
    expect(actions('error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.', 'Pulling (rebase)')).toEqual(['stashAndPull'])
  })

  it('recognises untracked files in the way', () => {
    expect(kind('error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt')).toBe('untrackedInTheWay')
  })

  it('suggests a rebase pull when a fast-forward is impossible', () => {
    expect(actions('fatal: Not possible to fast-forward, aborting.', 'Pulling')).toEqual(['pullRebase'])
    expect(kind('fatal: Need to specify how to reconcile divergent branches.')).toBe('diverged')
  })

  it('explains lock files, network failures and detached HEAD', () => {
    expect(kind("fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository")).toBe('locked')
    expect(kind("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com")).toBe('network')
    expect(kind('ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.')).toBe('network')
    expect(kind('fatal: You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)')).toBe('detached')
  })

  it('returns null for errors it does not know', () => {
    expect(describeGitError("fatal: invalid reference: nope")).toBeNull()
    expect(describeGitError('')).toBeNull()
  })
})
