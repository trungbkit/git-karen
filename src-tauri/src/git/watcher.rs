// Recursive, debounced file-system watcher for a repository work tree (FSEvents on macOS).
// Each batch of changes is reported with its scope: whether the history may have moved or only the status.
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::LazyLock;
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

/// What a change at `rel` (relative to the work tree, '/'-separated) needs refreshed; None when it needs nothing.
pub fn classify_change(rel: &str) -> Option<ChangeScope> {
    let p = rel.replace('\\', "/");
    if p.contains("/node_modules/") || p.starts_with("node_modules/") {
        return None;
    }
    if p == ".git" || p.starts_with(".git/") {
        let inner = p.get(5..).unwrap_or("");
        if inner.ends_with(".lock") {
            return None;
        }
        if inner == "index" {
            return Some(ChangeScope::Worktree);
        }
        return GIT_REFS.is_match(inner).then_some(ChangeScope::Refs);
    }
    Some(ChangeScope::Worktree)
}

/// Waits for a quiet `debounce` after the first change, but never longer than `max_wait` in total, and merges the
/// scopes of the batch. Returns None once every sender is gone.
fn next_batch(rx: &Receiver<ChangeScope>, debounce: Duration, max_wait: Duration) -> Option<ChangeScope> {
    let mut scope = rx.recv().ok()?;
    let deadline = Instant::now() + max_wait;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Some(scope);
        }
        match rx.recv_timeout(debounce.min(left)) {
            Ok(s) => scope = scope.max(s),
            Err(RecvTimeoutError::Timeout) => return Some(scope),
            // report what was collected; the next call sees the disconnect
            Err(RecvTimeoutError::Disconnected) => return Some(scope),
        }
    }
}

/// Dropping the watcher stops it: the notify callback owns the channel sender, so the debounce thread exits too.
pub struct RepoWatcher {
    _inner: Option<RecommendedWatcher>,
}

impl RepoWatcher {
    pub fn start(
        root: &str,
        debounce: Duration,
        max_wait: Duration,
        on_change: impl Fn(ChangeScope) + Send + 'static,
    ) -> Self {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
        let base = root.clone();
        let (tx, rx) = mpsc::channel::<ChangeScope>();
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            // no paths (the backend lost track and asks for a rescan) or a path outside the root: reload everything
            let scope = if ev.paths.is_empty() {
                Some(ChangeScope::Refs)
            } else {
                ev.paths
                    .iter()
                    .filter_map(|p| match p.strip_prefix(&base) {
                        Ok(rel) => classify_change(&rel.to_string_lossy()),
                        Err(_) => Some(ChangeScope::Refs),
                    })
                    .max()
            };
            if let Some(scope) = scope {
                let _ = tx.send(scope);
            }
        };
        let watcher = notify::recommended_watcher(handler).and_then(|mut w| {
            w.watch(&root, RecursiveMode::Recursive)?;
            Ok(w)
        });
        match watcher {
            Ok(w) => {
                std::thread::spawn(move || {
                    while let Some(scope) = next_batch(&rx, debounce, max_wait) {
                        on_change(scope);
                    }
                });
                RepoWatcher { _inner: Some(w) }
            }
            // folder vanished or watching unsupported: the renderer still refreshes after its own operations
            Err(_) => RepoWatcher { _inner: None },
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
    fn batches_merge_scopes_and_respect_the_max_wait() {
        let (tx, rx) = mpsc::channel();
        tx.send(ChangeScope::Worktree).unwrap();
        tx.send(ChangeScope::Refs).unwrap();
        tx.send(ChangeScope::Worktree).unwrap();
        let batch = next_batch(&rx, Duration::from_millis(20), Duration::from_secs(1));
        assert_eq!(batch, Some(ChangeScope::Refs), "any refs change makes the batch a refs batch");

        // a writer that never pauses for the debounce still gets a batch after max_wait
        let (tx, rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            for _ in 0..100 {
                if tx.send(ChangeScope::Worktree).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let start = Instant::now();
        let batch = next_batch(&rx, Duration::from_millis(100), Duration::from_millis(250));
        let took = start.elapsed();
        assert_eq!(batch, Some(ChangeScope::Worktree));
        assert!(took < Duration::from_millis(600), "reported after the max wait, took {took:?}");
        drop(rx);
        writer.join().unwrap();
    }

    #[test]
    fn reports_debounced_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = RepoWatcher::start(
            &dir.path().to_string_lossy(),
            Duration::from_millis(100),
            Duration::from_secs(2),
            move |scope| {
                let _ = tx.send(scope);
            },
        );
        std::thread::sleep(Duration::from_millis(300)); // FSEvents needs a moment before it reports
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
        }
        let scope = rx.recv_timeout(Duration::from_secs(5)).expect("change reported");
        assert_eq!(scope, ChangeScope::Worktree);
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "burst is debounced into one event");
    }
}
