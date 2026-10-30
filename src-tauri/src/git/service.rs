// Git backend implemented on top of the system `git` CLI. Free of Tauri types so it can be unit tested.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::OwnedMutexGuard;

use super::exec::{git, LineSink, Opts, Output};
use super::parse::*;
use super::recovery::rev_arg;
use super::watcher::RepoWatcher;
use crate::types::*;

pub type Res<T> = Result<T, String>;

pub trait Hooks: Send + Sync {
    fn progress(&self, _e: ProgressEvent) {}
    fn repo_changed(&self, _repo: &str) {}
}

#[cfg(test)]
pub struct NoHooks;
#[cfg(test)]
impl Hooks for NoHooks {}

/// Least time between two progress events of the same phase (git rewrites its counters many times a second).
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Thins out git's `--progress` lines before they become UI events. Messages without a percentage, the first line
/// of each phase ("Receiving objects", "remote: Counting objects", ...) and its final ", done." line always pass;
/// counter updates within a phase pass at most every `PROGRESS_INTERVAL`.
#[derive(Default)]
pub(super) struct ProgressThrottle {
    last: Option<(std::time::Instant, String)>,
}

impl ProgressThrottle {
    pub(super) fn accept(&mut self, line: &str, now: std::time::Instant) -> bool {
        let Some(pct) = line.find('%') else { return true };
        let phase = line[..pct].rfind(':').map(|i| &line[..i]).unwrap_or("");
        let pass = line.contains(", done")
            || match &self.last {
                Some((at, last)) => last != phase || now.duration_since(*at) >= PROGRESS_INTERVAL,
                None => true,
            };
        if pass {
            self.last = Some((now, phase.to_string()));
        }
        pass
    }
}

macro_rules! args {
    ($($e:expr),* $(,)?) => { vec![$(String::from($e)),*] };
}

static HEX_SHORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{4,40}$").unwrap());
static HEX_STATS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{7,40}$").unwrap());
static HEX_TODO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{4,64}$").unwrap());
static AHEAD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ahead (\d+)").unwrap());
static BEHIND_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"behind (\d+)").unwrap());

/// Branch selector used by log(): everything except refs/stash.
const LOG_REFS: [&str; 4] = ["--branches", "--remotes", "--tags", "HEAD"];
/// Paths per git invocation when a command takes a file list, to stay under the OS argument limit.
const PATH_BATCH: usize = 500;

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

fn io_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn temp_dir(prefix: &str) -> Res<tempfile::TempDir> {
    tempfile::Builder::new().prefix(prefix).tempdir().map_err(io_err)
}

fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// The remote whose name is the longest prefix of `short` ("origin/feature/x" -> "origin").
fn match_remote(remotes: &[String], short: &str) -> Option<String> {
    remotes.iter().filter(|r| short.starts_with(&format!("{r}/"))).max_by_key(|r| r.len()).cloned()
}

fn to_value<T: Serialize>(v: T) -> Res<Value> {
    serde_json::to_value(v).map_err(io_err)
}

/// Positional IPC arguments. Missing trailing arguments read as null, so `Option<T>` parameters may be omitted.
pub struct Args(pub Vec<Value>);

impl Args {
    pub fn get<T: DeserializeOwned>(&self, i: usize) -> Res<T> {
        let v = self.0.get(i).cloned().unwrap_or(Value::Null);
        serde_json::from_value(v).map_err(|e| format!("Invalid argument {}: {e}", i + 1))
    }
}

pub struct GitService {
    hooks: Arc<dyn Hooks>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    watchers: Mutex<HashMap<String, RepoWatcher>>,
}

impl GitService {
    pub fn new(hooks: Arc<dyn Hooks>) -> Self {
        GitService { hooks, locks: Mutex::default(), watchers: Mutex::default() }
    }

    /// IPC entry point: `method(...args)` for every method of the TypeScript `GitApi`; anything else is rejected.
    pub async fn call(&self, method: &str, args: Vec<Value>) -> Res<Value> {
        let a = Args(args);
        // Boxing each arm keeps this future small; inline, it would hold every method's state at once
        // and overflow the worker stack in debug builds.
        macro_rules! ret {
            ($e:expr) => {
                to_value(Box::pin($e).await?)
            };
        }
        match method {
            "open" => ret!(self.open(&a.get::<String>(0)?)),
            "init" => ret!(self.init(&a.get::<String>(0)?, a.get::<Option<String>>(1)?)),
            "clone" => ret!(self.clone_repo(&a.get::<String>(0)?, &a.get::<String>(1)?)),
            _ => {
                let repo: String = match method {
                    "getConfig" | "setConfig" | "unsetConfig" | "testSigning" => a.get::<Option<String>>(0)?.unwrap_or_default(),
                    _ => a.get(0)?,
                };
                let r = repo.as_str();
                match method {
                    "log" => ret!(self.log(r, a.get::<Option<LogOptions>>(1)?.unwrap_or_default())),
                    "refs" => ret!(self.refs(r)),
                    "stashes" => ret!(self.stashes(r)),
                    "remotes" => ret!(self.remotes(r)),
                    "submodules" => ret!(self.submodules(r)),
                    "worktrees" => ret!(self.worktrees(r)),
                    "status" => ret!(self.status(r)),
                    "commitDetail" => ret!(self.commit_detail(r, &a.get::<String>(1)?)),
                    "compareCommits" => ret!(self.compare_commits(
                        r,
                        &a.get::<String>(1)?,
                        &a.get::<String>(2)?,
                        a.get::<Option<bool>>(3)?.unwrap_or(true)
                    )),
                    "diff" => ret!(self.diff(r, a.get(1)?, a.get::<Option<DiffOptions>>(2)?.unwrap_or_default())),
                    "fileContent" => ret!(self.file_content(r, a.get(1)?, &a.get::<String>(2)?)),
                    "blame" => ret!(self.blame(r, &a.get::<String>(1)?, a.get(2)?)),
                    "fileHistory" => ret!(self.file_history(r, &a.get::<String>(1)?, a.get(2)?)),
                    "imageBlob" => ret!(self.image_blob(r, a.get(1)?, &a.get::<String>(2)?)),
                    "searchCommits" => ret!(self.search_commits(r, &a.get::<String>(1)?, a.get(2)?)),
                    "searchLog" => ret!(self.search_log(r, a.get(1)?)),
                    "repoSummary" => ret!(self.repo_summary(r)),
                    "commitStats" => ret!(self.commit_stats(r, a.get(1)?)),
                    "conflict" => ret!(self.conflict(r, &a.get::<String>(1)?)),
                    "stage" => ret!(self.stage(r, a.get(1)?)),
                    "unstage" => ret!(self.unstage(r, a.get(1)?)),
                    "stageAll" => ret!(self.stage_all(r)),
                    "unstageAll" => ret!(self.unstage_all(r)),
                    "discard" => ret!(self.discard(r, a.get(1)?)),
                    "applyPatch" => ret!(self.apply_patch(r, &a.get::<String>(1)?, a.get(2)?)),
                    "resolveConflict" => ret!(self.resolve_conflict(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "takeSide" => ret!(self.take_side(r, a.get(1)?, &a.get::<String>(2)?)),
                    "ignore" => ret!(self.ignore(r, &a.get::<String>(1)?)),
                    "commit" => ret!(self.commit(r, &a.get::<String>(1)?, a.get::<Option<_>>(2)?.unwrap_or_default())),
                    "headMessage" => ret!(self.head_message(r)),
                    "commitTemplate" => ret!(self.commit_template(r)),
                    "recentAuthors" => ret!(self.recent_authors(r, a.get(1)?)),
                    "testSigning" => ret!(self.test_signing(Some(repo.clone()), a.get(1)?, a.get(2)?)),
                    "signatureStatus" => ret!(self.signature_status(r, &a.get::<String>(1)?)),
                    "headDiff" => ret!(self.head_diff(r)),
                    "createBranch" => ret!(self.create_branch(
                        r,
                        &a.get::<String>(1)?,
                        a.get(2)?,
                        a.get::<Option<bool>>(3)?.unwrap_or(false)
                    )),
                    "deleteBranch" => {
                        ret!(self.delete_branch(r, &a.get::<String>(1)?, a.get::<Option<bool>>(2)?.unwrap_or(false)))
                    }
                    "deleteRemoteBranch" => {
                        ret!(self.delete_remote_branch(r, &a.get::<String>(1)?, &a.get::<String>(2)?))
                    }
                    "renameBranch" => ret!(self.rename_branch(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "checkout" => ret!(self.checkout(r, &a.get::<String>(1)?)),
                    "checkoutRemote" => ret!(self.checkout_remote(r, &a.get::<String>(1)?, a.get(2)?)),
                    "setUpstream" => ret!(self.set_upstream(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "createTag" => ret!(self.create_tag(r, &a.get::<String>(1)?, &a.get::<String>(2)?, a.get(3)?)),
                    "deleteTag" => ret!(self.delete_tag(r, &a.get::<String>(1)?)),
                    "pushTag" => ret!(self.push_tag(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "deleteRemoteTag" => ret!(self.delete_remote_tag(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "merge" => ret!(self.merge(r, &a.get::<String>(1)?, a.get::<Option<_>>(2)?.unwrap_or_default())),
                    "rebase" => ret!(self.rebase(r, &a.get::<String>(1)?)),
                    "interactiveRebase" => ret!(self.interactive_rebase(r, &a.get::<String>(1)?, a.get(2)?)),
                    "cherryPick" => ret!(self.cherry_pick(r, a.get(1)?)),
                    "revert" => ret!(self.revert(r, &a.get::<String>(1)?)),
                    "reset" => ret!(self.reset(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "continueOperation" => ret!(self.continue_operation(r)),
                    "abortOperation" => ret!(self.abort_operation(r)),
                    "skipOperation" => ret!(self.skip_operation(r)),
                    "stashSave" => {
                        ret!(self.stash_save(r, a.get(1)?, a.get::<Option<bool>>(2)?.unwrap_or(true)))
                    }
                    "stashApply" => ret!(self.stash_apply(r, a.get(1)?, false)),
                    "stashPop" => ret!(self.stash_apply(r, a.get(1)?, true)),
                    "stashDrop" => ret!(self.stash_drop(r, a.get(1)?)),
                    "fetch" => ret!(self.fetch(r, a.get(1)?, a.get::<Option<bool>>(2)?.unwrap_or(false))),
                    "pull" => ret!(self.pull(r, a.get::<Option<String>>(1)?.as_deref().unwrap_or("ff"))),
                    "push" => ret!(self.push(r, a.get::<Option<_>>(1)?.unwrap_or_default())),
                    "addRemote" => ret!(self.add_remote(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "removeRemote" => ret!(self.remove_remote(r, &a.get::<String>(1)?)),
                    "editRemote" => ret!(self.edit_remote(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "submoduleUpdate" => ret!(self.submodule_update(r, a.get(1)?)),
                    "submoduleAdd" => ret!(self.submodule_add(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "worktreeAdd" => {
                        ret!(self.worktree_add(
                            r,
                            &a.get::<String>(1)?,
                            &a.get::<String>(2)?,
                            a.get(3)?,
                            a.get::<Option<bool>>(4)?.unwrap_or(false)
                        ))
                    }
                    "worktreeRemove" => ret!(self.worktree_remove(
                        r,
                        &a.get::<String>(1)?,
                        a.get::<Option<bool>>(2)?.unwrap_or(false)
                    )),
                    "worktreeLock" => ret!(self.worktree_lock(r, &a.get::<String>(1)?, a.get(2)?, a.get(3)?)),
                    "worktreePrune" => ret!(self.worktree_prune(r)),
                    "getConfig" => ret!(self.get_config(Some(r).filter(|s| !s.is_empty()), &a.get::<String>(1)?)),
                    "setConfig" => ret!(self.set_config(
                        Some(r).filter(|s| !s.is_empty()),
                        &a.get::<String>(1)?,
                        &a.get::<String>(2)?,
                        a.get::<Option<bool>>(3)?.unwrap_or(false)
                    )),
                    "unsetConfig" => ret!(self.unset_config(
                        Some(r).filter(|s| !s.is_empty()),
                        &a.get::<String>(1)?,
                        a.get::<Option<bool>>(2)?.unwrap_or(false)
                    )),
                    "gitflowInit" => ret!(self.gitflow_init(r, a.get(1)?)),
                    "gitflowConfig" => ret!(self.gitflow_config(r)),
                    "gitflowStart" => ret!(self.gitflow_start(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "gitflowFinish" => ret!(self.gitflow_finish(
                        r,
                        &a.get::<String>(1)?,
                        &a.get::<String>(2)?,
                        a.get::<Option<_>>(3)?.unwrap_or_default()
                    )),
                    "smartStatus" => ret!(self.smart_status(r)),
                    "pendingDiff" => ret!(self.pending_diff(r, a.get::<Option<bool>>(1)?.unwrap_or(true))),
                    "compareBranch" => ret!(self.compare_branch(
                        r,
                        &a.get::<String>(1)?,
                        &a.get::<String>(2)?,
                        &a.get::<String>(3)?
                    )),
                    "prTemplate" => ret!(self.pr_template(r)),
                    "commitPatches" => ret!(self.commit_patches(r, &a.get::<Vec<String>>(1)?)),
                    "createPullRequest" => ret!(self.create_pull_request(
                        r,
                        &a.get::<String>(1)?,
                        &a.get::<String>(2)?,
                        &a.get::<String>(3)?,
                        &a.get::<String>(4)?,
                        &a.get::<String>(5)?
                    )),
                    "lfsInstalled" => ret!(self.lfs_installed(r)),
                    "lfsTrack" => ret!(self.lfs_track(r, &a.get::<String>(1)?)),
                    "lfsCommand" => ret!(self.lfs_command(r, &a.get::<String>(1)?)),
                    "reflog" => ret!(self.reflog(r, a.get(1)?)),
                    "resolveRef" => ret!(self.resolve_ref(r, &a.get::<String>(1)?)),
                    "countCommits" => ret!(self.count_commits(r, &a.get::<String>(1)?, a.get::<Option<_>>(2)?.unwrap_or_default())),
                    "branchImpact" => ret!(self.branch_impact(r, &a.get::<String>(1)?)),
                    "discardImpact" => ret!(self.discard_impact(r, a.get(1)?)),
                    "snapshot" => ret!(self.snapshot(r)),
                    "applySnapshot" => ret!(self.apply_snapshot(r, &a.get::<String>(1)?)),
                    "stashStore" => ret!(self.stash_store(r, &a.get::<String>(1)?, &a.get::<String>(2)?)),
                    "undoStashPop" => {
                        ret!(self.undo_stash_pop(r, &a.get::<String>(1)?, &a.get::<String>(2)?, a.get(3)?))
                    }
                    "restoreBranch" => ret!(self.restore_branch(r, a.get(1)?, &a.get::<String>(2)?)),
                    "backupFiles" => ret!(self.backup_files(r, a.get(1)?)),
                    "restoreFiles" => ret!(self.restore_files(r, a.get(1)?)),
                    "pushSha" => ret!(self.push_sha(
                        r,
                        &a.get::<String>(1)?,
                        &a.get::<String>(2)?,
                        &a.get::<String>(3)?,
                        a.get(4)?
                    )),
                    "watch" => to_value(self.watch(r)),
                    "unwatch" => to_value(self.unwatch(r)),
                    _ => Err(format!("Unknown method: {method}")),
                }
            }
        }
    }

    // ---------------------------------------------------------------- helpers

    pub(super) async fn read(&self, repo: &str, args: Vec<String>, ok: &[i32]) -> Res<Output> {
        git(Path::new(repo), &args, Opts::read().ok(ok)).await
    }

    pub(super) async fn out(&self, repo: &str, args: Vec<String>) -> Res<String> {
        Ok(git(Path::new(repo), &args, Opts::read()).await?.stdout)
    }

    pub(super) async fn write(&self, repo: &str, args: Vec<String>) -> Res<Output> {
        git(Path::new(repo), &args, Opts::default()).await
    }

    /// Run `args -- <paths>` once per batch of paths.
    async fn write_paths(&self, repo: &str, args: Vec<String>, paths: &[String]) -> Res<()> {
        for batch in paths.chunks(PATH_BATCH) {
            self.write(repo, [args.clone(), batch.to_vec()].concat()).await?;
        }
        Ok(())
    }

    pub(super) async fn write_opts(&self, repo: &str, args: Vec<String>, opts: Opts) -> Res<Output> {
        git(Path::new(repo), &args, opts).await
    }

    /// Serialise mutating operations per repository to avoid index.lock races.
    pub(super) async fn lock(&self, repo: &str) -> OwnedMutexGuard<()> {
        let m = self.locks.lock().unwrap().entry(repo.to_string()).or_default().clone();
        m.lock_owned().await
    }

    pub(super) fn progress(&self, repo: &str, op: &str) -> LineSink {
        let hooks = self.hooks.clone();
        let (repo, op) = (repo.to_string(), op.to_string());
        let throttle = Mutex::new(ProgressThrottle::default());
        Arc::new(move |message: &str| {
            if throttle.lock().unwrap().accept(message, std::time::Instant::now()) {
                hooks.progress(ProgressEvent { repo: repo.clone(), op: op.clone(), message: message.to_string() })
            }
        })
    }

    async fn git_dir(&self, repo: &str) -> Res<String> {
        Ok(self.out(repo, args!["rev-parse", "--absolute-git-dir"]).await?.trim().to_string())
    }

    pub(super) async fn verify(&self, repo: &str, rev: &str) -> Res<bool> {
        Ok(self.read(repo, args!["rev-parse", "--verify", "-q", rev], &[0, 1]).await?.code == 0)
    }

    pub(super) async fn has_head(&self, repo: &str) -> Res<bool> {
        self.verify(repo, "HEAD").await
    }

    pub(super) async fn current_branch(&self, repo: &str) -> Res<Option<String>> {
        let r = self.read(repo, args!["symbolic-ref", "--short", "-q", "HEAD"], &[0, 1]).await?;
        Ok((r.code == 0).then(|| r.stdout.trim().to_string()))
    }

    pub(super) async fn operation(&self, repo: &str) -> Res<Option<&'static str>> {
        let dir = PathBuf::from(self.git_dir(repo).await?);
        let has = |f: &str| dir.join(f).exists();
        Ok(if has("rebase-merge") || has("rebase-apply") {
            Some("rebase")
        } else if has("MERGE_HEAD") {
            Some("merge")
        } else if has("CHERRY_PICK_HEAD") {
            Some("cherry-pick")
        } else if has("REVERT_HEAD") {
            Some("revert")
        } else if has("BISECT_LOG") {
            Some("bisect")
        } else {
            None
        })
    }

    async fn remote_names(&self, repo: &str) -> Res<Vec<String>> {
        Ok(self.out(repo, args!["remote"]).await?.lines().filter(|l| !l.is_empty()).map(String::from).collect())
    }

    pub(super) async fn default_remote(&self, repo: &str) -> Res<String> {
        let remotes = self.remote_names(repo).await?;
        if remotes.is_empty() {
            return Err("This repository has no remotes".into());
        }
        Ok(if remotes.iter().any(|r| r == "origin") { "origin".into() } else { remotes[0].clone() })
    }

    pub(super) async fn untracked(&self, repo: &str, paths: &[String]) -> Res<HashSet<String>> {
        let mut out = HashSet::new();
        for batch in paths.chunks(PATH_BATCH) {
            let a = [args!["ls-files", "--others", "--exclude-standard", "-z", "--"], batch.to_vec()].concat();
            out.extend(self.out(repo, a).await?.split('\0').filter(|s| !s.is_empty()).map(String::from));
        }
        Ok(out)
    }

    async fn parents(&self, repo: &str, sha: &str) -> Res<Vec<String>> {
        let out = self.out(repo, args!["rev-list", "--parents", "-n1", sha]).await?;
        Ok(out.trim().split(' ').skip(1).map(String::from).collect())
    }

    // -------------------------------------------------------------- lifecycle

    pub async fn open(&self, path: &str) -> Res<RepoInfo> {
        let mut abs = std::path::absolute(path).map_err(io_err)?;
        // a file (dropped on the window, passed on the command line) opens the repository that contains it
        if abs.is_file() {
            abs.pop();
        }
        let abs = abs.to_string_lossy().into_owned();
        if !Path::new(&abs).is_dir() {
            return Err(format!("Folder does not exist: {abs}"));
        }
        let bare = match self.out(&abs, args!["rev-parse", "--is-bare-repository"]).await {
            Ok(s) => s.trim().to_string(),
            Err(_) => return Err(format!("Not a git repository: {abs}")),
        };
        let git_dir = self.git_dir(&abs).await?;
        let is_bare = bare == "true";
        let top = if is_bare {
            git_dir.clone()
        } else {
            self.out(&abs, args!["rev-parse", "--show-toplevel"]).await?.trim().to_string()
        };
        Ok(RepoInfo { name: basename(&top), path: top, git_dir, is_bare })
    }

    pub async fn init(&self, path: &str, default_branch: Option<String>) -> Res<RepoInfo> {
        tokio::fs::create_dir_all(path).await.map_err(io_err)?;
        self.write(path, args!["init", "-b", default_branch.unwrap_or_else(|| "main".into())]).await?;
        self.open(path).await
    }

    pub async fn clone_repo(&self, url: &str, dest: &str) -> Res<RepoInfo> {
        let dest = std::path::absolute(dest).map_err(io_err)?;
        let parent = dest.parent().unwrap_or(Path::new("/")).to_string_lossy().into_owned();
        let dest = dest.to_string_lossy().into_owned();
        tokio::fs::create_dir_all(&parent).await.map_err(io_err)?;
        let opts = Opts::default().progress(self.progress(&dest, "clone"));
        self.write_opts(&parent, args!["clone", "--progress", "--recurse-submodules", url, dest.as_str()], opts)
            .await?;
        self.open(&dest).await
    }

    // ---------------------------------------------------------------- reading

    pub async fn log(&self, repo: &str, opts: LogOptions) -> Res<Vec<Commit>> {
        if !self.has_head(repo).await? && self.out(repo, args!["for-each-ref", "--count=1"]).await?.trim().is_empty() {
            return Ok(vec![]);
        }
        let mut a = args![
            "log",
            "--date-order",
            "--decorate=full",
            format!("--format={LOG_FORMAT}"),
            format!("-n{}", opts.limit.unwrap_or(2000))
        ];
        if let Some(skip) = opts.skip.filter(|s| *s > 0) {
            a.push(format!("--skip={skip}"));
        }
        if opts.all == Some(false) {
            a.push("HEAD".into());
        } else {
            a.extend(LOG_REFS.map(String::from));
        }
        let r = self.read(repo, a, &[0, 128]).await?;
        Ok(if r.code == 0 { parse_log(&r.stdout) } else { vec![] })
    }

    pub async fn refs(&self, repo: &str) -> Res<Vec<Ref>> {
        let fmt = [
            "%(refname)",
            "%(objectname)",
            "%(*objectname)",
            "%(upstream)",
            "%(upstream:track)",
            "%(HEAD)",
            "%(objecttype)",
            "%(contents:subject)",
            "%(authorname)",
            "%(committerdate:unix)",
            "%(*authorname)",
            "%(*committerdate:unix)",
            "%(*contents:subject)",
            "%(symref)",
        ]
        .join(US);
        let (out, remotes) = tokio::try_join!(
            self.out(repo, args!["for-each-ref", format!("--format={fmt}{RS}"), "refs/heads", "refs/remotes", "refs/tags"]),
            self.remote_names(repo)
        )?;
        let mut refs = Vec::new();
        // remote HEADs (refs/remotes/origin/HEAD) point at each remote's default branch
        let mut remote_heads = HashSet::new();
        for rec in out.split(RS) {
            let line = rec.strip_prefix('\n').unwrap_or(rec);
            if line.trim().is_empty() {
                continue;
            }
            let f: Vec<&str> = line.split(US).collect();
            let get = |i: usize| f.get(i).copied().unwrap_or("");
            let (full_name, sha, peeled, upstream, track, head, obj_type, subject) =
                (get(0), get(1), get(2), get(3), get(4), get(5), get(6), get(7));
            // annotated tags carry the commit's fields on the peeled (*) side
            let tagged = obj_type == "tag";
            let pick = |own: usize, peeled: usize| if tagged { get(peeled) } else { get(own) };
            let author = Some(pick(8, 10)).filter(|s| !s.is_empty()).map(String::from);
            let date = pick(9, 11).parse::<i64>().ok().map(|s| s * 1000);
            let summary = Some(if tagged { get(12) } else { subject }).filter(|s| !s.is_empty()).map(String::from);
            let tip = Ref { author, date, summary, ..Default::default() };
            if let Some(name) = full_name.strip_prefix("refs/heads/") {
                let mut r = Ref {
                    full_name: full_name.into(),
                    name: name.into(),
                    kind: "local",
                    sha: sha.into(),
                    is_head: Some(head == "*"),
                    ..tip
                };
                if !upstream.is_empty() {
                    r.upstream = Some(upstream.into());
                    r.ahead = Some(AHEAD_RE.captures(track).map_or(0, |m| m[1].parse().unwrap_or(0)));
                    r.behind = Some(BEHIND_RE.captures(track).map_or(0, |m| m[1].parse().unwrap_or(0)));
                }
                refs.push(r);
            } else if let Some(short) = full_name.strip_prefix("refs/remotes/") {
                if short.ends_with("/HEAD") {
                    if !get(13).is_empty() {
                        remote_heads.insert(get(13).to_string());
                    }
                    continue;
                }
                let remote =
                    match_remote(&remotes, short).unwrap_or_else(|| short.split('/').next().unwrap_or("").into());
                refs.push(Ref {
                    full_name: full_name.into(),
                    name: short.into(),
                    kind: "remote",
                    sha: sha.into(),
                    remote: Some(remote),
                    ..tip
                });
            } else if let Some(name) = full_name.strip_prefix("refs/tags/") {
                refs.push(Ref {
                    full_name: full_name.into(),
                    name: name.into(),
                    kind: "tag",
                    sha: if peeled.is_empty() { sha.into() } else { peeled.into() },
                    message: tagged.then(|| subject.into()),
                    ..tip
                });
            }
        }
        for r in refs.iter_mut().filter(|r| remote_heads.contains(&r.full_name)) {
            r.is_default = Some(true);
        }
        if !refs.iter().any(|r| r.is_head == Some(true)) {
            let head = self.read(repo, args!["rev-parse", "--verify", "-q", "HEAD"], &[0, 1]).await?;
            if head.code == 0 {
                refs.push(Ref {
                    full_name: "HEAD".into(),
                    name: "HEAD".into(),
                    kind: "head",
                    sha: head.stdout.trim().into(),
                    is_head: Some(true),
                    ..Default::default()
                });
            }
        }
        Ok(refs)
    }

    pub async fn stashes(&self, repo: &str) -> Res<Vec<Stash>> {
        Ok(parse_stashes(&self.out(repo, args!["stash", "list", format!("--format={STASH_FORMAT}")]).await?))
    }

    pub async fn remotes(&self, repo: &str) -> Res<Vec<Remote>> {
        Ok(parse_remotes(&self.out(repo, args!["remote", "-v"]).await?))
    }

    pub async fn submodules(&self, repo: &str) -> Res<Vec<Submodule>> {
        if !Path::new(repo).join(".gitmodules").exists() {
            return Ok(vec![]);
        }
        let cfg = self.read(repo, args!["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\."], &[0, 1]).await?;
        let status = self.out(repo, args!["submodule", "status"]).await?;
        Ok(parse_submodules(&status, &parse_gitmodules(&cfg.stdout)))
    }

    pub async fn worktrees(&self, repo: &str) -> Res<Vec<Worktree>> {
        let mut wts = parse_worktrees(&self.out(repo, args!["worktree", "list", "--porcelain"]).await?);
        // Change counts for the other worktrees (the graph shows a WIP row for each one with changes).
        let current = std::fs::canonicalize(repo).ok();
        let mut jobs = tokio::task::JoinSet::new();
        for (i, wt) in wts.iter().enumerate() {
            let path = PathBuf::from(&wt.path);
            if wt.prunable || std::fs::canonicalize(&path).ok() == current || !path.is_dir() {
                continue;
            }
            jobs.spawn(async move {
                // --no-optional-locks: don't take the other worktree's index lock just to refresh stat info
                let a = args!["--no-optional-locks", "-c", "core.quotepath=false", "status", "--porcelain=v2", "-z", "-uall"];
                (i, git(&path, &a, Opts::read()).await.ok().map(|o| worktree_changes(&parse_status(&o.stdout))))
            });
        }
        while let Some(Ok((i, changes))) = jobs.join_next().await {
            wts[i].changes = changes;
        }
        Ok(wts)
    }

    pub async fn status(&self, repo: &str) -> Res<WorkingStatus> {
        let out = self
            .out(repo, args!["-c", "core.quotepath=false", "status", "--porcelain=v2", "--branch", "-z", "-uall"])
            .await?;
        let mut st = parse_status(&out);
        st.operation = self.operation(repo).await?;
        if st.head_sha.is_some() {
            // line counts for the staging panel
            let (unstaged, staged) = tokio::try_join!(
                self.out(repo, args!["diff", "--numstat", "-z", "--no-renames"]),
                self.out(repo, args!["diff", "--cached", "--numstat", "-z", "-M"])
            )?;
            let (u, s) = (parse_numstat_z(&unstaged), parse_numstat_z(&staged));
            apply_numstat(&mut st.unstaged, &u);
            apply_numstat(&mut st.staged, &s);
        }
        Ok(st)
    }

    pub async fn commit_detail(&self, repo: &str, sha: &str) -> Res<CommitDetail> {
        let out = self.out(repo, args!["log", "-1", "--decorate=full", format!("--format={LOG_FORMAT}"), sha]).await?;
        let commit = parse_log(&out).into_iter().next().ok_or_else(|| format!("Commit not found: {sha}"))?;
        let base = match commit.parents.first() {
            Some(p) => args![p.as_str(), sha],
            None => args!["--root", sha],
        };
        let tree = |kind: &str| {
            let mut a = args!["diff-tree", "-r", "-z", "-M", "--no-commit-id", kind];
            a.extend(base.iter().cloned());
            a
        };
        let (ns, num) = tokio::try_join!(self.out(repo, tree("--name-status")), self.out(repo, tree("--numstat")))?;
        let mut files = parse_name_status_z(&ns);
        apply_numstat(&mut files, &parse_numstat_z(&num));
        Ok(CommitDetail { commit, files })
    }

    /// Files and commits between two revisions. `three_dot` diffs `to` against the merge base (`from...to`),
    /// otherwise against `from` itself (`from..to`); without a merge base both are the direct diff.
    pub async fn compare_commits(&self, repo: &str, from: &str, to: &str, three_dot: bool) -> Res<CommitComparison> {
        const LIMIT: u32 = 500;
        let (from, to) = (rev_arg(from)?, rev_arg(to)?);
        let mb = self.read(repo, args!["merge-base", from.as_str(), to.as_str()], &[0, 1]).await?;
        let merge_base = Some(mb.stdout.trim().to_string()).filter(|s| mb.code == 0 && !s.is_empty());
        let base = if three_dot { merge_base.clone().unwrap_or_else(|| from.clone()) } else { from.clone() };
        let tree = |kind: &str| args!["diff-tree", "-r", "-z", "-M", "--no-commit-id", kind, base.as_str(), to.as_str()];
        let log = |range: String| {
            args!["log", "--date-order", "--decorate=full", format!("--format={LOG_FORMAT}"), format!("-n{LIMIT}"), range, "--"]
        };
        let (ns, num, ahead, behind, counts) = tokio::try_join!(
            self.out(repo, tree("--name-status")),
            self.out(repo, tree("--numstat")),
            self.out(repo, log(format!("{from}..{to}"))),
            self.out(repo, log(format!("{to}..{from}"))),
            self.out(repo, args!["rev-list", "--count", "--left-right", format!("{from}...{to}"), "--"])
        )?;
        let mut files = parse_name_status_z(&ns);
        apply_numstat(&mut files, &parse_numstat_z(&num));
        let mut counts = counts.split_whitespace().map(|n| n.parse().unwrap_or(0));
        let (behind_count, ahead_count) = (counts.next().unwrap_or(0), counts.next().unwrap_or(0));
        Ok(CommitComparison { merge_base, files, ahead: parse_log(&ahead), behind: parse_log(&behind), ahead_count, behind_count })
    }

    pub async fn diff(&self, repo: &str, target: DiffTarget, opts: DiffOptions) -> Res<Option<FileDiff>> {
        let mut extra: Vec<String> = Vec::new();
        if let Some(n) = opts.context {
            extra.push(format!("-U{n}"));
        }
        if opts.ignore_whitespace == Some(true) {
            extra.push("-w".into());
        }
        let common = [args!["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--patch"], extra.clone()].concat();
        let with = |extra: Vec<String>| [common.clone(), extra].concat();
        let (out, path) = match target {
            DiffTarget::Working { path, staged } => {
                let out = if !staged && !self.untracked(repo, std::slice::from_ref(&path)).await?.is_empty() {
                    self.read(repo, with(args!["--no-index", "--", "/dev/null", path.as_str()]), &[0, 1]).await?.stdout
                } else if staged {
                    self.out(repo, with(args!["--cached", "--", path.as_str()])).await?
                } else {
                    self.out(repo, with(args!["--", path.as_str()])).await?
                };
                (out, path)
            }
            DiffTarget::Commit { sha, path, old_path } => {
                let parents = self.parents(repo, &sha).await?;
                // both paths of a rename, so git pairs them up instead of showing an added file
                let mut paths = args!["--", path.as_str()];
                paths.extend(old_path.filter(|o| *o != path));
                let out = match parents.first() {
                    Some(p) => self.out(repo, with([args!["-M", p.as_str(), sha.as_str()], paths].concat())).await?,
                    None => {
                        let mut a = args!["show", "--no-color", "--no-ext-diff", "--format="];
                        a.extend(extra);
                        a.push(sha.clone());
                        a.extend(paths);
                        self.out(repo, a).await?
                    }
                };
                (out, path)
            }
            DiffTarget::Compare { from, to, path } => {
                (self.out(repo, with(args![from.as_str(), to.as_str(), "--", path.as_str()])).await?, path)
            }
        };
        if out.starts_with("diff --cc") || out.starts_with("diff --combined") {
            return Ok(None);
        }
        let files = parse_diff(&out);
        let pick = files.iter().position(|f| f.path == path).unwrap_or(0);
        Ok(files.into_iter().nth(pick).map(|mut f| {
            f.path = path;
            f
        }))
    }

    pub async fn file_content(&self, repo: &str, rev: Option<String>, path: &str) -> Res<String> {
        match rev {
            None => {
                let bytes = tokio::fs::read(Path::new(repo).join(path)).await.map_err(|e| format!("{path}: {e}"))?;
                Ok(String::from_utf8_lossy(&bytes).into_owned())
            }
            Some(rev) => self.out(repo, args!["show", format!("{rev}:{path}")]).await,
        }
    }

    pub async fn search_commits(&self, repo: &str, query: &str, limit: Option<u32>) -> Res<Vec<Commit>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let limit = limit.unwrap_or(200);
        let base = [
            args!["log", "--date-order", "--decorate=full", format!("--format={LOG_FORMAT}"), format!("-n{limit}")],
            LOG_REFS.map(String::from).to_vec(),
        ]
        .concat();
        let by_sha = async {
            if !HEX_SHORT.is_match(q) {
                return Ok(String::new());
            }
            let a = args!["log", "-1", "--decorate=full", format!("--format={LOG_FORMAT}"), format!("{q}^{{commit}}")];
            let r = self.read(repo, a, &[0, 128]).await?;
            Ok::<_, String>(if r.code == 0 { r.stdout } else { String::new() })
        };
        let (grep, author, sha) = tokio::try_join!(
            self.out(repo, [base.clone(), args!["-i", "--fixed-strings", format!("--grep={q}")]].concat()),
            self.out(repo, [base.clone(), args!["-i", "--fixed-strings", format!("--author={q}")]].concat()),
            by_sha
        )?;
        let mut seen = HashSet::new();
        let mut res: Vec<Commit> = [grep, author, sha]
            .iter()
            .flat_map(|o| parse_log(o))
            .filter(|c| seen.insert(c.sha.clone()))
            .collect();
        res.sort_by(|a, b| b.committer.date.cmp(&a.committer.date));
        res.truncate(limit as usize);
        Ok(res)
    }

    pub async fn commit_stats(&self, repo: &str, shas: Vec<String>) -> Res<HashMap<String, CommitStats>> {
        let mut seen = HashSet::new();
        let valid: Vec<String> = shas.into_iter().filter(|s| HEX_STATS.is_match(s) && seen.insert(s.clone())).collect();
        let mut res = HashMap::new();
        // Batches keep the argument list short; merges are diffed against their first parent.
        for batch in valid.chunks(100) {
            let mut a = args!["log", "--no-walk=unsorted", "-m", "--first-parent", "--numstat", format!("--format={RS}%H")];
            a.extend(batch.iter().cloned());
            res.extend(parse_commit_stats(&self.out(repo, a).await?));
        }
        Ok(res)
    }

    async fn show_stage(&self, repo: &str, n: u8, path: &str) -> Res<Option<String>> {
        let r = self.read(repo, args!["show", format!(":{n}:{path}")], &[0, 128]).await?;
        Ok((r.code == 0).then_some(r.stdout))
    }

    pub async fn conflict(&self, repo: &str, path: &str) -> Res<ConflictFile> {
        let (base, ours, theirs) = tokio::try_join!(
            self.show_stage(repo, 1, path),
            self.show_stage(repo, 2, path),
            self.show_stage(repo, 3, path)
        )?;
        let merged = tokio::fs::read(Path::new(repo).join(path))
            .await
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        Ok(ConflictFile { path: path.into(), base, ours, theirs, merged })
    }

    // ---------------------------------------------------------------- staging

    pub async fn stage(&self, repo: &str, paths: Vec<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write_paths(repo, args!["add", "-A", "--"], &paths).await
    }

    pub async fn unstage(&self, repo: &str, paths: Vec<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        if self.has_head(repo).await? {
            self.write_paths(repo, args!["reset", "-q", "HEAD", "--"], &paths).await
        } else {
            self.write_paths(repo, args!["rm", "--cached", "-r", "-q", "--"], &paths).await
        }
    }

    pub async fn stage_all(&self, repo: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["add", "-A"]).await?;
        Ok(())
    }

    pub async fn unstage_all(&self, repo: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        if self.has_head(repo).await? {
            self.write(repo, args!["reset", "-q"]).await?;
        } else {
            self.write(repo, args!["rm", "--cached", "-r", "-q", "."]).await?;
        }
        Ok(())
    }

    pub async fn discard(&self, repo: &str, paths: Vec<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        let untracked = self.untracked(repo, &paths).await?;
        for p in &untracked {
            let full = Path::new(repo).join(p);
            let is_dir = tokio::fs::symlink_metadata(&full).await.map(|m| m.is_dir()).unwrap_or(false);
            let _ = if is_dir { tokio::fs::remove_dir_all(&full).await } else { tokio::fs::remove_file(&full).await };
        }
        let tracked: Vec<String> = paths.into_iter().filter(|p| !untracked.contains(p)).collect();
        self.write_paths(repo, args!["checkout", "-q", "--"], &tracked).await
    }

    pub async fn apply_patch(&self, repo: &str, patch: &str, opts: ApplyOptions) -> Res<()> {
        let _g = self.lock(repo).await;
        let dir = temp_dir("karen-")?;
        let file = dir.path().join("data");
        let content = if patch.ends_with('\n') { patch.to_string() } else { format!("{patch}\n") };
        tokio::fs::write(&file, content).await.map_err(io_err)?;
        let mut a = args!["apply", "--recount", "--whitespace=nowarn"];
        if opts.cached {
            a.push("--cached".into());
        }
        if opts.reverse {
            a.push("--reverse".into());
        }
        a.push(file.to_string_lossy().into_owned());
        self.write(repo, a).await?;
        Ok(())
    }

    pub async fn resolve_conflict(&self, repo: &str, path: &str, content: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        tokio::fs::write(Path::new(repo).join(path), content).await.map_err(io_err)?;
        self.write(repo, args!["add", "--", path]).await?;
        Ok(())
    }

    pub async fn take_side(&self, repo: &str, paths: Vec<String>, side: &str) -> Res<()> {
        if side != "ours" && side != "theirs" {
            return Err(format!("Invalid side: {side}"));
        }
        let _g = self.lock(repo).await;
        self.write(repo, [args!["checkout", format!("--{side}"), "--"], paths.clone()].concat()).await?;
        self.write(repo, [args!["add", "--"], paths].concat()).await?;
        Ok(())
    }

    pub async fn ignore(&self, repo: &str, pattern: &str) -> Res<()> {
        let file = Path::new(repo).join(".gitignore");
        let existing = tokio::fs::read_to_string(&file).await.unwrap_or_default();
        if existing.lines().any(|l| l.strip_suffix('\r').unwrap_or(l) == pattern) {
            return Ok(());
        }
        let sep = if !existing.is_empty() && !existing.ends_with('\n') { "\n" } else { "" };
        tokio::fs::write(&file, format!("{existing}{sep}{pattern}\n")).await.map_err(io_err)
    }

    // ------------------------------------------------------------- committing

    pub async fn commit(&self, repo: &str, message: &str, opts: CommitOptions) -> Res<String> {
        let _g = self.lock(repo).await;
        let dir = temp_dir("karen-")?;
        let file = dir.path().join("data");
        tokio::fs::write(&file, message).await.map_err(io_err)?;
        let mut a = args!["commit", "-F", file.to_string_lossy(), "--cleanup=strip"];
        if opts.amend == Some(true) {
            a.push("--amend".into());
        }
        if opts.no_verify == Some(true) {
            a.push("--no-verify".into());
        }
        if opts.signoff == Some(true) {
            a.push("--signoff".into());
        }
        match opts.sign {
            Some(true) => a.push("--gpg-sign".into()),
            Some(false) => a.push("--no-gpg-sign".into()),
            None => {}
        }
        self.write(repo, a).await?;
        Ok(self.out(repo, args!["rev-parse", "HEAD"]).await?.trim().to_string())
    }

    pub async fn head_message(&self, repo: &str) -> Res<String> {
        if !self.has_head(repo).await? {
            return Ok(String::new());
        }
        Ok(self.out(repo, args!["log", "-1", "--format=%B"]).await?.trim_end().to_string())
    }

    // -------------------------------------------------------- branches & tags

    pub async fn create_branch(&self, repo: &str, name: &str, start: Option<String>, checkout: bool) -> Res<()> {
        let _g = self.lock(repo).await;
        let a = if checkout { args!["checkout", "-q", "-b", name] } else { args!["branch", name] };
        self.write(repo, [a, start.into_iter().collect()].concat()).await?;
        Ok(())
    }

    pub async fn delete_branch(&self, repo: &str, name: &str, force: bool) -> Res<()> {
        let _g = self.lock(repo).await;
        let name = name.strip_prefix("refs/heads/").unwrap_or(name);
        self.write(repo, args!["branch", if force { "-D" } else { "-d" }, name]).await?;
        Ok(())
    }

    pub async fn delete_remote_branch(&self, repo: &str, remote: &str, name: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let opts = Opts::default().progress(self.progress(repo, "push"));
        self.write_opts(repo, args!["push", "--progress", remote, "--delete", name], opts).await?;
        Ok(())
    }

    pub async fn rename_branch(&self, repo: &str, old: &str, new: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["branch", "-m", old, new]).await?;
        Ok(())
    }

    pub async fn checkout(&self, repo: &str, reference: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["checkout", "-q", reference.strip_prefix("refs/heads/").unwrap_or(reference)]).await?;
        Ok(())
    }

    pub async fn checkout_remote(&self, repo: &str, remote_ref: &str, local_name: Option<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        let short = remote_ref.strip_prefix("refs/remotes/").unwrap_or(remote_ref);
        let remote = match_remote(&self.remote_names(repo).await?, short);
        let local = local_name.unwrap_or_else(|| match &remote {
            Some(r) => short[r.len() + 1..].to_string(),
            None => short.to_string(),
        });
        if self.verify(repo, &format!("refs/heads/{local}")).await? {
            self.write(repo, args!["checkout", "-q", local]).await?;
        } else {
            self.write(repo, args!["checkout", "-q", "-b", local, "--track", format!("refs/remotes/{short}")]).await?;
        }
        Ok(())
    }

    pub async fn set_upstream(&self, repo: &str, branch: &str, upstream: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let up = upstream.strip_prefix("refs/remotes/").unwrap_or(upstream);
        self.write(repo, args!["branch", format!("--set-upstream-to={up}"), branch]).await?;
        Ok(())
    }

    pub async fn create_tag(&self, repo: &str, name: &str, sha: &str, message: Option<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        match message.filter(|m| !m.is_empty()) {
            Some(m) => self.write(repo, args!["tag", "-a", name, sha, "-m", m]).await?,
            None => self.write(repo, args!["tag", name, sha]).await?,
        };
        Ok(())
    }

    pub async fn delete_tag(&self, repo: &str, name: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["tag", "-d", name]).await?;
        Ok(())
    }

    pub async fn push_tag(&self, repo: &str, remote: &str, name: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let opts = Opts::default().progress(self.progress(repo, "push"));
        self.write_opts(repo, args!["push", "--progress", remote, format!("refs/tags/{name}")], opts).await?;
        Ok(())
    }

    pub async fn delete_remote_tag(&self, repo: &str, remote: &str, name: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let opts = Opts::default().progress(self.progress(repo, "push"));
        self.write_opts(repo, args!["push", "--progress", remote, "--delete", format!("refs/tags/{name}")], opts)
            .await?;
        Ok(())
    }

    // --------------------------------------------------- history manipulation

    pub async fn merge(&self, repo: &str, reference: &str, opts: MergeOptions) -> Res<()> {
        let _g = self.lock(repo).await;
        let mut a = args!["merge", "--no-edit"];
        if opts.ff_only == Some(true) {
            a.push("--ff-only".into());
        }
        if opts.no_ff == Some(true) {
            a.push("--no-ff".into());
        }
        if opts.squash == Some(true) {
            a.push("--squash".into());
        }
        a.push(reference.into());
        self.write(repo, a).await?;
        Ok(())
    }

    pub async fn rebase(&self, repo: &str, onto: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["rebase", onto]).await?;
        Ok(())
    }

    pub async fn interactive_rebase(&self, repo: &str, onto: &str, todo: Vec<RebaseTodoItem>) -> Res<()> {
        // The todo list is executed by git, so only known actions and plain object ids may reach it.
        for item in &todo {
            if !["pick", "reword", "squash", "fixup", "drop", "edit"].contains(&item.action.as_str()) {
                return Err(format!("Invalid rebase action: {}", item.action));
            }
            if !HEX_TODO.is_match(&item.sha) {
                return Err(format!("Invalid commit id: {}", item.sha));
            }
        }
        let _g = self.lock(repo).await;
        let dir = temp_dir("karen-rebase-")?;
        let mut lines = Vec::new();
        for (n, item) in todo.iter().enumerate() {
            match (item.action.as_str(), &item.message) {
                (action @ ("reword" | "squash"), Some(message)) => {
                    let f = dir.path().join(format!("msg-{n}"));
                    tokio::fs::write(&f, message).await.map_err(io_err)?;
                    let pick = if action == "reword" { "pick" } else { "fixup" };
                    lines.push(format!("{pick} {}", item.sha));
                    lines.push(format!(
                        "exec git commit --amend --no-verify --cleanup=strip -F {}",
                        sh_quote(&f.to_string_lossy())
                    ));
                }
                _ => lines.push(format!("{} {}", item.action, item.sha)),
            }
        }
        let todo_file = dir.path().join("todo");
        tokio::fs::write(&todo_file, lines.join("\n") + "\n").await.map_err(io_err)?;
        let opts = Opts::default()
            .env("GIT_SEQUENCE_EDITOR", format!("cp {}", sh_quote(&todo_file.to_string_lossy())))
            .env("GIT_EDITOR", "true");
        let res =
            self.write_opts(repo, args!["-c", "rebase.missingCommitsCheck=ignore", "rebase", "-i", "--no-autosquash", onto], opts)
                .await;
        let paused = self.operation(repo).await? == Some("rebase");
        if paused {
            // message files are still needed while a rebase is paused; only clean up once it is done
            let _ = dir.keep();
        }
        match res {
            Ok(_) => Ok(()),
            Err(e) if paused => Err(format!("Rebase stopped: resolve conflicts, then continue or abort.\n{e}")),
            Err(e) => Err(e),
        }
    }

    pub async fn cherry_pick(&self, repo: &str, shas: Vec<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, [args!["cherry-pick"], shas].concat()).await?;
        Ok(())
    }

    pub async fn revert(&self, repo: &str, sha: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let mut a = args!["revert", "--no-edit"];
        if self.parents(repo, sha).await?.len() > 1 {
            a.extend(args!["-m", "1"]);
        }
        a.push(sha.into());
        self.write(repo, a).await?;
        Ok(())
    }

    pub async fn reset(&self, repo: &str, sha: &str, mode: &str) -> Res<()> {
        if !["soft", "mixed", "hard", "keep"].contains(&mode) {
            return Err(format!("Invalid reset mode: {mode}"));
        }
        let _g = self.lock(repo).await;
        self.write(repo, args!["reset", "-q", format!("--{mode}"), sha]).await?;
        Ok(())
    }

    pub async fn continue_operation(&self, repo: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let a = match self.operation(repo).await? {
            Some("merge") => args!["commit", "--no-edit"],
            Some(op @ ("rebase" | "cherry-pick" | "revert")) => args![op, "--continue"],
            _ => return Err("No operation in progress".into()),
        };
        self.write_opts(repo, a, Opts::default().env("GIT_EDITOR", "true")).await?;
        Ok(())
    }

    pub async fn abort_operation(&self, repo: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let a = match self.operation(repo).await? {
            Some(op @ ("merge" | "rebase" | "cherry-pick" | "revert")) => args![op, "--abort"],
            Some("bisect") => args!["bisect", "reset"],
            _ => return Err("No operation in progress".into()),
        };
        self.write(repo, a).await?;
        Ok(())
    }

    pub async fn skip_operation(&self, repo: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let a = match self.operation(repo).await? {
            Some(op @ ("rebase" | "cherry-pick" | "revert")) => args![op, "--skip"],
            _ => return Err("Nothing to skip".into()),
        };
        self.write_opts(repo, a, Opts::default().env("GIT_EDITOR", "true")).await?;
        Ok(())
    }

    // ---------------------------------------------------------------- stashes

    pub async fn stash_save(&self, repo: &str, message: Option<String>, include_untracked: bool) -> Res<()> {
        let _g = self.lock(repo).await;
        let mut a = args!["stash", "push"];
        if include_untracked {
            a.push("--include-untracked".into());
        }
        if let Some(m) = message.filter(|m| !m.is_empty()) {
            a.extend(args!["-m", m]);
        }
        let r = self.write(repo, a).await?;
        if format!("{}{}", r.stdout, r.stderr).contains("No local changes to save") {
            return Err("No local changes to stash".into());
        }
        Ok(())
    }

    pub async fn stash_apply(&self, repo: &str, index: u32, pop: bool) -> Res<()> {
        let _g = self.lock(repo).await;
        let verb = if pop { "pop" } else { "apply" };
        let stash = format!("stash@{{{index}}}");
        if self.write(repo, args!["stash", verb, "--index", stash.as_str()]).await.is_err() {
            self.write(repo, args!["stash", verb, stash]).await?;
        }
        Ok(())
    }

    pub async fn stash_drop(&self, repo: &str, index: u32) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["stash", "drop", format!("stash@{{{index}}}")]).await?;
        Ok(())
    }

    // ---------------------------------------------------------------- remotes

    pub async fn fetch(&self, repo: &str, remote: Option<String>, prune: bool) -> Res<()> {
        let _g = self.lock(repo).await;
        let mut a = args!["fetch", "--progress", "--tags"];
        if prune {
            a.push("--prune".into());
        }
        a.push(remote.filter(|r| !r.is_empty()).unwrap_or_else(|| "--all".into()));
        self.write_opts(repo, a, Opts::default().progress(self.progress(repo, "fetch"))).await?;
        Ok(())
    }

    pub async fn pull(&self, repo: &str, mode: &str) -> Res<()> {
        let flag = match mode {
            "rebase" => "--rebase",
            "ff-only" => "--ff-only",
            "ff" => "--no-rebase",
            _ => return Err(format!("Invalid pull mode: {mode}")),
        };
        let _g = self.lock(repo).await;
        let opts = Opts::default().progress(self.progress(repo, "pull"));
        self.write_opts(repo, args!["pull", "--progress", flag, "--no-edit"], opts).await?;
        Ok(())
    }

    pub async fn push(&self, repo: &str, opts: PushOptions) -> Res<()> {
        let _g = self.lock(repo).await;
        let branch = match opts.branch {
            Some(b) => b,
            None => self.current_branch(repo).await?.ok_or("Cannot push from a detached HEAD")?,
        };
        let upstream = self
            .read(repo, args!["rev-parse", "--abbrev-ref", "--symbolic-full-name", format!("{branch}@{{upstream}}")], &[0, 128])
            .await?;
        let mut a = args!["push", "--progress"];
        if opts.force == Some(true) {
            a.push("--force-with-lease".into());
        }
        let mut remote = opts.remote;
        let mut refspec = branch.clone();
        if remote.is_none() && upstream.code == 0 {
            let up = upstream.stdout.trim();
            remote = match_remote(&self.remote_names(repo).await?, up);
            if let Some(r) = &remote {
                refspec = format!("{branch}:{}", &up[r.len() + 1..]);
            }
        }
        let remote = match remote {
            Some(r) => r,
            None => self.default_remote(repo).await?,
        };
        if opts.set_upstream.unwrap_or(upstream.code != 0) {
            a.push("--set-upstream".into());
        }
        a.extend(args![remote, format!("refs/heads/{}", refspec.replacen(':', ":refs/heads/", 1))]);
        self.write_opts(repo, a, Opts::default().progress(self.progress(repo, "push"))).await?;
        Ok(())
    }

    pub async fn add_remote(&self, repo: &str, name: &str, url: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["remote", "add", name, url]).await?;
        Ok(())
    }

    pub async fn remove_remote(&self, repo: &str, name: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["remote", "remove", name]).await?;
        Ok(())
    }

    pub async fn edit_remote(&self, repo: &str, name: &str, url: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["remote", "set-url", name, url]).await?;
        Ok(())
    }

    // -------------------------------------------------- submodules & worktrees

    pub async fn submodule_update(&self, repo: &str, path: Option<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        let mut a = args!["submodule", "update", "--init", "--recursive", "--progress"];
        if let Some(p) = path {
            a.extend(args!["--", p]);
        }
        self.write_opts(repo, a, Opts::default().progress(self.progress(repo, "submodule"))).await?;
        Ok(())
    }

    pub async fn submodule_add(&self, repo: &str, url: &str, path: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        let opts = Opts::default().progress(self.progress(repo, "submodule"));
        self.write_opts(repo, args!["submodule", "add", "--progress", url, path], opts).await?;
        Ok(())
    }

    pub async fn worktree_add(
        &self,
        repo: &str,
        path: &str,
        reference: &str,
        new_branch: Option<String>,
        lock: bool,
    ) -> Res<()> {
        let _g = self.lock(repo).await;
        let target = Path::new(repo).join(path).to_string_lossy().into_owned();
        let mut a = args!["worktree", "add"];
        if lock {
            a.push("--lock".into());
        }
        match new_branch {
            Some(b) => a.extend(args!["-b", b, target, reference]),
            None => a.extend(args![target, reference.strip_prefix("refs/heads/").unwrap_or(reference)]),
        }
        self.write(repo, a).await?;
        Ok(())
    }

    pub async fn worktree_remove(&self, repo: &str, path: &str, force: bool) -> Res<()> {
        let _g = self.lock(repo).await;
        let mut a = args!["worktree", "remove"];
        if force {
            a.push("--force".into());
        }
        a.push(path.into());
        self.write(repo, a).await?;
        Ok(())
    }

    pub async fn worktree_lock(&self, repo: &str, path: &str, lock: bool, reason: Option<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        let mut a = args!["worktree", if lock { "lock" } else { "unlock" }];
        if let Some(r) = reason.filter(|r| lock && !r.trim().is_empty()) {
            a.extend(args!["--reason", r.trim()]);
        }
        a.push(path.into());
        self.write(repo, a).await?;
        Ok(())
    }

    pub async fn worktree_prune(&self, repo: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, args!["worktree", "prune"]).await?;
        Ok(())
    }

    // ----------------------------------------------------------------- config

    pub async fn get_config(&self, repo: Option<&str>, key: &str) -> Res<Option<String>> {
        let cwd = repo.map(PathBuf::from).unwrap_or_else(home);
        let mut a = args!["config"];
        if repo.is_none() {
            a.push("--global".into());
        }
        a.extend(args!["--get", key]);
        let r = git(&cwd, &a, Opts::read().ok(&[0, 1])).await?;
        Ok((r.code == 0).then(|| r.stdout.strip_suffix('\n').unwrap_or(&r.stdout).to_string()))
    }

    pub async fn set_config(&self, repo: Option<&str>, key: &str, value: &str, global: bool) -> Res<()> {
        let cwd = repo.map(PathBuf::from).unwrap_or_else(home);
        let mut a = args!["config"];
        if global || repo.is_none() {
            a.push("--global".into());
        }
        a.extend(args![key, value]);
        git(&cwd, &a, Opts::default()).await?;
        Ok(())
    }

    // ---------------------------------------------------------------- gitflow

    pub async fn gitflow_config(&self, repo: &str) -> Res<Option<GitflowConfig>> {
        let get = |k: &'static str| self.get_config(Some(repo), k);
        let (master, develop, feature, release, hotfix, version_tag) = tokio::try_join!(
            get("gitflow.branch.master"),
            get("gitflow.branch.develop"),
            get("gitflow.prefix.feature"),
            get("gitflow.prefix.release"),
            get("gitflow.prefix.hotfix"),
            get("gitflow.prefix.versiontag")
        )?;
        let (Some(master), Some(develop)) = (master.filter(|s| !s.is_empty()), develop.filter(|s| !s.is_empty()))
        else {
            return Ok(None);
        };
        Ok(Some(GitflowConfig {
            master,
            develop,
            feature: feature.unwrap_or_else(|| "feature/".into()),
            release: release.unwrap_or_else(|| "release/".into()),
            hotfix: hotfix.unwrap_or_else(|| "hotfix/".into()),
            version_tag: version_tag.unwrap_or_default(),
        }))
    }

    pub async fn gitflow_init(&self, repo: &str, config: GitflowConfig) -> Res<()> {
        let _g = self.lock(repo).await;
        for (k, v) in [
            ("gitflow.branch.master", &config.master),
            ("gitflow.branch.develop", &config.develop),
            ("gitflow.prefix.feature", &config.feature),
            ("gitflow.prefix.release", &config.release),
            ("gitflow.prefix.hotfix", &config.hotfix),
            ("gitflow.prefix.versiontag", &config.version_tag),
        ] {
            self.write(repo, args!["config", k, v.as_str()]).await?;
        }
        if !self.has_head(repo).await? {
            self.write(repo, args!["symbolic-ref", "HEAD", format!("refs/heads/{}", config.master)]).await?;
            self.write(repo, args!["commit", "--allow-empty", "--no-verify", "-m", "Initial commit"]).await?;
        }
        if !self.verify(repo, &format!("refs/heads/{}", config.master)).await? {
            let remote_master = self.verify(repo, &format!("refs/remotes/origin/{}", config.master)).await?;
            let start = if remote_master { format!("origin/{}", config.master) } else { "HEAD".into() };
            self.write(repo, args!["branch", config.master.as_str(), start]).await?;
        }
        if !self.verify(repo, &format!("refs/heads/{}", config.develop)).await? {
            self.write(repo, args!["branch", config.develop.as_str(), config.master.as_str()]).await?;
        }
        self.write(repo, args!["checkout", "-q", config.develop.as_str()]).await?;
        Ok(())
    }

    async fn require_gitflow(&self, repo: &str) -> Res<GitflowConfig> {
        self.gitflow_config(repo).await?.ok_or_else(|| "Gitflow is not initialized in this repository".into())
    }

    fn gitflow_prefix<'a>(cfg: &'a GitflowConfig, kind: &str) -> Res<&'a str> {
        match kind {
            "feature" => Ok(&cfg.feature),
            "release" => Ok(&cfg.release),
            "hotfix" => Ok(&cfg.hotfix),
            _ => Err(format!("Invalid gitflow kind: {kind}")),
        }
    }

    pub async fn gitflow_start(&self, repo: &str, kind: &str, name: &str) -> Res<()> {
        let cfg = self.require_gitflow(repo).await?;
        let prefix = Self::gitflow_prefix(&cfg, kind)?;
        let base = if kind == "hotfix" { &cfg.master } else { &cfg.develop };
        self.create_branch(repo, &format!("{prefix}{name}"), Some(base.clone()), true).await
    }

    pub async fn gitflow_finish(&self, repo: &str, kind: &str, name: &str, opts: GitflowFinishOptions) -> Res<()> {
        let cfg = self.require_gitflow(repo).await?;
        let branch = format!("{}{name}", Self::gitflow_prefix(&cfg, kind)?);
        let _g = self.lock(repo).await;
        let merge_into = |target: String, source: String| async move {
            self.write(repo, args!["checkout", "-q", target]).await?;
            self.write(repo, args!["merge", "--no-ff", "--no-edit", source]).await?;
            Ok::<_, String>(())
        };
        if kind == "feature" {
            merge_into(cfg.develop.clone(), branch.clone()).await?;
        } else {
            let tag = format!("{}{name}", cfg.version_tag);
            merge_into(cfg.master.clone(), branch.clone()).await?;
            let msg = opts.tag_message.filter(|m| !m.is_empty()).unwrap_or_else(|| tag.clone());
            self.write(repo, args!["tag", "-a", tag.as_str(), "-m", msg]).await?;
            // back-merge the tag (git-flow-avh default) so master stays an ancestor of develop
            merge_into(cfg.develop.clone(), format!("refs/tags/{tag}")).await?;
        }
        if opts.delete_branch.unwrap_or(true) {
            self.write(repo, args!["branch", "-d", branch]).await?;
        }
        Ok(())
    }

    // -------------------------------------------------------------------- lfs

    async fn pre_push_hook(&self, repo: &str) -> String {
        match self.git_dir(repo).await {
            Ok(dir) => tokio::fs::read_to_string(Path::new(&dir).join("hooks").join("pre-push")).await.unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    pub async fn lfs_installed(&self, repo: &str) -> Res<bool> {
        match self.read(repo, args!["lfs", "version"], &[0, 1, 127, 128]).await {
            Ok(o) if o.code == 0 => {}
            _ => return Ok(false),
        }
        let hook = self.pre_push_hook(repo).await;
        Ok(hook.contains("git lfs") || hook.contains("git-lfs"))
    }

    pub async fn lfs_track(&self, repo: &str, pattern: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        if !self.pre_push_hook(repo).await.contains("lfs") {
            self.write(repo, args!["lfs", "install", "--local"]).await?;
        }
        self.write(repo, args!["lfs", "track", pattern]).await?;
        Ok(())
    }

    pub async fn lfs_command(&self, repo: &str, cmd: &str) -> Res<()> {
        if !["fetch", "pull", "push", "prune", "checkout"].contains(&cmd) {
            return Err(format!("Invalid lfs command: {cmd}"));
        }
        let _g = self.lock(repo).await;
        let mut a = args!["lfs", cmd];
        if cmd == "push" {
            a.extend(args!["--all", self.default_remote(repo).await?]);
        }
        self.write_opts(repo, a, Opts::default().progress(self.progress(repo, &format!("lfs {cmd}")))).await?;
        Ok(())
    }

    // --------------------------------------------------------------- watching

    pub fn watch(&self, repo: &str) {
        let mut watchers = self.watchers.lock().unwrap();
        if watchers.contains_key(repo) {
            return;
        }
        let hooks = self.hooks.clone();
        let key = repo.to_string();
        let w = RepoWatcher::start(repo, std::time::Duration::from_millis(300), move || hooks.repo_changed(&key));
        watchers.insert(repo.to_string(), w);
    }

    pub fn unwatch(&self, repo: &str) {
        self.watchers.lock().unwrap().remove(repo);
    }

    pub fn unwatch_all(&self) {
        self.watchers.lock().unwrap().clear();
    }
}

fn apply_numstat(files: &mut [FileChange], stats: &HashMap<String, NumStat>) {
    for f in files {
        if let Some(n) = stats.get(&f.path) {
            f.additions = Some(n.additions);
            f.deletions = Some(n.deletions);
            f.binary = Some(n.binary);
        }
    }
}

#[cfg(test)]
mod progress_tests {
    use super::ProgressThrottle;
    use std::time::{Duration, Instant};

    #[test]
    fn throttles_counter_updates_within_a_phase() {
        let mut t = ProgressThrottle::default();
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        assert!(t.accept("Cloning into 'x'...", at(0)));
        assert!(t.accept("remote: Counting objects:  10% (1/10)", at(0)));
        assert!(!t.accept("remote: Counting objects:  20% (2/10)", at(30)));
        assert!(t.accept("remote: Counting objects: 100% (10/10), done.", at(40)));
        assert!(t.accept("Receiving objects:   1% (1/100)", at(50)), "a new phase passes at once");
        assert!(!t.accept("Receiving objects:   2% (2/100), 1.00 MiB | 2.00 MiB/s", at(100)));
        assert!(t.accept("Receiving objects:   9% (9/100), 4.00 MiB | 2.00 MiB/s", at(160)));
        assert!(t.accept("To example.com:repo.git", at(161)), "lines without a percentage always pass");
    }
}
