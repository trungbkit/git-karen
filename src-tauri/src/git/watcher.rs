// Recursive, debounced file-system watcher for a repository work tree (FSEvents on macOS).
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::LazyLock;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;

static GIT_INTERESTING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(HEAD|index|refs(/.*)?|packed-refs|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-(merge|apply)(/.*)?|logs/refs/stash)$",
    )
    .unwrap()
});

/// Whether a change at `rel` (relative to the work tree, '/'-separated) should trigger a refresh.
pub fn is_relevant_change(rel: &str) -> bool {
    let p = rel.replace('\\', "/");
    if p.contains("/node_modules/") || p.starts_with("node_modules/") {
        return false;
    }
    if p == ".git" || p.starts_with(".git/") {
        let inner = p.get(5..).unwrap_or("");
        if inner.ends_with(".lock") {
            return false;
        }
        return GIT_INTERESTING.is_match(inner);
    }
    true
}

/// Dropping the watcher stops it: the notify callback owns the channel sender, so the debounce thread exits too.
pub struct RepoWatcher {
    _inner: Option<RecommendedWatcher>,
}

impl RepoWatcher {
    pub fn start(root: &str, debounce: Duration, on_change: impl Fn() + Send + 'static) -> Self {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
        let base = root.clone();
        let (tx, rx) = mpsc::channel::<()>();
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            let relevant = ev.paths.is_empty()
                || ev.paths.iter().any(|p| match p.strip_prefix(&base) {
                    Ok(rel) => is_relevant_change(&rel.to_string_lossy()),
                    Err(_) => true,
                });
            if relevant {
                let _ = tx.send(());
            }
        };
        let watcher = notify::recommended_watcher(handler).and_then(|mut w| {
            w.watch(&root, RecursiveMode::Recursive)?;
            Ok(w)
        });
        match watcher {
            Ok(w) => {
                std::thread::spawn(move || {
                    while rx.recv().is_ok() {
                        loop {
                            match rx.recv_timeout(debounce) {
                                Ok(()) => continue,
                                Err(RecvTimeoutError::Timeout) => break,
                                Err(RecvTimeoutError::Disconnected) => return,
                            }
                        }
                        on_change();
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
    fn reports_debounced_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = RepoWatcher::start(&dir.path().to_string_lossy(), Duration::from_millis(100), move || {
            let _ = tx.send(());
        });
        std::thread::sleep(Duration::from_millis(300)); // FSEvents needs a moment before it reports
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
        }
        rx.recv_timeout(Duration::from_secs(5)).expect("change reported");
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "burst is debounced into one event");
    }
}
