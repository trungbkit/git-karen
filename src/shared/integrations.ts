// Hosting integrations contract (plan 07): GitHub / GitLab pull requests, CI status and PR creation with the user's
// own tokens. Implemented in src-tauri/src/integrations; tokens stay in the OS keychain and never reach the renderer.

export type HostingKind = 'github' | 'gitlab' | 'bitbucket' | 'azure'

/** A host the app can talk to: the built-in public hosts plus self-hosted ones from Preferences. */
export interface HostingAccount {
  host: string
  kind: HostingKind
  label: string
  apiUrl: string
  webUrl: string
  builtIn: boolean
  /** Pull requests, CI and PR creation work (GitHub, GitLab); the others only get web links */
  apiSupported: boolean
  /** A token is available: saved in the keychain, or from the GitHub CLI */
  hasToken: boolean
  /** Login from the last successful connection test */
  user: string | null
  /** The token comes from the GitHub CLI (gh) instead of the keychain */
  gh: boolean
  /** The gh account used; null for whichever account is active in gh */
  ghUser: string | null
  /** Why gh could not give a token, when `gh` is set */
  ghError: string | null
}

/** An account the GitHub CLI is signed in to. */
export interface GhAccount {
  host: string
  login: string
  /** gh's active account for the host */
  active: boolean
}

/** What the GitHub CLI (gh) on this machine is signed in to. */
export interface GhStatus {
  installed: boolean
  version: string | null
  accounts: GhAccount[]
  /** Why the accounts could not be listed, when gh is installed */
  error: string | null
}

/** A self-hosted host. Empty URLs mean the default derived from the host. */
export interface HostConfig {
  host: string
  kind: HostingKind
  apiUrl: string
  webUrl: string
}

/** Where a repository is hosted, from its remote URL. */
export interface RepoHosting {
  remote: string
  kind: HostingKind
  label: string
  host: string
  /** "owner/repo", "group/sub/repo" (GitLab), "org/project/repo" (Azure) */
  path: string
  owner: string
  name: string
  webUrl: string
  /** Issue URL with `$1` for the number */
  issueUrl: string
  apiSupported: boolean
  /** A token is set for the host (or comes from the GitHub CLI) */
  connected: boolean
}

export type CiState = 'pending' | 'success' | 'failure' | 'neutral'

export interface CiCheck {
  name: string
  state: CiState
  url?: string
  description?: string
  /** The GitHub Actions job behind the check, whose log can be read with `jobLog` */
  jobId?: number
}

export interface CiStatus {
  state: CiState
  checks: CiCheck[]
}

export interface PullRequest {
  number: number
  title: string
  /** The description (cut to 4000 characters) */
  body: string
  url: string
  author: string
  draft: boolean
  headBranch: string
  headRepo: string | null
  /** Head branch lives in the same repository (not a fork) */
  sameRepo: boolean
  baseBranch: string
  /** ISO 8601 */
  updatedAt: string
  /** Combined check state of the head commit (GitHub only) */
  checks: CiState | null
  reviewers: string[]
  reviewRequested: boolean
  mine: boolean
}

export interface PullRequestList {
  viewer: string | null
  items: PullRequest[]
}

export interface CreatePullRequestInput {
  /** Remote of the repository the PR is opened in (default: upstream, origin, first remote) */
  baseRemote?: string | null
  /** Remote the head branch was pushed to (default: the base remote) */
  headRemote?: string | null
  base: string
  head: string
  title: string
  body: string
  draft: boolean
  /** Logins; "org/team" requests a team on GitHub */
  reviewers: string[]
}

export interface CreatedPullRequest {
  number: number
  url: string
  /** A PR between these branches was already open */
  existing: boolean
  warning: string | null
}

/** A comment or review in a pull request's conversation. */
export interface TimelineItem {
  kind: 'comment' | 'approved' | 'changes_requested' | 'commented' | 'dismissed'
  author: string
  body: string
  /** ISO 8601 */
  createdAt: string
  url: string
  /** Comments on lines of code a review carries */
  codeComments: number
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** A GitHub pull request in full: conversation, checks and merge state. */
export interface PullRequestDetail {
  number: number
  title: string
  body: string
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: string
  headBranch: string
  headSha: string
  sameRepo: boolean
  baseBranch: string
  additions: number
  deletions: number
  changedFiles: number
  /** 'unknown' while GitHub is still computing it */
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  /** clean, blocked, behind, dirty, unstable, has_hooks, draft, unknown */
  mergeState: string
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  /** Methods the repository allows */
  mergeMethods: MergeMethod[]
  defaultMergeMethod: MergeMethod
  /** The repository deletes head branches after merging by itself */
  deleteBranchOnMerge: boolean
  viewer: string | null
  checks: CiStatus | null
  /** Oldest first */
  timeline: TimelineItem[]
}

export interface MergeInput {
  method: MergeMethod
  title?: string | null
  message?: string | null
  /** Merge only if the head is still this commit */
  sha?: string | null
  /** Delete the head branch afterwards (never a fork's or the default branch) */
  deleteBranch: boolean
}

export interface MergeResult {
  sha: string | null
  branchDeleted: boolean
  warning: string | null
}

export type ReviewEvent = 'approve' | 'request_changes' | 'comment'

export interface JobStep {
  number: number
  name: string
  status: string
  conclusion: string | null
}

/** A GitHub Actions job and its log. */
export interface JobLog {
  jobId: number
  runId: number | null
  name: string
  workflow: string | null
  /** queued, in_progress, completed, … */
  status: string
  conclusion: string | null
  url: string
  steps: JobStep[]
  /** Empty until the job has finished */
  log: string
  /** Only the end of a longer log is in `log` */
  truncated: boolean
}

/** Commit message → link rule. `url` may use $0 (whole match) and $1…$9 (groups). */
export interface IssueLinkRule {
  pattern: string
  url: string
}

/** Per-repository issue link settings (Preferences > Integrations). */
export interface IssueLinkConfig {
  rules: IssueLinkRule[]
  /** Link #123 (and !123 on GitLab) to the hosting provider's issues */
  providerLinks: boolean
}

export interface AuthorAvatars {
  /** Avatar URL by sha, or null when the author isn't linked to a GitHub user */
  avatars: Record<string, string | null>
  /** Shas GitHub doesn't have (not pushed yet, or only on a fork) */
  unknown: string[]
}

export interface IntegrationsApi {
  accounts(): Promise<HostingAccount[]>
  saveHost(config: HostConfig): Promise<HostingAccount[]>
  removeHost(host: string): Promise<HostingAccount[]>
  /** Store (string) or remove (null) the token for a host in the OS keychain */
  setToken(host: string, token: string | null): Promise<HostingAccount[]>
  /** What the GitHub CLI is installed as and signed in to */
  ghStatus(): Promise<GhStatus>
  /** Take a GitHub host's token from the GitHub CLI (as `user`, or gh's active account when null), or stop (`enabled` false) */
  useGh(host: string, enabled: boolean, user: string | null): Promise<HostingAccount[]>
  /** Call the API with the stored token; returns who it belongs to */
  test(host: string): Promise<{ user: string; name: string | null }>
  /** Null when the remote isn't on a recognized provider */
  repoInfo(repo: string, remote?: string | null): Promise<RepoHosting | null>
  pullRequests(repo: string, remote?: string | null): Promise<PullRequestList>
  reviewerSuggestions(repo: string, remote?: string | null): Promise<string[]>
  createPullRequest(repo: string, input: CreatePullRequestInput): Promise<CreatedPullRequest>
  /** A GitHub pull request with its conversation, checks and merge state */
  pullRequest(repo: string, remote: string | null, number: number): Promise<PullRequestDetail>
  commentPullRequest(repo: string, remote: string | null, number: number, body: string): Promise<void>
  /** Submit a review; `body` is required except to approve */
  reviewPullRequest(repo: string, remote: string | null, number: number, input: { event: ReviewEvent; body: string }): Promise<void>
  mergePullRequest(repo: string, remote: string | null, number: number, input: MergeInput): Promise<MergeResult>
  /** A GitHub Actions job and (once it has finished) its log */
  jobLog(repo: string, remote: string | null, jobId: number): Promise<JobLog>
  /** Fetch and check out a PR; returns the local branch name */
  checkoutPullRequest(repo: string, remote: string | null, number: number, headBranch: string, sameRepo: boolean): Promise<string>
  /** Fetch a PR's base branch and head without checking anything out; returns the head commit */
  fetchPullRequest(repo: string, remote: string | null, number: number, headBranch: string, sameRepo: boolean, baseBranch: string): Promise<string>
  /** CI status by sha for the commits that have checks (cached in the backend; stale entries older than maxAgeSecs are refetched) */
  ciStatuses(repo: string, remote: string | null, shas: string[], maxAgeSecs: number): Promise<Record<string, CiStatus>>
  /** GitHub avatars of the commits' authors; shas in neither field weren't answered */
  authorAvatars(repo: string, remote: string | null, shas: string[]): Promise<AuthorAvatars>
}
