// Shared contract between the main process (git backend) and the renderer.
// Everything that crosses the IPC boundary must be plain, structured-cloneable data.
import type { IssueLinkConfig } from './integrations'

export interface Signature {
  name: string
  email: string
  /** Unix epoch milliseconds */
  date: number
}

export interface Commit {
  sha: string
  parents: string[]
  author: Signature
  committer: Signature
  /** First line of the message */
  summary: string
  /** Rest of the message after the summary (may be empty) */
  body: string
  /** Ref names pointing at this commit, e.g. "refs/heads/main", "refs/tags/v1" */
  refs: string[]
}

export type RefType = 'local' | 'remote' | 'tag' | 'stash' | 'head'

export interface Ref {
  /** Full ref name, e.g. "refs/heads/main" */
  fullName: string
  /** Short display name, e.g. "main", "origin/main", "v1.0" */
  name: string
  type: RefType
  sha: string
  /** For local branches: upstream full name, e.g. "refs/remotes/origin/main" */
  upstream?: string
  ahead?: number
  behind?: number
  /** For remote branches: remote name */
  remote?: string
  isHead?: boolean
  /** For annotated tags: tag message */
  message?: string
  /** Committer date of the commit the ref points at (Unix epoch milliseconds) */
  date?: number
  /** Author of the commit the ref points at */
  author?: string
  /** Summary of the commit the ref points at */
  summary?: string
  /** Remote branch its remote's HEAD points at (the remote's default branch) */
  isDefault?: boolean
}

export interface Stash {
  index: number
  /** "stash@{0}" */
  ref: string
  sha: string
  message: string
  date: number
  /** SHA of the commit the stash was based on */
  baseSha: string
}

export interface Remote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface Submodule {
  name: string
  path: string
  url: string
  sha: string
  /** ' ' in sync, '-' not initialised, '+' out of sync, 'U' conflicts */
  state: 'clean' | 'uninitialized' | 'modified' | 'conflict'
}

export interface Worktree {
  path: string
  head: string
  branch?: string
  isMain: boolean
  locked: boolean
  lockReason?: string
  detached: boolean
  prunable: boolean
  /** Uncommitted changes of a linked worktree (absent for the worktree that was queried) */
  changes?: WorktreeChanges
}

export interface WorktreeChanges {
  modified: number
  added: number
  deleted: number
  conflicted: number
}

export type FileStatusCode =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechange'

export interface FileChange {
  path: string
  oldPath?: string
  status: FileStatusCode
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface WorkingStatus {
  branch: string | null
  detached: boolean
  headSha: string | null
  upstream?: string
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  conflicted: FileChange[]
  /** In-progress operation, if any */
  operation: RepoOperation | null
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'meta'
  content: string
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath?: string
  binary: boolean
  hunks: DiffHunk[]
  /** Raw patch header lines (diff --git ..., index ..., ---, +++) needed to rebuild partial patches */
  headerLines: string[]
  isNew?: boolean
  isDeleted?: boolean
}

export interface CommitStats {
  additions: number
  deletions: number
  files: number
}

export interface CommitDetail {
  commit: Commit
  files: FileChange[]
}

/** Two revisions side by side: `ahead` commits are only on `to`, `behind` only on `from`. */
export interface CommitComparison {
  /** null when the histories share no commit */
  mergeBase: string | null
  /** Changes of `to` against the merge base (three-dot) or against `from` (two-dot) */
  files: FileChange[]
  /** Newest first, at most 500 */
  ahead: Commit[]
  behind: Commit[]
  aheadCount: number
  behindCount: number
}

export interface BlameLine {
  sha: string
  author: string
  date: number
  summary: string
  line: number
  content: string
  /** Line number in the commit's version of the file */
  origLine: number
  /** The file's path in that commit (differs after renames, or for lines copied from another file) */
  path: string
  /** The commit's parent and the file's path there; absent where the line's commit created the file */
  previous?: { sha: string; path: string }
}

/** A commit of a file's history (`git log --follow`) with the file's path in it. */
export interface FileHistoryCommit extends Commit {
  path: string
  /** Path before the commit when it renamed or copied the file */
  oldPath?: string
}

/** A file's contents at a revision, for image diffs. */
export interface ImageBlob {
  base64: string
  /** Bytes */
  size: number
}

export type DiffTarget =
  | { kind: 'working'; path: string; staged: boolean }
  /** `oldPath` (where a renamed file came from) makes the diff show the rename */
  | { kind: 'commit'; sha: string; path: string; oldPath?: string }
  | { kind: 'compare'; from: string; to: string; path: string }

export interface DiffOptions {
  /** Lines of context around each change (git's default is 3) */
  context?: number
  ignoreWhitespace?: boolean
}

/** `keep` moves HEAD like hard but refuses to overwrite uncommitted changes (used by undo) */
export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep'

export interface RebaseTodoItem {
  action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop' | 'edit'
  sha: string
  /** New message, used for reword/squash */
  message?: string
}

export interface LogOptions {
  /** Max commits to return. Default 2000. */
  limit?: number
  skip?: number
  /** Include all refs (branches, remotes, tags, stashes). Default true. */
  all?: boolean
}

export interface ConflictFile {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  /** Current working-tree content (with conflict markers) */
  merged: string
}

/** One HEAD reflog record, newest first. */
export interface ReflogEntry {
  index: number
  /** "HEAD@{3}" */
  selector: string
  sha: string
  /** What moved HEAD, e.g. "commit", "checkout", "reset", "rebase (finish)" */
  action: string
  message: string
  /** Unix epoch milliseconds */
  date: number
}

/** Work-tree content of a file saved before a discard; `blob` is null when the file did not exist. */
export interface FileBackup {
  path: string
  blob: string | null
  executable: boolean
}

/** What discarding work-tree changes would lose. */
export interface DiscardImpact {
  files: number
  additions: number
  deletions: number
  untracked: number
  binary: number
}

export interface BranchImpact {
  /** Commits of the branch missing from HEAD */
  unmerged: number
  /** Commits reachable from no other branch, remote branch or tag */
  orphaned: number
}

/** Someone who authored recent commits (for Co-authored-by trailers), most commits first. */
export interface Author {
  name: string
  email: string
  commits: number
}

/** Signature of a signed commit. `unverified`: git cannot check it (key unknown, no allowed signers file). */
export interface CommitSignature {
  status: 'good' | 'untrusted' | 'expired' | 'revoked' | 'bad' | 'unverified'
  format: 'openpgp' | 'ssh' | 'x509'
  signer: string | null
  key: string | null
}

export interface CommitOptions {
  amend?: boolean
  noVerify?: boolean
  /** Add a Signed-off-by trailer */
  signoff?: boolean
  /** true signs (-S), false never signs, absent follows commit.gpgsign */
  sign?: boolean
}

export interface RepoInfo {
  path: string
  name: string
  gitDir: string
  isBare: boolean
}

/** A repository found by scanning the discovery folders (`AppApi.discoverRepos`). */
export interface DiscoveredRepo {
  path: string
  name: string
  /** Last change to its index or HEAD (Unix epoch milliseconds), 0 when unknown */
  modified: number
}

export interface RecentRepo {
  path: string
  name: string
  lastOpened: number
  favorite?: boolean
}

/** A named list of repositories shown together in the workspace view. */
export interface Workspace {
  name: string
  /** Repository paths */
  repos: string[]
}

/** What the workspace view shows for a repository (one `git status`, no line counts). */
export interface RepoSummary {
  branch: string | null
  detached: boolean
  headSha: string | null
  upstream?: string
  ahead: number
  behind: number
  /** Files with uncommitted changes (staged, unstaged, untracked or conflicted); an untracked folder counts once */
  changes: number
  conflicted: number
  operation: RepoOperation | null
}

/** Graph search filters that need the history itself (`path:` and `content:`). */
export interface SearchLogOptions {
  /** Pathspecs; a commit matches when it touches any of them */
  paths?: string[]
  /** Commits that add or remove this string (`git log -S`) */
  content?: string
  /** Oldest commit date to walk to (Unix epoch milliseconds) */
  since?: number
  limit?: number
}

/**
 * A path to open from outside the window: the command line (or Finder / the Dock), a karen:// link,
 * or a file or folder dropped on the window.
 */
export interface OpenRequest {
  path: string
  source: 'cli' | 'link' | 'drop'
}

/** The `karen [path]` command line tool. */
export interface CliStatus {
  /** macOS and Linux */
  supported: boolean
  installed: boolean
  /** Where the command goes on the PATH */
  linkPath: string
  /** The script the link points to */
  scriptPath: string
  /** Shell command that installs it with elevated rights */
  manualCommand: string
}

export interface Preferences {
  /** 'system' follows the OS light/dark setting (dark or light theme), live */
  theme: ThemeName | 'system'
  /** Custom accent colour (#rrggbb); empty uses the theme's own */
  accentColor: string
  /** Row heights of the graph, file lists and left panel (CSS `--row-h`) */
  density: 'comfortable' | 'compact'
  autoFetchMinutes: number
  defaultBranchName: string
  commitLimit: number
  showAuthorColumn: boolean
  showDateColumn: boolean
  showShaColumn: boolean
  /** Graph "Changes" column: +/- bar and file count per commit */
  showChangesColumn: boolean
  /** Show the commit description after the summary in the graph */
  showCommitDescription: boolean
  /** Gravatar avatars on graph nodes (falls back to initials) */
  showAvatars: boolean
  /** 'rich' = avatar nodes (22px lanes), 'compact' = small dots (10px lanes) */
  graphMode: 'rich' | 'compact'
  /** A WIP row in the graph for every other worktree with uncommitted changes */
  showWorktreeWips: boolean
  /** Persisted graph column widths, keyed by column id */
  graphColumnWidths: Record<string, number>
  externalEditor: string
  /** Arguments opening a file at a line, with {file} and {line}; empty picks them from the editor's name */
  editorLineArgs: string
  externalTerminal: string
  diffTool: string
  mergeTool: string
  rememberTabs: boolean
  dateFormat: 'relative' | 'absolute'
  pushAfterCommit: boolean
  /** Terminal button toggles the built-in terminal (false: opens the external terminal) */
  useInAppTerminal: boolean
  /** git -c gpg / signing handled by user's git config */
  fontSize: number
  /** Colour code in diff, blame and merge views */
  syntaxHighlighting: boolean
  /** Main layout column widths (px), set by dragging the panel splitters */
  leftPanelWidth: number
  rightPanelWidth: number
  /** Smart commit: comma-separated branches to open pull requests against */
  smartCommitTargets: string
  /** Smart commit: comma-separated branches that are only merged through the hosting UI, never locally */
  protectedBranches: string
  /** Order of branches in the left panel: by name, or most recent commit first */
  branchSort: 'name' | 'date'
  /** Left panel folders opened or closed by hand, by repo path, then folder key (true = collapsed) */
  collapsedGroups: Record<string, Record<string, boolean>>
  /** Saved graph views, by repo path */
  viewPresets: Record<string, ViewPreset[]>
  /** Issue links in commit messages, by repo path (absent = provider #123 links only) */
  issueLinks: Record<string, IssueLinkConfig>
  /** Commit composer: Conventional Commits type and scope pickers, and a lint for the format */
  conventionalCommits: boolean
  /** Latest commit messages, newest first, by repo path */
  commitHistory: Record<string, string[]>
  /** Folders the welcome screen scans for repositories (two levels deep); `~` is the home folder */
  repoScanDirs: string[]
  /** The first-run guide on the welcome screen was finished or dismissed */
  onboardingDone: boolean
  /** Guide steps already done: 'open', 'palette', 'shortcuts' */
  onboardingSteps: string[]
}

export type ThemeName = 'dark' | 'light' | 'nord' | 'solarized'

/** Preferences a graph view preset captures. */
export const GRAPH_VIEW_KEYS = [
  'showAuthorColumn',
  'showDateColumn',
  'showShaColumn',
  'showChangesColumn',
  'showCommitDescription',
  'showAvatars',
  'graphMode',
  'graphColumnWidths'
] as const

export type GraphViewPrefs = Pick<Preferences, (typeof GRAPH_VIEW_KEYS)[number]>

/** A named graph view: hidden and soloed refs, columns, column widths and graph style. */
export interface ViewPreset {
  name: string
  hiddenRefs: string[]
  soloRefs: string[]
  view: GraphViewPrefs
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'dark',
  accentColor: '',
  density: 'comfortable',
  autoFetchMinutes: 1,
  defaultBranchName: 'main',
  commitLimit: 2000,
  showAuthorColumn: true,
  showDateColumn: true,
  showShaColumn: false,
  showChangesColumn: false,
  showCommitDescription: true,
  showAvatars: true,
  graphMode: 'rich',
  showWorktreeWips: true,
  graphColumnWidths: {},
  externalEditor: 'code',
  editorLineArgs: '',
  externalTerminal: 'Terminal',
  diffTool: '',
  mergeTool: '',
  rememberTabs: true,
  dateFormat: 'relative',
  pushAfterCommit: false,
  useInAppTerminal: true,
  fontSize: 13,
  syntaxHighlighting: true,
  leftPanelWidth: 260,
  rightPanelWidth: 380,
  smartCommitTargets: 'uat,main',
  protectedBranches: 'main,master,uat,staging',
  branchSort: 'name',
  collapsedGroups: {},
  viewPresets: {},
  issueLinks: {},
  conventionalCommits: false,
  commitHistory: {},
  repoScanDirs: ['~/Projects', '~/git', '~/Personal'],
  onboardingDone: false,
  onboardingSteps: []
}

export interface AppState {
  recent: RecentRepo[]
  openTabs: string[]
  activeTab: string | null
  preferences: Preferences
  workspaces: Workspace[]
}

/** Long-running git output streamed to the renderer (fetch/pull/push/clone progress). */
export interface ProgressEvent {
  repo: string
  op: string
  message: string
}

/** What each step of the smart commit pipeline (stage -> commit -> push -> PR) would have to do. */
export interface SmartStatus {
  branch: string | null
  /** origin, or the first remote */
  remote: string | null
  hasCommits: boolean
  /** Tracked files modified but not staged */
  unstaged: boolean
  untracked: boolean
  staged: boolean
  /** The branch has commits the remote lacks (or isn't on the remote at all). Assumes a fresh fetch. */
  unpushed: boolean
  /** The GitHub CLI is installed */
  gh: boolean
}

/** Raw changes a commit would contain, for the AI to describe. */
export interface PendingDiff {
  diff: string
  /** New files (they appear in no diff); empty unless unstaged changes were included */
  untracked: string[]
}

/** What a pull request from a branch into `remote/target` would contain. */
export interface BranchComparison {
  targetExists: boolean
  /** Subjects of the commits the branch adds, newest first */
  commits: string[]
  stat: string
  diff: string
}

export interface PrTemplate {
  path: string
  content: string
}

export interface PullRequestResult {
  status: 'created' | 'exists' | 'skipped'
  url?: string
  /** Why it was skipped */
  message?: string
}

/**
 * The API exposed on `window.git` and `window.app` (installed by src/renderer/src/platform/bridge.ts).
 * Every repo-scoped call takes the repo path as its first argument.
 */
export interface GitApi {
  // repository lifecycle
  open(path: string): Promise<RepoInfo>
  init(path: string, defaultBranch?: string): Promise<RepoInfo>
  clone(url: string, dest: string): Promise<RepoInfo>

  // reading
  log(repo: string, opts?: LogOptions): Promise<Commit[]>
  refs(repo: string): Promise<Ref[]>
  stashes(repo: string): Promise<Stash[]>
  remotes(repo: string): Promise<Remote[]>
  submodules(repo: string): Promise<Submodule[]>
  worktrees(repo: string): Promise<Worktree[]>
  status(repo: string): Promise<WorkingStatus>
  commitDetail(repo: string, sha: string): Promise<CommitDetail>
  /** `threeDot` (default true) diffs against the merge base, like `git diff from...to` */
  compareCommits(repo: string, from: string, to: string, threeDot?: boolean): Promise<CommitComparison>
  diff(repo: string, target: DiffTarget, opts?: DiffOptions): Promise<FileDiff | null>
  fileContent(repo: string, rev: string | null, path: string): Promise<string>
  /** Follows moved and copied lines (`-M -C`); `rev` blames the file as it was in that commit */
  blame(repo: string, path: string, rev?: string): Promise<BlameLine[]>
  /** Follows renames: each commit carries the file's path in it */
  fileHistory(repo: string, path: string, limit?: number): Promise<FileHistoryCommit[]>
  /** The file's bytes in the working copy (`rev` null), the index (`rev` '') or a revision; null when absent there */
  imageBlob(repo: string, rev: string | null, path: string): Promise<ImageBlob | null>
  searchCommits(repo: string, query: string, limit?: number): Promise<Commit[]>
  /** Shas of graph commits (newest first) matching the path / content filters */
  searchLog(repo: string, opts: SearchLogOptions): Promise<string[]>
  repoSummary(repo: string): Promise<RepoSummary>
  /** Line/file counts per commit (merges are diffed against their first parent). */
  commitStats(repo: string, shas: string[]): Promise<Record<string, CommitStats>>
  conflict(repo: string, path: string): Promise<ConflictFile>

  // staging
  stage(repo: string, paths: string[]): Promise<void>
  unstage(repo: string, paths: string[]): Promise<void>
  stageAll(repo: string): Promise<void>
  unstageAll(repo: string): Promise<void>
  discard(repo: string, paths: string[]): Promise<void>
  /** Apply a (partial) patch to the index (stage) or reverse-apply it (unstage), or to the work tree (discard). */
  applyPatch(repo: string, patch: string, opts: { cached: boolean; reverse: boolean }): Promise<void>
  resolveConflict(repo: string, path: string, content: string): Promise<void>
  takeSide(repo: string, paths: string[], side: 'ours' | 'theirs'): Promise<void>
  ignore(repo: string, pattern: string): Promise<void>

  // committing
  commit(repo: string, message: string, opts?: CommitOptions): Promise<string>
  headMessage(repo: string): Promise<string>
  /** Contents of the file `commit.template` points at, or null */
  commitTemplate(repo: string): Promise<string | null>
  /** Authors of the latest `limit` commits on all branches (default 500) */
  recentAuthors(repo: string, limit?: number): Promise<Author[]>
  /** Sign a throwaway commit object, optionally with another gpg.format / user.signingkey; resolves to the format used */
  testSigning(repo: string | null, format?: string | null, key?: string | null): Promise<string>
  /** null when the commit is not signed */
  signatureStatus(repo: string, sha: string): Promise<CommitSignature | null>
  /** Staged and unstaged changes of every tracked file against HEAD (untracked files excluded) */
  headDiff(repo: string): Promise<FileDiff[]>

  // branches & tags
  createBranch(repo: string, name: string, startPoint?: string, checkout?: boolean): Promise<void>
  deleteBranch(repo: string, name: string, force?: boolean): Promise<void>
  deleteRemoteBranch(repo: string, remote: string, name: string): Promise<void>
  renameBranch(repo: string, oldName: string, newName: string): Promise<void>
  checkout(repo: string, ref: string): Promise<void>
  /** Checkout a remote branch, creating a local tracking branch */
  checkoutRemote(repo: string, remoteRef: string, localName?: string): Promise<void>
  setUpstream(repo: string, branch: string, upstream: string): Promise<void>
  createTag(repo: string, name: string, sha: string, message?: string): Promise<void>
  deleteTag(repo: string, name: string): Promise<void>
  pushTag(repo: string, remote: string, name: string): Promise<void>
  deleteRemoteTag(repo: string, remote: string, name: string): Promise<void>

  // history manipulation
  merge(repo: string, ref: string, opts?: { ffOnly?: boolean; noFf?: boolean; squash?: boolean }): Promise<void>
  rebase(repo: string, onto: string): Promise<void>
  interactiveRebase(repo: string, onto: string, todo: RebaseTodoItem[]): Promise<void>
  cherryPick(repo: string, shas: string[]): Promise<void>
  revert(repo: string, sha: string): Promise<void>
  reset(repo: string, sha: string, mode: ResetMode): Promise<void>
  continueOperation(repo: string): Promise<void>
  abortOperation(repo: string): Promise<void>
  skipOperation(repo: string): Promise<void>

  // stashes
  stashSave(repo: string, message?: string, includeUntracked?: boolean): Promise<void>
  stashApply(repo: string, index: number): Promise<void>
  stashPop(repo: string, index: number): Promise<void>
  stashDrop(repo: string, index: number): Promise<void>

  // remotes
  fetch(repo: string, remote?: string, prune?: boolean): Promise<void>
  pull(repo: string, mode?: 'ff' | 'ff-only' | 'rebase'): Promise<void>
  push(repo: string, opts?: { remote?: string; branch?: string; force?: boolean; setUpstream?: boolean }): Promise<void>
  addRemote(repo: string, name: string, url: string): Promise<void>
  removeRemote(repo: string, name: string): Promise<void>
  editRemote(repo: string, name: string, url: string): Promise<void>

  // submodules & worktrees
  submoduleUpdate(repo: string, path?: string): Promise<void>
  submoduleAdd(repo: string, url: string, path: string): Promise<void>
  worktreeAdd(repo: string, path: string, ref: string, newBranch?: string, lock?: boolean): Promise<void>
  worktreeRemove(repo: string, path: string, force?: boolean): Promise<void>
  worktreeLock(repo: string, path: string, lock: boolean, reason?: string): Promise<void>
  worktreePrune(repo: string): Promise<void>

  // config
  getConfig(repo: string | null, key: string): Promise<string | null>
  setConfig(repo: string | null, key: string, value: string, global?: boolean): Promise<void>
  /** Remove a config key (no error when it is not set) */
  unsetConfig(repo: string | null, key: string, global?: boolean): Promise<void>

  // gitflow (git-flow-avh style, implemented natively)
  gitflowInit(repo: string, config: GitflowConfig): Promise<void>
  gitflowConfig(repo: string): Promise<GitflowConfig | null>
  gitflowStart(repo: string, kind: GitflowKind, name: string): Promise<void>
  gitflowFinish(repo: string, kind: GitflowKind, name: string, opts?: { tagMessage?: string; deleteBranch?: boolean }): Promise<void>

  // lfs
  lfsInstalled(repo: string): Promise<boolean>
  lfsTrack(repo: string, pattern: string): Promise<void>
  lfsCommand(repo: string, cmd: 'fetch' | 'pull' | 'push' | 'prune' | 'checkout'): Promise<void>

  // smart commit (AI commit messages and pull requests)
  smartStatus(repo: string): Promise<SmartStatus>
  pendingDiff(repo: string, includeUnstaged: boolean): Promise<PendingDiff>
  compareBranch(repo: string, from: string, target: string, remote: string): Promise<BranchComparison>
  prTemplate(repo: string): Promise<PrTemplate | null>
  /** Open a GitHub PR with the gh CLI, unless the branches aren't on the remote, nothing is new, or one is open */
  createPullRequest(repo: string, remote: string, from: string, to: string, title: string, body: string): Promise<PullRequestResult>

  // undo & recovery
  /** HEAD reflog, newest first (default limit 1000) */
  reflog(repo: string, limit?: number): Promise<ReflogEntry[]>
  /** Commit a revision points at, or null when it does not exist */
  resolveRef(repo: string, rev: string): Promise<string | null>
  /** Commits reachable from `include` but from none of `exclude` */
  countCommits(repo: string, include: string, exclude?: string[]): Promise<number>
  branchImpact(repo: string, branch: string): Promise<BranchImpact>
  discardImpact(repo: string, paths: string[]): Promise<DiscardImpact>
  /** Dangling stash commit of the uncommitted changes to tracked files (null when there are none) */
  snapshot(repo: string): Promise<string | null>
  applySnapshot(repo: string, sha: string): Promise<void>
  /** Put a stash commit back on the stash list */
  stashStore(repo: string, sha: string, message: string): Promise<void>
  /** Revert a stash pop: drop its changes, re-apply the `snapshot` taken before it and restore the entry */
  undoStashPop(repo: string, sha: string, message: string, snapshot: string | null): Promise<void>
  /** Move a branch back to `sha`; the checked-out branch (or detached HEAD, `branch` null) via reset --keep */
  restoreBranch(repo: string, branch: string | null, sha: string): Promise<void>
  backupFiles(repo: string, paths: string[]): Promise<FileBackup[]>
  restoreFiles(repo: string, backups: FileBackup[]): Promise<void>
  /** Push a commit to `remote/branch`; with `lease` it is forced only while the remote is still at that commit */
  pushSha(repo: string, remote: string, sha: string, branch: string, lease?: string | null): Promise<void>

  // watching
  watch(repo: string): Promise<void>
  unwatch(repo: string): Promise<void>
}

export type GitflowKind = 'feature' | 'release' | 'hotfix'

export interface GitflowConfig {
  master: string
  develop: string
  feature: string
  release: string
  hotfix: string
  versionTag: string
}

export interface AppApi {
  getState(): Promise<AppState>
  setOpenTabs(tabs: string[], active: string | null): Promise<void>
  addRecent(path: string): Promise<RecentRepo[]>
  toggleFavorite(path: string): Promise<RecentRepo[]>
  removeRecent(path: string): Promise<RecentRepo[]>
  setPreferences(prefs: Partial<Preferences>): Promise<Preferences>
  pickDirectory(title?: string): Promise<string | null>
  openExternal(url: string): Promise<void>
  showInFolder(path: string): Promise<void>
  /** With a line, opens the file there (see `Preferences.editorLineArgs`) */
  openInEditor(repo: string, file?: string, line?: number): Promise<void>
  openTerminal(repo: string): Promise<void>
  /** Replace every workspace (names must be unique) */
  setWorkspaces(workspaces: Workspace[]): Promise<Workspace[]>
  /** Paths waiting to be opened (command line, links, drops); each is handed to one window only */
  takeOpenRequests(): Promise<OpenRequest[]>
  /** Repositories in these folders and up to two levels below them (`~` = home); hidden folders and node_modules are skipped */
  discoverRepos(dirs: string[]): Promise<DiscoveredRepo[]>
  /** Called when there are open requests to take. Returns an unsubscribe fn. */
  onOpenRequests(cb: () => void): () => void
  cliStatus(): Promise<CliStatus>
  /** Link the command line tool onto the PATH; fails with the command to run by hand when not permitted */
  installCli(): Promise<CliStatus>
  /** Subscribe to repo file-system changes (debounced). Returns an unsubscribe fn. */
  onRepoChanged(cb: (repo: string) => void): () => void
  onProgress(cb: (e: ProgressEvent) => void): () => void
  /** Menu / global commands dispatched from the main process (e.g. "view:toggleFuzzyFinder") */
  onCommand(cb: (command: string) => void): () => void
  /** Called with the window's native fullscreen state now and whenever it changes. Returns an unsubscribe fn. */
  onFullscreenChange(cb: (fullscreen: boolean) => void): () => void
  platform: string
}

export type AiProvider = 'anthropic' | 'openai' | 'gemini'
export type AiCredential = 'anthropicOauthToken' | 'anthropicApiKey' | 'openaiApiKey' | 'geminiApiKey'

export interface AiSettings {
  /** 'auto' uses the first provider with a credential: Anthropic, then OpenAI, then Gemini */
  provider: 'auto' | AiProvider
  /** Empty strings mean the default */
  anthropicModel: string
  openaiModel: string
  geminiModel: string
  anthropicBaseUrl: string
  openaiBaseUrl: string
  geminiBaseUrl: string
  timeoutSeconds: number
  /** Total attempts per request, including the first */
  attempts: number
}

export interface AiStatus {
  settings: AiSettings
  /** Where each credential comes from. Keys never leave the backend; `hint` is masked or an env var name. */
  secrets: Record<AiCredential, { source: 'app' | 'env' | null; hint: string | null }>
  /** The provider requests go to, or null when no credential is available */
  active: { provider: AiProvider; model: string; credential: AiCredential } | null
  defaultModels: Record<AiProvider, string>
}

/** AI providers with the user's own key (Rust backend), exposed as `window.ai`. */
export interface AiApi {
  status(): Promise<AiStatus>
  /** Merge settings; a credential set to a string is stored, set to null is removed */
  update(settings?: Partial<AiSettings>, secrets?: Partial<Record<AiCredential, string | null>>): Promise<AiStatus>
  /** Send one prompt to the active provider and return its reply text */
  complete(prompt: string, maxTokens?: number): Promise<string>
}

/** Built-in terminal (portable-pty in the Rust backend), exposed as `window.term`. */
export interface TerminalApi {
  /** Spawn the user's login shell in `cwd`. Returns the terminal id. */
  create(cwd: string, cols: number, rows: number): Promise<string>
  write(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  kill(id: string): Promise<void>
  onData(cb: (id: string, data: string) => void): () => void
  onExit(cb: (id: string, exitCode: number) => void): () => void
}

/** Event names the Rust backend emits (must match src-tauri/src/lib.rs and menu.rs). */
export const IPC = {
  repoChanged: 'evt:repoChanged',
  progress: 'evt:progress',
  command: 'evt:command',
  openRequests: 'evt:openRequests'
} as const
