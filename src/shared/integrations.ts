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
  hasToken: boolean
  /** Login from the last successful connection test */
  user: string | null
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
  /** A token is set for the host */
  connected: boolean
}

export type CiState = 'pending' | 'success' | 'failure' | 'neutral'

export interface CiCheck {
  name: string
  state: CiState
  url?: string
  description?: string
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

export interface IntegrationsApi {
  accounts(): Promise<HostingAccount[]>
  saveHost(config: HostConfig): Promise<HostingAccount[]>
  removeHost(host: string): Promise<HostingAccount[]>
  /** Store (string) or remove (null) the token for a host in the OS keychain */
  setToken(host: string, token: string | null): Promise<HostingAccount[]>
  /** Call the API with the stored token; returns who it belongs to */
  test(host: string): Promise<{ user: string; name: string | null }>
  /** Null when the remote isn't on a recognized provider */
  repoInfo(repo: string, remote?: string | null): Promise<RepoHosting | null>
  pullRequests(repo: string, remote?: string | null): Promise<PullRequestList>
  reviewerSuggestions(repo: string, remote?: string | null): Promise<string[]>
  createPullRequest(repo: string, input: CreatePullRequestInput): Promise<CreatedPullRequest>
  /** Fetch and check out a PR; returns the local branch name */
  checkoutPullRequest(repo: string, remote: string | null, number: number, headBranch: string, sameRepo: boolean): Promise<string>
  /** Fetch a PR's base branch and head without checking anything out; returns the head commit */
  fetchPullRequest(repo: string, remote: string | null, number: number, headBranch: string, sameRepo: boolean, baseBranch: string): Promise<string>
  /** CI status by sha for the commits that have checks (cached in the backend; stale entries older than maxAgeSecs are refetched) */
  ciStatuses(repo: string, remote: string | null, shas: string[], maxAgeSecs: number): Promise<Record<string, CiStatus>>
}
