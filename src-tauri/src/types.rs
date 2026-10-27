// Rust mirror of src/shared/types.ts. Field names serialize to the TypeScript (camelCase) shapes;
// optional TS fields (`foo?: T`) are skipped when None, `T | null` fields serialize as null.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Unix epoch milliseconds
    pub date: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: Signature,
    pub committer: Signature,
    pub summary: String,
    pub body: String,
    pub refs: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    pub full_name: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_head: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Committer date of the commit the ref points at (Unix epoch milliseconds)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// First line of the message of the commit the ref points at
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Remote branch its remote's HEAD points at (the remote's default branch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    #[serde(rename = "ref")]
    pub reference: String,
    pub sha: String,
    pub message: String,
    pub date: i64,
    pub base_sha: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Submodule {
    pub name: String,
    pub path: String,
    pub url: String,
    pub sha: String,
    pub state: &'static str,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub is_main: bool,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    pub detached: bool,
    pub prunable: bool,
    /// Uncommitted changes of a linked worktree; absent for the worktree that was queried and unreadable ones
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<WorktreeChanges>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct WorktreeChanges {
    pub modified: u32,
    pub added: u32,
    pub deleted: u32,
    pub conflicted: u32,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
}

impl FileChange {
    pub fn new(path: impl Into<String>, status: &'static str) -> Self {
        FileChange { path: path.into(), status, ..Default::default() }
    }
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub head_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
    pub operation: Option<&'static str>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    pub header_lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_new: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_deleted: Option<bool>,
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct CommitStats {
    pub additions: u64,
    pub deletions: u64,
    pub files: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CommitDetail {
    pub commit: Commit,
    pub files: Vec<FileChange>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitComparison {
    pub merge_base: Option<String>,
    pub files: Vec<FileChange>,
    pub ahead: Vec<Commit>,
    pub behind: Vec<Commit>,
    pub ahead_count: u32,
    pub behind_count: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub sha: String,
    pub author: String,
    pub date: i64,
    pub summary: String,
    pub line: u32,
    pub content: String,
    /// Line number in the commit's version of the file
    pub orig_line: u32,
    /// The file's path in that commit (differs after renames, or with -C for copied lines)
    pub path: String,
    /// The commit's parent and the file's path there; absent where the line's commit created the file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<BlamePrevious>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct BlamePrevious {
    pub sha: String,
    pub path: String,
}

/// A commit of `git log --follow` with the file's path in it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryCommit {
    #[serde(flatten)]
    pub commit: Commit,
    pub path: String,
    /// Path before the commit when it renamed or copied the file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

/// Contents of a file at a revision, for image diffs.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ImageBlob {
    pub base64: String,
    /// Bytes
    pub size: u64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DiffTarget {
    Working { path: String, staged: bool },
    /// `old_path` is where a renamed file came from, so the diff shows the rename
    Commit {
        sha: String,
        path: String,
        #[serde(rename = "oldPath", default)]
        old_path: Option<String>,
    },
    Compare { from: String, to: String, path: String },
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    /// Lines of context around changes (git's default is 3)
    pub context: Option<u32>,
    pub ignore_whitespace: Option<bool>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct RebaseTodoItem {
    pub action: String,
    pub sha: String,
    pub message: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct LogOptions {
    pub limit: Option<u32>,
    pub skip: Option<u32>,
    pub all: Option<bool>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ConflictFile {
    pub path: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub merged: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub git_dir: String,
    pub is_bare: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitflowConfig {
    pub master: String,
    pub develop: String,
    pub feature: String,
    pub release: String,
    pub hotfix: String,
    pub version_tag: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProgressEvent {
    pub repo: String,
    pub op: String,
    pub message: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    pub amend: Option<bool>,
    pub no_verify: Option<bool>,
    /// Add a Signed-off-by trailer (`--signoff`)
    pub signoff: Option<bool>,
    /// Some(true) signs (`-S`), Some(false) never signs, None follows `commit.gpgsign`
    pub sign: Option<bool>,
}

/// Someone who authored recent commits, for Co-authored-by trailers.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Author {
    pub name: String,
    pub email: String,
    pub commits: u32,
}

/// A signed commit's signature: `status` is good, untrusted, expired, revoked, bad or unverified (git cannot check it).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CommitSignature {
    pub status: &'static str,
    /// openpgp, ssh or x509
    pub format: &'static str,
    pub signer: Option<String>,
    pub key: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeOptions {
    pub ff_only: Option<bool>,
    pub no_ff: Option<bool>,
    pub squash: Option<bool>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PushOptions {
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub force: Option<bool>,
    pub set_upstream: Option<bool>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct ApplyOptions {
    pub cached: bool,
    pub reverse: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitflowFinishOptions {
    pub tag_message: Option<String>,
    pub delete_branch: Option<bool>,
}

// ------------------------------------------------------------ smart commit

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SmartStatus {
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub has_commits: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub staged: bool,
    pub unpushed: bool,
    pub gh: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingDiff {
    pub diff: String,
    pub untracked: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchComparison {
    pub target_exists: bool,
    pub commits: Vec<String>,
    pub stat: String,
    pub diff: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PrTemplate {
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PullRequestResult {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ReflogEntry {
    pub index: u32,
    pub selector: String,
    pub sha: String,
    pub action: String,
    pub message: String,
    pub date: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileBackup {
    pub path: String,
    /// Blob of the work-tree file, None when the file did not exist
    pub blob: Option<String>,
    pub executable: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscardImpact {
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub untracked: u32,
    pub binary: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchImpact {
    /// Commits of the branch missing from HEAD
    pub unmerged: u32,
    /// Commits reachable from no other branch, remote branch or tag
    pub orphaned: u32,
}

/// Filters of the graph search that need the history itself (`path:` and `content:`).
#[derive(Deserialize, Clone, Debug, Default)]
pub struct SearchLogOptions {
    #[serde(default)]
    pub paths: Vec<String>,
    pub content: Option<String>,
    /// Oldest commit date to walk to (Unix epoch milliseconds)
    pub since: Option<i64>,
    pub limit: Option<u32>,
}

/// What the workspace view shows for a repository.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub branch: Option<String>,
    pub detached: bool,
    pub head_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Files with uncommitted changes (staged, unstaged, untracked or conflicted)
    pub changes: u32,
    pub conflicted: u32,
    pub operation: Option<&'static str>,
}
