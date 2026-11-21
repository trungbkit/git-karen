// Debounced file-system watcher for a repository work tree.
// Each batch of changes is reported with its scope: whether the history may have moved or only the status.
// Changes inside folders and files that .gitignore excludes are dropped (build output, virtualenvs, caches). macOS
// (FSEvents) and Windows watch the tree with one recursive watch; Linux (inotify) needs one watch per folder, so there
// the ignored folders are never watched at all.
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, LazyLock, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;

use crate::types::ChangeScope;

// HEAD, refs and operation state: a change here may move the history. `index` only changes the status.
static GIT_REFS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(HEAD|refs(/.*)?|packed-refs|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-(merge|apply)(/.*)?|logs/refs/stash)$",
    )
    .unwrap()
});

/// Paths kept per batch for the ignore check; a bigger batch is reported without filtering.
const MAX_BATCH_PATHS: usize = 5000;
/// Paths sent to one `git check-ignore`.
const CHECK_IGNORE_SAMPLE: usize = 1000;

fn normalize(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// What a change at `rel` (relative to the work tree, '/'-separated) needs refreshed; None when it needs nothing.
pub fn classify_change(rel: &str) -> Option<ChangeScope> {
    let p = normalize(rel);
    if p.contains("/node_modules/") || p.starts_with("node_modules/") {
        return None;
    }
    if p == ".git" || p.starts_with(".git/") {
        let inner = p.get(5..).unwrap_or("");
        if inner.ends_with(".lock") {
            return None;
        }
        // the exclude file changes which untracked files the status lists
        if inner == "index" || inner == "info/exclude" {
            return Some(ChangeScope::Worktree);
        }
        return GIT_REFS.is_match(inner).then_some(ChangeScope::Refs);
    }
    Some(ChangeScope::Worktree)
}

/// A file whose edit changes what git ignores.
fn is_ignore_rules(rel: &str) -> bool {
    rel == ".gitignore" || rel.ends_with("/.gitignore") || rel == ".git/info/exclude"
}

/// What git ignores in the work tree: whole folders (`dir/`) and single files, as
/// `git ls-files --others --ignored --exclude-standard --directory` lists them.
#[derive(Default, Debug)]
pub struct IgnoreCache {
    entries: HashSet<String>,
}

impl IgnoreCache {
    pub fn from_listing(nul_separated: &str) -> Self {
        IgnoreCache { entries: nul_separated.split('\0').filter(|s| !s.is_empty()).map(normalize).collect() }
    }

    /// Whether `rel` (a file or folder, with or without a trailing '/') is ignored or lies inside an ignored folder.
    pub fn covers(&self, rel: &str) -> bool {
        if self.entries.is_empty() || rel.is_empty() {
            return false;
        }
        let rel = rel.trim_end_matches('/');
        if self.entries.contains(rel) || self.entries.contains(&format!("{rel}/")) {
            return true;
        }
        rel.match_indices('/').any(|(i, _)| self.entries.contains(&rel[..=i]))
    }

    fn insert(&mut self, rel: &str) {
        self.entries.insert(rel.to_string());
    }
}

/// Runs git without blocking on a full pipe: stdin is written from its own thread. None when git cannot run.
fn git_blocking(root: &Path, args: &[&str], input: Option<Vec<u8>>) -> Option<String> {
    let mut cmd = Command::new(super::exec::git_bin());
    cmd.args(args)
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    let writer = match (child.stdin.take(), input) {
        (Some(mut stdin), Some(data)) => Some(std::thread::spawn(move || drop(stdin.write_all(&data)))),
        _ => None,
    };
    let out = child.wait_with_output().ok()?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    // check-ignore exits 1 when nothing is ignored; anything above that is an error
    matches!(out.status.code(), Some(0 | 1)).then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn load_ignored(root: &Path) -> IgnoreCache {
    let listing = git_blocking(root, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], None);
    listing.map(|l| IgnoreCache::from_listing(&l)).unwrap_or_default()
}

/// The paths among `paths` that git ignores (folders are asked about with a trailing '/').
fn check_ignored(root: &Path, paths: &[String]) -> HashSet<String> {
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p.as_bytes());
        if root.join(p).is_dir() {
            input.push(b'/');
        }
        input.push(0);
    }
    let out = git_blocking(root, &["check-ignore", "--stdin", "-z"], Some(input)).unwrap_or_default();
    out.split('\0').filter(|s| !s.is_empty()).map(|s| s.trim_end_matches('/').to_string()).collect()
}

/// What the watcher tells its owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    Changed(ChangeScope),
    /// Watching stopped or is incomplete; reported at most once per watcher
    Failed(String),
}

#[derive(Clone, Copy, Debug)]
pub struct WatchConfig {
    /// Quiet time after the last change before a batch is reported
    pub debounce: Duration,
    /// Longest a batch waits while changes keep coming
    pub max_wait: Duration,
    /// One non-recursive watch per folder that is not ignored, instead of one recursive watch
    pub per_directory: bool,
}

impl WatchConfig {
    /// inotify spends one watch per folder (and the system has a limit), so Linux watches folder by folder.
    pub fn new(debounce: Duration, max_wait: Duration) -> Self {
        WatchConfig { debounce, max_wait, per_directory: cfg!(target_os = "linux") }
    }
}

enum Msg {
    Change { scope: ChangeScope, path: Option<String>, rules: bool },
    Failed(String),
}

/// The changes of one debounce window.
#[derive(Debug, Default)]
struct Batch {
    scope: Option<ChangeScope>,
    /// Work-tree paths, for the ignore check and for new folders to watch
    paths: Vec<String>,
    /// More than MAX_BATCH_PATHS paths came in
    overflow: bool,
    /// .gitignore or .git/info/exclude changed
    rules: bool,
    /// A change without a work-tree path (inside .git, or a rescan): never dropped as ignored
    pathless: bool,
    failure: Option<String>,
}

impl Batch {
    fn add(&mut self, msg: Msg) {
        match msg {
            Msg::Change { scope, path, rules } => {
                self.scope = self.scope.max(Some(scope));
                self.rules |= rules;
                match path {
                    Some(p) if self.paths.len() < MAX_BATCH_PATHS => self.paths.push(p),
                    Some(_) => self.overflow = true,
                    None => self.pathless = true,
                }
            }
            Msg::Failed(m) => {
                self.failure.get_or_insert(m);
            }
        }
    }
}

/// Waits for a quiet `debounce` after the first message, but never longer than `max_wait` in total, and merges the
/// batch. Returns None once every sender is gone.
fn next_batch(rx: &Receiver<Msg>, debounce: Duration, max_wait: Duration) -> Option<Batch> {
    let mut batch = Batch::default();
    batch.add(rx.recv().ok()?);
    let deadline = Instant::now() + max_wait;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Some(batch);
        }
        match rx.recv_timeout(debounce.min(left)) {
            Ok(m) => batch.add(m),
            // report what was collected; the next call sees the disconnect
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return Some(batch),
        }
    }
}

fn failure_message(e: &notify::Error) -> String {
    match e.kind {
        notify::ErrorKind::MaxFilesWatch => "The system limit on watched folders was reached. On Linux, raise it with \
             `sudo sysctl fs.inotify.max_user_watches=524288` (add the setting to /etc/sysctl.conf to keep it), then \
             reopen the repository."
            .into(),
        _ => e.to_string(),
    }
}

/// Owns the watch list of a per-directory watcher and turns batches into events. Runs on the debounce thread.
struct Worker {
    root: PathBuf,
    cache: Arc<RwLock<IgnoreCache>>,
    watcher: Weak<Mutex<RecommendedWatcher>>,
    per_directory: bool,
    watched: HashSet<PathBuf>,
    failed: bool,
    on_event: Box<dyn Fn(WatchEvent) + Send>,
}

impl Worker {
    fn fail(&mut self, message: String) {
        if !self.failed {
            self.failed = true;
            (self.on_event)(WatchEvent::Failed(message));
        }
    }

    fn reload_ignored(&self) {
        let fresh = load_ignored(&self.root);
        *self.cache.write().unwrap() = fresh;
    }

    fn add_watch(&mut self, path: &Path, mode: RecursiveMode) -> bool {
        let Some(watcher) = self.watcher.upgrade() else { return false };
        let result = watcher.lock().unwrap().watch(path, mode);
        match result {
            Ok(()) => true,
            Err(e) if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) => {
                self.fail(failure_message(&e));
                false
            }
            // the folder went away in the meantime
            Err(_) => true,
        }
    }

    /// Watch `start` and every folder below it that is not ignored, each without recursion. Stops at the watch limit.
    fn watch_tree(&mut self, start: &Path) {
        let mut stack = vec![start.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let rel = match dir.strip_prefix(&self.root) {
                Ok(r) => normalize(&r.to_string_lossy()),
                Err(_) => continue,
            };
            let skip = rel == ".git"
                || rel.starts_with(".git/")
                || rel.split('/').any(|c| c == "node_modules")
                || self.cache.read().unwrap().covers(&rel);
            if skip {
                continue;
            }
            // folders already watched are still walked: below them may be one that was ignored until now
            if !self.watched.contains(&dir) {
                if !self.add_watch(&dir, RecursiveMode::NonRecursive) {
                    return;
                }
                self.watched.insert(dir.clone());
            }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            // file_type does not follow symlinks, so linked folders are not walked (git does not follow them either)
            stack.extend(entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
        }
    }

    fn watch_all(&mut self) {
        let git_dir = self.root.join(".git");
        if git_dir.is_dir() && !self.watched.contains(&git_dir) {
            // HEAD, index and operation files sit directly in .git; branches and tags below refs/
            if !self.add_watch(&git_dir, RecursiveMode::NonRecursive) || !self.add_watch(&git_dir.join("refs"), RecursiveMode::Recursive) {
                return;
            }
            self.watched.insert(git_dir);
        }
        let root = self.root.clone();
        self.watch_tree(&root);
    }

    /// Folders created or removed in this batch: watch the new ones (and their contents), forget the removed ones.
    fn update_watches(&mut self, batch: &Batch) {
        if batch.overflow || batch.rules {
            self.watched.retain(|d| d.exists());
            self.watch_all();
            return;
        }
        for rel in &batch.paths {
            let abs = self.root.join(rel);
            if abs.is_dir() {
                // a folder removed and created again within the batch lost its inotify watch: watch it anew
                self.watched.remove(&abs);
                self.watch_tree(&abs);
            } else if self.watched.remove(&abs) {
                if let Some(w) = self.watcher.upgrade() {
                    let _ = w.lock().unwrap().unwatch(&abs);
                }
            }
        }
    }

    /// Whether every change of the batch is in ignored territory. Learns new ignored folders on the way.
    fn all_ignored(&self, batch: &Batch) -> bool {
        if batch.scope != Some(ChangeScope::Worktree) || batch.rules || batch.pathless || batch.paths.is_empty() {
            return false;
        }
        let unknown: Vec<String> = {
            let cache = self.cache.read().unwrap();
            batch.paths.iter().filter(|p| !cache.covers(p)).cloned().collect()
        };
        if unknown.is_empty() {
            return !batch.overflow;
        }
        let sample = &unknown[..unknown.len().min(CHECK_IGNORE_SAMPLE)];
        let ignored = check_ignored(&self.root, sample);
        if ignored.is_empty() {
            return false;
        }
        // something ignored appeared that the cache does not know (a new build folder): relist, so the notify
        // callback drops its later changes without asking git
        self.reload_ignored();
        let mut cache = self.cache.write().unwrap();
        for p in &ignored {
            cache.insert(p);
        }
        !batch.overflow && unknown.len() <= CHECK_IGNORE_SAMPLE && unknown.iter().all(|p| cache.covers(p))
    }

    fn handle(&mut self, batch: Batch) {
        if let Some(m) = batch.failure.clone() {
            self.fail(m);
        }
        if batch.rules {
            self.reload_ignored();
        }
        if self.per_directory {
            self.update_watches(&batch);
        }
        if let Some(scope) = batch.scope {
            if !self.all_ignored(&batch) {
                (self.on_event)(WatchEvent::Changed(scope));
            }
        }
    }
}

/// Dropping the watcher stops it: the notify callback owns the channel sender, so the debounce thread exits too.
pub struct RepoWatcher {
    _inner: Option<Arc<Mutex<RecommendedWatcher>>>,
}

impl RepoWatcher {
    pub fn start(root: &str, config: WatchConfig, on_event: impl Fn(WatchEvent) + Send + 'static) -> Self {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
        let cache = Arc::new(RwLock::new(IgnoreCache::default()));
        let (tx, rx) = mpsc::channel::<Msg>();
        let watcher = notify::recommended_watcher(event_handler(root.clone(), cache.clone(), tx)).and_then(|mut w| {
            if !config.per_directory {
                w.watch(&root, RecursiveMode::Recursive)?;
            }
            Ok(w)
        });
        let watcher = match watcher {
            Ok(w) => Arc::new(Mutex::new(w)),
            Err(e) => {
                // the renderer still refreshes after its own operations; tell the user automatic refresh is off
                if root.is_dir() {
                    on_event(WatchEvent::Failed(failure_message(&e)));
                }
                return RepoWatcher { _inner: None };
            }
        };
        let mut worker = Worker {
            root,
            cache,
            watcher: Arc::downgrade(&watcher),
            per_directory: config.per_directory,
            watched: HashSet::new(),
            failed: false,
            on_event: Box::new(on_event),
        };
        std::thread::spawn(move || {
            worker.reload_ignored();
            if worker.per_directory {
                worker.watch_all();
            }
            while let Some(batch) = next_batch(&rx, config.debounce, config.max_wait) {
                worker.handle(batch);
            }
        });
        RepoWatcher { _inner: Some(watcher) }
    }
}

/// The notify callback: classifies each path and drops the ones the ignore cache covers, before they reach the
/// debounce thread (so a build writing thousands of ignored files does not even delay a batch).
fn event_handler(
    base: PathBuf,
    cache: Arc<RwLock<IgnoreCache>>,
    tx: Sender<Msg>,
) -> impl FnMut(notify::Result<notify::Event>) + Send + 'static {
    move |res: notify::Result<notify::Event>| {
        let ev = match res {
            Ok(ev) => ev,
            Err(e) => {
                if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) {
                    let _ = tx.send(Msg::Failed(failure_message(&e)));
                }
                return;
            }
        };
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        // no paths (the backend lost track and asks for a rescan): reload everything
        if ev.paths.is_empty() {
            let _ = tx.send(Msg::Change { scope: ChangeScope::Refs, path: None, rules: false });
            return;
        }
        for p in &ev.paths {
            let Ok(rel) = p.strip_prefix(&base) else {
                let _ = tx.send(Msg::Change { scope: ChangeScope::Refs, path: None, rules: false });
                continue;
            };
            let rel = normalize(&rel.to_string_lossy());
            let Some(scope) = classify_change(&rel) else { continue };
            let in_git = rel == ".git" || rel.starts_with(".git/");
            if !in_git && cache.read().unwrap().covers(&rel) {
                continue;
            }
            let rules = is_ignore_rules(&rel);
            let _ = tx.send(Msg::Change { scope, path: (!in_git && !rel.is_empty()).then_some(rel), rules });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_relevant_change(rel: &str) -> bool {
        classify_change(rel).is_some()
    }

    #[test]
    fn filters_git_internals_and_node_modules() {
        assert!(is_relevant_change("src/a.ts"));
        assert!(is_relevant_change(".git/index"));
        assert!(is_relevant_change(".git/refs/heads/main"));
        assert!(!is_relevant_change(".git/index.lock"));
        assert!(!is_relevant_change(".git/objects/ab/cdef"));
        assert!(!is_relevant_change(".git/FETCH_HEAD"));
        assert!(!is_relevant_change("web/node_modules/x/index.js"));
    }

    #[test]
    fn classifies_changes_by_scope() {
        use ChangeScope::*;
        assert_eq!(classify_change("src/a.ts"), Some(Worktree));
        assert_eq!(classify_change(".gitignore"), Some(Worktree));
        assert_eq!(classify_change(".git/index"), Some(Worktree));
        assert_eq!(classify_change(".git/info/exclude"), Some(Worktree));
        assert_eq!(classify_change(".git/HEAD"), Some(Refs));
        assert_eq!(classify_change(".git/refs/heads/main"), Some(Refs));
        assert_eq!(classify_change(".git/refs/remotes/origin/main"), Some(Refs));
        assert_eq!(classify_change(".git/packed-refs"), Some(Refs));
        assert_eq!(classify_change(".git/MERGE_HEAD"), Some(Refs));
        assert_eq!(classify_change(".git/rebase-merge/done"), Some(Refs));
        assert_eq!(classify_change(".git/logs/refs/stash"), Some(Refs));
        assert_eq!(classify_change(".git\\refs\\tags\\v1"), Some(Refs), "Windows separators");
        assert_eq!(classify_change(".git/refs/heads/main.lock"), None);
        assert_eq!(classify_change(".git/logs/HEAD"), None);
        assert_eq!(classify_change("node_modules/a.js"), None);
    }

    #[test]
    fn ignore_cache_covers_folders_and_files() {
        let cache = IgnoreCache::from_listing("target/\0web/dist/\0src/debug.log\0");
        assert!(cache.covers("target"));
        assert!(cache.covers("target/"));
        assert!(cache.covers("target/debug/build/x.o"));
        assert!(cache.covers("web/dist/app.js"));
        assert!(cache.covers("src/debug.log"));
        assert!(!cache.covers("src/main.rs"));
        assert!(!cache.covers("targets/x"), "a prefix of a name is not its folder");
        assert!(!cache.covers("web"));
        assert!(!cache.covers(""));
        assert!(!IgnoreCache::default().covers("anything"));
    }

    #[test]
    fn ignore_rule_files() {
        assert!(is_ignore_rules(".gitignore"));
        assert!(is_ignore_rules("web/.gitignore"));
        assert!(is_ignore_rules(".git/info/exclude"));
        assert!(!is_ignore_rules("src/gitignore.rs"));
    }

    fn change(scope: ChangeScope, path: &str) -> Msg {
        Msg::Change { scope, path: Some(path.into()), rules: false }
    }

    #[test]
    fn batches_merge_scopes_and_respect_the_max_wait() {
        let (tx, rx) = mpsc::channel();
        tx.send(change(ChangeScope::Worktree, "a")).unwrap();
        tx.send(change(ChangeScope::Refs, "b")).unwrap();
        tx.send(change(ChangeScope::Worktree, "c")).unwrap();
        let batch = next_batch(&rx, Duration::from_millis(20), Duration::from_secs(1)).unwrap();
        assert_eq!(batch.scope, Some(ChangeScope::Refs), "any refs change makes the batch a refs batch");
        assert_eq!(batch.paths, ["a", "b", "c"]);

        // a writer that never pauses for the debounce still gets a batch after max_wait
        let (tx, rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            for _ in 0..100 {
                if tx.send(change(ChangeScope::Worktree, "x")).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let start = Instant::now();
        let batch = next_batch(&rx, Duration::from_millis(100), Duration::from_millis(250)).unwrap();
        let took = start.elapsed();
        assert_eq!(batch.scope, Some(ChangeScope::Worktree));
        assert!(took < Duration::from_millis(600), "reported after the max wait, took {took:?}");
        drop(rx);
        writer.join().unwrap();
    }

    fn config(per_directory: bool) -> WatchConfig {
        WatchConfig { debounce: Duration::from_millis(100), max_wait: Duration::from_secs(2), per_directory }
    }

    fn collect(dir: &Path, per_directory: bool) -> (RepoWatcher, Receiver<WatchEvent>) {
        let (tx, rx) = mpsc::channel();
        let w = RepoWatcher::start(&dir.to_string_lossy(), config(per_directory), move |e| {
            let _ = tx.send(e);
        });
        std::thread::sleep(Duration::from_millis(500)); // FSEvents needs a moment before it reports
        (w, rx)
    }

    /// Waits for the next change; panics on a failure event.
    fn changed(rx: &Receiver<WatchEvent>, within: Duration) -> Option<ChangeScope> {
        match rx.recv_timeout(within) {
            Ok(WatchEvent::Changed(scope)) => Some(scope),
            Ok(WatchEvent::Failed(m)) => panic!("watcher failed: {m}"),
            Err(_) => None,
        }
    }

    fn drain(rx: &Receiver<WatchEvent>) {
        while changed(rx, Duration::from_millis(600)).is_some() {}
    }

    #[test]
    fn reports_debounced_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (_w, rx) = collect(dir.path(), false);
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
        }
        assert_eq!(changed(&rx, Duration::from_secs(5)), Some(ChangeScope::Worktree));
        assert_eq!(changed(&rx, Duration::from_millis(400)), None, "burst is debounced into one event");
    }

    fn ignoring_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(git_blocking(root, &["init", "-q"], None).is_some());
        std::fs::write(root.join(".gitignore"), "build/\ndist/\n").unwrap();
        std::fs::create_dir_all(root.join("build/deep")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "a").unwrap();
        dir
    }

    fn ignores_changes_in_ignored_folders(per_directory: bool) {
        let dir = ignoring_repo();
        let root = dir.path();
        let (_w, rx) = collect(root, per_directory);
        drain(&rx);

        // an ignored folder that existed when watching started
        std::fs::write(root.join("build/deep/out.o"), "x").unwrap();
        assert_eq!(changed(&rx, Duration::from_millis(800)), None, "build/ is ignored");

        // an ignored folder created afterwards: git check-ignore decides
        std::fs::create_dir_all(root.join("dist/js")).unwrap();
        std::fs::write(root.join("dist/js/app.js"), "x").unwrap();
        assert_eq!(changed(&rx, Duration::from_millis(1200)), None, "dist/ is ignored");
        std::fs::write(root.join("dist/js/app2.js"), "x").unwrap();
        assert_eq!(changed(&rx, Duration::from_millis(800)), None, "dist/ is now in the cache");

        // a tracked folder still reports
        std::fs::write(root.join("src/a.txt"), "b").unwrap();
        assert_eq!(changed(&rx, Duration::from_secs(5)), Some(ChangeScope::Worktree));
        drain(&rx);

        // editing .gitignore updates the list: build/ is no longer ignored, out/ is
        std::fs::write(root.join(".gitignore"), "out/\n").unwrap();
        assert_eq!(changed(&rx, Duration::from_secs(5)), Some(ChangeScope::Worktree), ".gitignore is itself a change");
        drain(&rx);
        std::fs::create_dir_all(root.join("out")).unwrap();
        drain(&rx);
        std::fs::write(root.join("out/x"), "x").unwrap();
        assert_eq!(changed(&rx, Duration::from_millis(800)), None, "out/ is ignored now");
        std::fs::write(root.join("build/deep/out.o"), "y").unwrap();
        assert_eq!(changed(&rx, Duration::from_secs(5)), Some(ChangeScope::Worktree), "build/ is watched again");
    }

    #[test]
    fn ignores_changes_in_ignored_folders_recursive() {
        ignores_changes_in_ignored_folders(false);
    }

    #[test]
    fn ignores_changes_in_ignored_folders_per_directory() {
        ignores_changes_in_ignored_folders(true);
    }

    #[test]
    fn per_directory_watches_new_folders_and_refs() {
        let dir = ignoring_repo();
        let root = dir.path();
        let (_w, rx) = collect(root, true);
        drain(&rx);

        std::fs::create_dir_all(root.join("src/new")).unwrap();
        assert_eq!(changed(&rx, Duration::from_secs(5)), Some(ChangeScope::Worktree), "a new folder is a change");
        drain(&rx);
        std::fs::write(root.join("src/new/file.txt"), "x").unwrap();
        assert_eq!(changed(&rx, Duration::from_secs(5)), Some(ChangeScope::Worktree), "the new folder is watched");
        drain(&rx);

        std::fs::create_dir_all(root.join(".git/refs/heads/feature")).unwrap();
        drain(&rx);
        std::fs::write(root.join(".git/refs/heads/feature/x"), "0000000000000000000000000000000000000000\n").unwrap();
        assert_eq!(changed(&rx, Duration::from_secs(5)), Some(ChangeScope::Refs), "refs are watched recursively");
    }

    #[test]
    fn reports_a_folder_that_cannot_be_watched() {
        // a missing folder is not a failure worth telling the user about: the tab is about to go away
        let (tx, rx) = mpsc::channel();
        let _w = RepoWatcher::start("/definitely/not/here", config(false), move |e| drop(tx.send(e)));
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }
}
