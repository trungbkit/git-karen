// Common git failures turned into a plain explanation and the actions that fix them (shown on the error toast).
// Pure: matches git's English messages (the backend runs git with LC_ALL=C). actions/errorActions.ts runs the actions.

/** Fixes a toast can offer; actions/errorActions.ts maps each to the app's own actions. */
export type GitFixAction =
  | 'pullRebaseThenPush'
  | 'pullRebase'
  | 'pushSetUpstream'
  | 'openConflicts'
  | 'openIdentity'
  | 'stashAndPull'
  | 'stashChanges'

export type GitErrorKind =
  | 'identity'
  | 'auth'
  | 'hostKey'
  | 'conflict'
  | 'nonFastForward'
  | 'diverged'
  | 'noUpstream'
  | 'detached'
  | 'localChanges'
  | 'untrackedInTheWay'
  | 'locked'
  | 'network'

export interface GitErrorHint {
  kind: GitErrorKind
  /** One or two sentences shown above git's own message */
  message: string
  actions: { id: GitFixAction; label: string }[]
}

interface Rule {
  kind: GitErrorKind
  test: RegExp
  /** `label` is the failed operation, e.g. "Pulling" */
  hint(label: string, error: string): Omit<GitErrorHint, 'kind'>
}

const isPull = (label: string) => /\bpull/i.test(label)

/** First match wins, so the more specific rules come first. */
const RULES: Rule[] = [
  {
    kind: 'identity',
    test: /Please tell me who you are|Author identity unknown|empty ident name|unable to auto-detect email address/i,
    hint: () => ({
      message: 'Git needs your name and email address to record who made the commit.',
      actions: [{ id: 'openIdentity', label: 'Set name and email' }]
    })
  },
  {
    kind: 'hostKey',
    test: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i,
    hint: () => ({
      message: 'SSH does not trust the server yet. Connect once from a terminal (e.g. ssh -T git@github.com) and accept its key, then try again.',
      actions: []
    })
  },
  {
    kind: 'auth',
    test: /Authentication failed|Permission denied \((?:publickey|keyboard-interactive)|could not read (?:Username|Password)|terminal prompts disabled|Invalid username or password|HTTP Basic: Access denied|The requested URL returned error: 40[13]|Repository not found|Permission to .+ denied to/i,
    hint: () => ({
      message:
        'The remote refused your credentials (or the repository is private and you are not signed in). Check the account and key or credential helper git uses for this remote, and the identity configured for it.',
      actions: [{ id: 'openIdentity', label: 'Open Git identity' }]
    })
  },
  {
    kind: 'conflict',
    test: /CONFLICT \(|Automatic merge failed|Merge conflict in|could not apply [0-9a-f]{4,}|fix conflicts and then commit|Resolve all conflicts manually|after resolving the conflicts|you need to resolve your current index first|needs merge/i,
    hint: () => ({
      message: 'Some files have conflicts. Resolve them in the conflict view, stage them, then continue (or abort) from the status bar.',
      actions: [{ id: 'openConflicts', label: 'Open conflict view' }]
    })
  },
  {
    kind: 'nonFastForward',
    test: /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)|Updates were rejected because (?:the tip of your current branch is behind|the remote contains work)/i,
    hint: () => ({
      message: 'The remote branch has commits you do not have yet. Pull them in, replaying your commits on top, then push again.',
      actions: [{ id: 'pullRebaseThenPush', label: 'Pull (rebase) & push' }]
    })
  },
  {
    kind: 'diverged',
    test: /Not possible to fast-forward|Need to specify how to reconcile divergent branches/i,
    hint: () => ({
      message: 'Your branch and its upstream both have new commits, so a fast-forward is not possible. Pull with rebase to put your commits on top.',
      actions: [{ id: 'pullRebase', label: 'Pull (rebase)' }]
    })
  },
  {
    kind: 'noUpstream',
    test: /has no upstream branch|no upstream configured for branch|There is no tracking information for the current branch/i,
    hint: (label) => ({
      message: isPull(label)
        ? 'This branch does not track a remote branch, so there is nothing to pull from. Publish it to set one up.'
        : 'This branch is not on a remote yet. Push it and set its upstream so later pushes and pulls know where to go.',
      actions: [{ id: 'pushSetUpstream', label: 'Push and set upstream' }]
    })
  },
  {
    kind: 'detached',
    test: /You are not currently on a branch/i,
    hint: () => ({ message: 'HEAD is detached. Create a branch here (or check one out) before pushing or pulling.', actions: [] })
  },
  {
    kind: 'untrackedInTheWay',
    test: /untracked working tree files would be (?:overwritten|removed)/i,
    hint: () => ({
      message: 'Untracked files are in the way of the incoming ones. Stash them (with untracked files), move or delete them, then try again.',
      actions: [{ id: 'stashChanges', label: 'Stash changes' }]
    })
  },
  {
    kind: 'localChanges',
    test: /Your local changes to the following files would be overwritten|Please commit your changes or stash them|cannot (?:pull with rebase|rebase): You have unstaged changes|Your index contains uncommitted changes|cannot (?:pull with rebase|rebase): Your index contains/i,
    hint: (label, error) =>
      isPull(label) && !/by checkout/i.test(error)
        ? {
            message: 'Uncommitted changes would be overwritten. Stash them, pull, and pop them back afterwards.',
            actions: [{ id: 'stashAndPull', label: 'Stash & pull' }]
          }
        : {
            message: 'Uncommitted changes would be overwritten. Commit or stash them first, then try again.',
            actions: [{ id: 'stashChanges', label: 'Stash changes' }]
          }
  },
  {
    kind: 'locked',
    test: /\.lock': File exists|Unable to create '[^']*\.lock'|another git process seems to be running/i,
    hint: () => ({
      message: 'Another git process is working in this repository. Wait for it to finish; if none is running (a crashed one left its lock), delete the .lock file named above.',
      actions: []
    })
  },
  {
    kind: 'network',
    test: /Could not resolve host|Connection timed out|Failed to connect to|Network is unreachable|Connection refused|Could not read from remote repository|unable to access '[^']*': (?:SSL|OpenSSL|LibreSSL|schannel)|Operation timed out/i,
    hint: () => ({ message: 'The remote could not be reached. Check your network connection, VPN or proxy and the remote URL.', actions: [] })
  }
]

/** The explanation and fixes for a git error message, or null when it is not a known kind of failure. */
export function describeGitError(error: string, label = ''): GitErrorHint | null {
  for (const rule of RULES) if (rule.test.test(error)) return { kind: rule.kind, ...rule.hint(label, error) }
  return null
}
