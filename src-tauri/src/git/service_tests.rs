// Integration tests for GitService against real temporary repositories (ported from the original TypeScript service tests).
// They never touch the user's git config: GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM / HOME point at a temp home.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};

use tempfile::TempDir;

use super::exec::{git, Opts};
use super::service::{GitService, NoHooks};
use crate::types::*;

static ISOLATE: Once = Once::new();

/// Point git at a throwaway global config, exactly once and before any git process runs.
fn isolate_git_env() {
    ISOLATE.call_once(|| {
        let home = tempfile::Builder::new().prefix("karen-home-").tempdir().unwrap().keep();
        let cfg = home.join(".gitconfig");
        std::fs::write(
            &cfg,
            "[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
        )
        .unwrap();
        // the terminal tests run a login shell in this HOME; without startup files zsh (Linux) runs its new-user wizard
        std::fs::write(home.join(".zshrc"), "").unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &cfg);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::set_var("HOME", &home);
    });
}

/// A canonicalized temp directory; the TempDir guard must be kept alive for the duration of the test.
fn temp_dir(prefix: &str) -> (TempDir, String) {
    let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let path = std::fs::canonicalize(dir.path()).unwrap().to_string_lossy().into_owned();
    (dir, path)
}

/// Isolated environment, a fresh service and an initialised repository (TS beforeAll/beforeEach).
async fn setup() -> (GitService, TempDir, String) {
    isolate_git_env();
    let svc = GitService::new(Arc::new(NoHooks));
    let (dir, repo) = temp_dir("karen-repo-");
    svc.init(&repo, Some("main".into())).await.unwrap();
    (svc, dir, repo)
}

fn join(repo: &str, path: &str) -> PathBuf {
    Path::new(repo).join(path)
}

fn write_file(repo: &str, path: &str, content: &str) {
    let full = join(repo, path);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(full, content).unwrap();
}

fn read_file(repo: &str, path: &str) -> String {
    std::fs::read_to_string(join(repo, path)).unwrap()
}

fn exists(repo: &str, path: &str) -> bool {
    join(repo, path).exists()
}

async fn sh(repo: &str, args: &[&str]) -> String {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    git(Path::new(repo), &args, Opts::default()).await.unwrap().stdout.trim().to_string()
}

/// Create a file, stage everything and commit. Returns the new HEAD sha.
async fn commit_file(repo: &str, path: &str, content: &str, message: &str) -> String {
    write_file(repo, path, content);
    sh(repo, &["add", "-A"]).await;
    sh(repo, &["commit", "-q", "-m", message]).await;
    sh(repo, &["rev-parse", "HEAD"]).await
}

/// Build a patch containing only the given hunk (what the renderer does for hunk staging).
fn hunk_patch(diff: &FileDiff, index: usize) -> String {
    let h = &diff.hunks[index];
    let body = h.lines.iter().map(|l| {
        let prefix = match l.kind {
            "add" => "+",
            "del" => "-",
            "meta" => "",
            _ => " ",
        };
        format!("{prefix}{}", l.content)
    });
    let all: Vec<String> = diff.header_lines.iter().cloned().chain([h.header.clone()]).chain(body).collect();
    all.join("\n") + "\n"
}

fn working(path: &str, staged: bool) -> DiffTarget {
    DiffTarget::Working { path: path.into(), staged }
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn summaries(log: &[Commit]) -> Vec<String> {
    log.iter().map(|c| c.summary.clone()).collect()
}

fn all_false() -> LogOptions {
    LogOptions { all: Some(false), ..Default::default() }
}

// ------------------------------------------------------------ repository basics

#[tokio::test]
async fn opens_commits_logs_and_lists_refs() {
    let (svc, _d, repo) = setup().await;
    let info = svc.open(&repo).await.unwrap();
    assert_eq!(info.path, repo);
    assert!(!info.is_bare);
    assert_eq!(svc.log(&repo, LogOptions::default()).await.unwrap(), vec![]);

    write_file(&repo, "a.txt", "hello\n");
    let st = svc.status(&repo).await.unwrap();
    assert_eq!(st.head_sha, None);
    assert_eq!(st.unstaged, vec![FileChange::new("a.txt", "untracked")]);

    svc.stage_all(&repo).await.unwrap();
    let sha = svc.commit(&repo, "first commit\n\nwith body", CommitOptions::default()).await.unwrap();
    let log = svc.log(&repo, LogOptions::default()).await.unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].sha, sha);
    assert_eq!(log[0].summary, "first commit");
    assert_eq!(log[0].body, "with body");
    assert!(log[0].parents.is_empty());
    assert!(log[0].refs.contains(&"refs/heads/main".to_string()));
    assert_eq!(log[0].author.name, "Test User");

    let refs = svc.refs(&repo).await.unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].full_name, "refs/heads/main");
    assert_eq!(refs[0].name, "main");
    assert_eq!(refs[0].kind, "local");
    assert_eq!(refs[0].sha, sha);
    assert_eq!(refs[0].is_head, Some(true));

    let st = svc.status(&repo).await.unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!(st.head_sha.as_deref(), Some(sha.as_str()));
    assert!(st.staged.is_empty());
    assert!(st.unstaged.is_empty());
    assert_eq!(st.operation, None);
    assert_eq!(svc.head_message(&repo).await.unwrap(), "first commit\n\nwith body");

    let detail = svc.commit_detail(&repo, &sha).await.unwrap();
    assert_eq!(
        detail.files,
        vec![FileChange {
            path: "a.txt".into(),
            status: "added",
            additions: Some(1),
            deletions: Some(0),
            binary: Some(false),
            ..Default::default()
        }]
    );

    let (_other, not_repo) = temp_dir("karen-repo-");
    let err = svc.open(&not_repo).await.unwrap_err();
    assert!(err.contains("Not a git repository"), "{err}");
}

#[tokio::test]
async fn amends_and_searches_commits() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "a.txt", "1\n", "add feature alpha").await;
    commit_file(&repo, "b.txt", "1\n", "other").await;
    write_file(&repo, "c.txt", "c\n");
    svc.stage(&repo, strs(&["c.txt"])).await.unwrap();
    svc.commit(&repo, "other amended", CommitOptions { amend: Some(true), ..Default::default() }).await.unwrap();
    let log = svc.log(&repo, LogOptions::default()).await.unwrap();
    assert_eq!(summaries(&log), ["other amended", "add feature alpha"]);
    assert_eq!(summaries(&svc.search_commits(&repo, "ALPHA", None).await.unwrap()), ["add feature alpha"]);
    let by_sha = svc.search_commits(&repo, &log[1].sha[..8], None).await.unwrap();
    assert_eq!(by_sha.iter().map(|c| c.sha.clone()).collect::<Vec<_>>(), [log[1].sha.clone()]);
    assert_eq!(svc.search_commits(&repo, "test user", None).await.unwrap().len(), 2);
}

// ----------------------------------------------------------------- commit stats

#[tokio::test]
async fn commit_stats_count_lines_and_files_diffing_merges_against_first_parent() {
    let (svc, _d, repo) = setup().await;
    let root = commit_file(&repo, "a.txt", "one\ntwo\n", "root").await;
    write_file(&repo, "b.txt", "x\n");
    write_file(&repo, "a.txt", "one\n");
    svc.stage_all(&repo).await.unwrap();
    let second = svc.commit(&repo, "second", CommitOptions::default()).await.unwrap();
    svc.create_branch(&repo, "topic", None, true).await.unwrap();
    commit_file(&repo, "c.txt", "c1\nc2\nc3\n", "topic work").await;
    svc.checkout(&repo, "main").await.unwrap();
    svc.merge(&repo, "topic", MergeOptions { no_ff: Some(true), ..Default::default() }).await.unwrap();
    let merge = svc.log(&repo, LogOptions::default()).await.unwrap()[0].sha.clone();

    let stats = svc
        .commit_stats(&repo, vec![root.clone(), second.clone(), merge.clone(), "not-a-sha".into()])
        .await
        .unwrap();
    assert_eq!(stats[&root], CommitStats { additions: 2, deletions: 0, files: 1 });
    assert_eq!(stats[&second], CommitStats { additions: 1, deletions: 1, files: 2 });
    assert_eq!(stats[&merge], CommitStats { additions: 3, deletions: 0, files: 1 });
    assert_eq!(stats.len(), 3);
}

// ---------------------------------------------------------------------- staging

#[tokio::test]
async fn stages_unstages_discards_and_applies_partial_patches() {
    let (svc, _d, repo) = setup().await;
    let lines: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
    commit_file(&repo, "f.txt", &(lines.join("\n") + "\n"), "base").await;
    let mut changed = lines.clone();
    changed[1] = "CHANGED 2".into();
    changed[27] = "CHANGED 28".into();
    write_file(&repo, "f.txt", &(changed.join("\n") + "\n"));
    write_file(&repo, "new.txt", "new\n");

    let diff = svc.diff(&repo, working("f.txt", false), DiffOptions::default()).await.unwrap().unwrap();
    assert_eq!(diff.hunks.len(), 2);
    // full context gives one hunk with every line; -w hides whitespace-only edits
    let full = DiffOptions { context: Some(100_000), ..Default::default() };
    let whole = svc.diff(&repo, working("f.txt", false), full).await.unwrap().unwrap();
    assert_eq!(whole.hunks.len(), 1);
    assert_eq!(whole.hunks[0].lines.iter().filter(|l| l.kind == "context").count(), 28);

    // stage only the second hunk
    svc.apply_patch(&repo, &hunk_patch(&diff, 1), ApplyOptions { cached: true, reverse: false }).await.unwrap();
    let staged = svc.diff(&repo, working("f.txt", true), DiffOptions::default()).await.unwrap().unwrap();
    assert_eq!(staged.hunks.len(), 1);
    assert!(staged.hunks[0].lines.iter().any(|l| l.kind == "add" && l.content == "CHANGED 28"));
    let st = svc.status(&repo).await.unwrap();
    assert_eq!(st.staged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["f.txt"]);
    let mut unstaged: Vec<&str> = st.unstaged.iter().map(|f| f.path.as_str()).collect();
    unstaged.sort();
    assert_eq!(unstaged, ["f.txt", "new.txt"]);

    // unstage that hunk again via reverse apply
    svc.apply_patch(&repo, &hunk_patch(&staged, 0), ApplyOptions { cached: true, reverse: true }).await.unwrap();
    assert!(svc.status(&repo).await.unwrap().staged.is_empty());

    // untracked diff is an all-add diff
    let untracked = svc.diff(&repo, working("new.txt", false), DiffOptions::default()).await.unwrap().unwrap();
    assert_eq!(untracked.is_new, Some(true));
    assert_eq!(
        untracked.hunks[0].lines,
        vec![DiffLine { kind: "add", content: "new".into(), old_line: None, new_line: Some(1) }]
    );

    svc.stage(&repo, strs(&["new.txt"])).await.unwrap();
    let staged = svc.status(&repo).await.unwrap().staged;
    assert_eq!(staged.len(), 1);
    assert_eq!((staged[0].path.as_str(), staged[0].status), ("new.txt", "added"));
    svc.unstage(&repo, strs(&["new.txt"])).await.unwrap();
    assert!(svc.status(&repo).await.unwrap().staged.is_empty());

    svc.discard(&repo, strs(&["f.txt", "new.txt"])).await.unwrap();
    let st = svc.status(&repo).await.unwrap();
    assert!(st.unstaged.is_empty());
    assert!(!exists(&repo, "new.txt"));
}

#[tokio::test]
async fn stages_unstages_and_discards_more_files_than_one_batch() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "base.txt", "base\n", "base").await;
    let paths: Vec<String> = (0..1200).map(|i| format!("many/file-{i:04}.txt")).collect();
    for p in &paths {
        write_file(&repo, p, "x\n");
    }

    svc.stage(&repo, paths.clone()).await.unwrap();
    assert_eq!(svc.status(&repo).await.unwrap().staged.len(), 1200);
    svc.unstage(&repo, paths.clone()).await.unwrap();
    let st = svc.status(&repo).await.unwrap();
    assert!(st.staged.is_empty());
    assert_eq!(st.unstaged.len(), 1200);
    svc.discard(&repo, paths).await.unwrap();
    assert!(svc.status(&repo).await.unwrap().unstaged.is_empty());
}

#[tokio::test]
async fn appends_ignore_patterns_once() {
    let (svc, _d, repo) = setup().await;
    svc.ignore(&repo, "*.log").await.unwrap();
    svc.ignore(&repo, "*.log").await.unwrap();
    svc.ignore(&repo, "dist/").await.unwrap();
    assert_eq!(read_file(&repo, ".gitignore"), "*.log\ndist/\n");
}

// ------------------------------------------------------ branches, merge and conflicts

#[tokio::test]
async fn merges_with_conflict_resolves_and_continues() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f.txt", "base\n", "base").await;
    svc.create_branch(&repo, "feature", None, true).await.unwrap();
    commit_file(&repo, "f.txt", "feature\n", "feature change").await;
    svc.checkout(&repo, "refs/heads/main").await.unwrap();
    commit_file(&repo, "f.txt", "main\n", "main change").await;

    let err = svc.merge(&repo, "feature", MergeOptions::default()).await.unwrap_err();
    assert!(err.to_lowercase().contains("conflict"), "{err}");
    let st = svc.status(&repo).await.unwrap();
    assert_eq!(st.operation, Some("merge"));
    assert_eq!(st.conflicted, vec![FileChange::new("f.txt", "conflicted")]);

    let c = svc.conflict(&repo, "f.txt").await.unwrap();
    assert_eq!(c.base.as_deref(), Some("base\n"));
    assert_eq!(c.ours.as_deref(), Some("main\n"));
    assert_eq!(c.theirs.as_deref(), Some("feature\n"));
    assert!(c.merged.contains("<<<<<<<"));
    assert_eq!(svc.diff(&repo, working("f.txt", false), DiffOptions::default()).await.unwrap(), None);

    svc.resolve_conflict(&repo, "f.txt", "resolved\n").await.unwrap();
    svc.continue_operation(&repo).await.unwrap();
    let after = svc.status(&repo).await.unwrap();
    assert_eq!(after.operation, None);
    let log = svc.log(&repo, LogOptions { limit: Some(1), ..Default::default() }).await.unwrap();
    assert_eq!(log[0].parents.len(), 2);
    assert_eq!(read_file(&repo, "f.txt"), "resolved\n");
}

#[tokio::test]
async fn takes_a_side_and_aborts() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f.txt", "base\n", "base").await;
    svc.create_branch(&repo, "other", None, true).await.unwrap();
    commit_file(&repo, "f.txt", "theirs\n", "theirs").await;
    svc.checkout(&repo, "main").await.unwrap();
    commit_file(&repo, "f.txt", "ours\n", "ours").await;
    assert!(svc.merge(&repo, "other", MergeOptions::default()).await.is_err());
    svc.take_side(&repo, strs(&["f.txt"]), "theirs").await.unwrap();
    assert_eq!(read_file(&repo, "f.txt"), "theirs\n");
    assert!(svc.status(&repo).await.unwrap().conflicted.is_empty());
    svc.abort_operation(&repo).await.unwrap();
    assert_eq!(svc.status(&repo).await.unwrap().operation, None);
    assert_eq!(read_file(&repo, "f.txt"), "ours\n");
}

#[tokio::test]
async fn renames_and_deletes_branches_tags() {
    let (svc, _d, repo) = setup().await;
    let sha = commit_file(&repo, "a", "a\n", "a").await;
    svc.create_branch(&repo, "x", Some(sha.clone()), false).await.unwrap();
    svc.rename_branch(&repo, "x", "y").await.unwrap();
    svc.create_tag(&repo, "v1", &sha, Some("release one".into())).await.unwrap();
    svc.create_tag(&repo, "light", &sha, None).await.unwrap();
    let refs = svc.refs(&repo).await.unwrap();
    let mut names: Vec<&str> = refs.iter().map(|r| r.full_name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["refs/heads/main", "refs/heads/y", "refs/tags/light", "refs/tags/v1"]);
    let v1 = refs.iter().find(|r| r.name == "v1").unwrap();
    assert_eq!((v1.kind, v1.sha.as_str(), v1.message.as_deref()), ("tag", sha.as_str(), Some("release one")));
    assert_eq!(refs.iter().find(|r| r.name == "light").unwrap().message, None);
    svc.delete_branch(&repo, "y", false).await.unwrap();
    svc.delete_tag(&repo, "v1").await.unwrap();
    let refs = svc.refs(&repo).await.unwrap();
    let mut names: Vec<&str> = refs.iter().map(|r| r.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["light", "main"]);
}

#[tokio::test]
async fn works_with_remotes_fetch_checkout_remote_push_pull() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "a", "a\n", "a").await;
    let (_rd, remote) = temp_dir("karen-remote-");
    sh(&remote, &["init", "-q", "--bare"]).await;
    svc.add_remote(&repo, "origin", &remote).await.unwrap();
    svc.push(&repo, PushOptions::default()).await.unwrap();
    let refs = svc.refs(&repo).await.unwrap();
    let main = refs.iter().find(|r| r.name == "main").unwrap();
    assert_eq!(
        (main.upstream.as_deref(), main.ahead, main.behind),
        (Some("refs/remotes/origin/main"), Some(0), Some(0))
    );
    let origin_main = refs.iter().find(|r| r.full_name == "refs/remotes/origin/main").unwrap();
    assert_eq!((origin_main.kind, origin_main.remote.as_deref()), ("remote", Some("origin")));

    let (_cd, clone) = temp_dir("karen-clone-");
    let info = svc.clone_repo(&remote, &join(&clone, "copy").to_string_lossy()).await.unwrap();
    let copy = info.path.as_str();
    commit_file(copy, "b", "b\n", "b from clone").await;
    svc.create_branch(copy, "topic", None, true).await.unwrap();
    commit_file(copy, "c", "c\n", "c").await;
    svc.push(copy, PushOptions::default()).await.unwrap();
    svc.checkout(copy, "main").await.unwrap();
    svc.push(copy, PushOptions::default()).await.unwrap();

    svc.fetch(&repo, None, true).await.unwrap();
    let refs = svc.refs(&repo).await.unwrap();
    assert_eq!(refs.iter().find(|r| r.name == "main").unwrap().behind, Some(1));
    svc.checkout_remote(&repo, "refs/remotes/origin/topic", None).await.unwrap();
    assert_eq!(svc.status(&repo).await.unwrap().branch.as_deref(), Some("topic"));
    svc.checkout(&repo, "main").await.unwrap();
    svc.pull(&repo, "ff-only").await.unwrap();
    assert_eq!(summaries(&svc.log(&repo, all_false()).await.unwrap()), ["b from clone", "a"]);

    assert_eq!(
        svc.remotes(&repo).await.unwrap(),
        vec![Remote { name: "origin".into(), fetch_url: remote.clone(), push_url: remote.clone() }]
    );
}

/// Collects the progress events a service emits.
#[derive(Default)]
struct ProgressLog(std::sync::Mutex<Vec<ProgressEvent>>);

impl super::service::Hooks for ProgressLog {
    fn progress(&self, e: ProgressEvent) {
        self.0.lock().unwrap().push(e);
    }
}

#[tokio::test]
async fn streams_clone_fetch_and_push_progress_with_percentages() {
    let (plain, _d, repo) = setup().await;
    for i in 0..20 {
        commit_file(&repo, &format!("f{i}"), &format!("{i}\n"), &format!("c{i}")).await;
    }
    let (_rd, remote) = temp_dir("karen-remote-");
    sh(&remote, &["init", "-q", "--bare"]).await;
    plain.add_remote(&repo, "origin", &remote).await.unwrap();

    let log = Arc::new(ProgressLog::default());
    let svc = GitService::new(log.clone());
    svc.push(&repo, PushOptions::default()).await.unwrap();
    // file:// goes through the pack protocol (a plain local path would just hard-link the objects)
    let (_cd, clone) = temp_dir("karen-clone-");
    let dest = join(&clone, "copy").to_string_lossy().into_owned();
    let copy = svc.clone_repo(&format!("file://{remote}"), &dest).await.unwrap().path;
    commit_file(&repo, "g", "g\n", "g").await;
    plain.push(&repo, PushOptions::default()).await.unwrap();
    svc.fetch(&copy, None, false).await.unwrap();

    let events = log.0.lock().unwrap();
    let has = |op: &str, phase: &str| events.iter().any(|e| e.op == op && e.message.contains(phase) && e.message.contains('%'));
    assert!(has("push", "Writing objects"), "{:?}", events.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert!(has("clone", "Receiving objects"));
    assert!(events.iter().any(|e| e.op == "clone" && e.repo == dest));
    // a small fetch unpacks loose objects without a counter; the remote's counting phase still reports one
    assert!(has("fetch", "remote: Counting objects"));
}

// ---------------------------------------------------------------------- stashes

#[tokio::test]
async fn stashes_save_apply_pop_and_drop() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f", "base\n", "base").await;
    write_file(&repo, "f", "one\n");
    svc.stash_save(&repo, Some("first".into()), true).await.unwrap();
    write_file(&repo, "g", "untracked\n");
    svc.stash_save(&repo, Some("second".into()), true).await.unwrap();
    let stashes = svc.stashes(&repo).await.unwrap();
    assert_eq!(
        stashes.iter().map(|s| (s.index, s.message.as_str())).collect::<Vec<_>>(),
        [(0, "On main: second"), (1, "On main: first")]
    );
    assert_eq!(stashes[0].reference, "stash@{0}");
    assert_eq!(svc.log(&repo, LogOptions::default()).await.unwrap().len(), 1); // stashes are not in the log
    svc.stash_apply(&repo, 1, false).await.unwrap();
    assert_eq!(read_file(&repo, "f"), "one\n");
    svc.discard(&repo, strs(&["f"])).await.unwrap();
    svc.stash_apply(&repo, 0, true).await.unwrap();
    assert_eq!(read_file(&repo, "g"), "untracked\n");
    assert_eq!(svc.stashes(&repo).await.unwrap().len(), 1);
    svc.stash_drop(&repo, 0).await.unwrap();
    assert!(svc.stashes(&repo).await.unwrap().is_empty());
    svc.discard(&repo, strs(&["g"])).await.unwrap();
    let err = svc.stash_save(&repo, None, true).await.unwrap_err();
    assert!(err.contains("No local changes"), "{err}");
}

// --------------------------------------------------------- history manipulation

fn todo(action: &str, sha: &str, message: Option<&str>) -> RebaseTodoItem {
    RebaseTodoItem { action: action.into(), sha: sha.into(), message: message.map(String::from) }
}

#[tokio::test]
async fn runs_interactive_rebase_with_drop_reword_and_squash() {
    let (svc, _d, repo) = setup().await;
    let base = commit_file(&repo, "base", "0\n", "base").await;
    let a = commit_file(&repo, "a", "a\n", "A").await;
    let b = commit_file(&repo, "b", "b\n", "B").await;
    let c = commit_file(&repo, "c", "c\n", "C").await;
    let d = commit_file(&repo, "d", "d\n", "D").await;
    svc.interactive_rebase(
        &repo,
        &base,
        vec![
            todo("reword", &a, Some("A reworded")),
            todo("drop", &b, None),
            todo("pick", &c, None),
            todo("squash", &d, Some("C and D")),
        ],
    )
    .await
    .unwrap();
    let log = svc.log(&repo, LogOptions::default()).await.unwrap();
    assert_eq!(summaries(&log), ["C and D", "A reworded", "base"]);
    assert!(!exists(&repo, "b"));
    assert!(exists(&repo, "d"));
    assert_eq!(svc.status(&repo).await.unwrap().operation, None);
}

#[tokio::test]
async fn stops_interactive_rebase_on_conflict_and_can_abort() {
    let (svc, _d, repo) = setup().await;
    let base = commit_file(&repo, "f", "0\n", "base").await;
    let a = commit_file(&repo, "f", "1\n", "A").await;
    let b = commit_file(&repo, "f", "2\n", "B").await;
    let err = svc.interactive_rebase(&repo, &base, vec![todo("pick", &b, None), todo("pick", &a, None)]).await.unwrap_err();
    assert!(err.contains("Rebase stopped"), "{err}");
    assert_eq!(svc.status(&repo).await.unwrap().operation, Some("rebase"));
    svc.abort_operation(&repo).await.unwrap();
    assert_eq!(svc.status(&repo).await.unwrap().operation, None);
}

#[tokio::test]
async fn cherry_picks_reverts_and_resets() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f", "base\n", "base").await;
    svc.create_branch(&repo, "side", None, true).await.unwrap();
    let pick = commit_file(&repo, "side.txt", "side\n", "side work").await;
    svc.checkout(&repo, "main").await.unwrap();
    svc.cherry_pick(&repo, vec![pick]).await.unwrap();
    assert_eq!(read_file(&repo, "side.txt"), "side\n");
    let head = svc.log(&repo, all_false()).await.unwrap().remove(0);
    svc.revert(&repo, &head.sha).await.unwrap();
    assert!(!exists(&repo, "side.txt"));
    svc.reset(&repo, &head.sha, "hard").await.unwrap();
    assert!(exists(&repo, "side.txt"));
    svc.reset(&repo, "HEAD~1", "soft").await.unwrap();
    let staged = svc.status(&repo).await.unwrap().staged;
    assert_eq!(staged.len(), 1);
    assert_eq!((staged[0].path.as_str(), staged[0].status), ("side.txt", "added"));
}

#[tokio::test]
async fn returns_file_history_and_blame() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f", "one\n", "first").await;
    commit_file(&repo, "f", "one\ntwo\n", "second").await;
    let hist: Vec<Commit> = svc.file_history(&repo, "f", None).await.unwrap().into_iter().map(|h| h.commit).collect();
    assert_eq!(summaries(&hist), ["second", "first"]);
    let blame = svc.blame(&repo, "f", None).await.unwrap();
    assert_eq!(
        blame.iter().map(|l| (l.line, l.content.as_str(), l.summary.as_str())).collect::<Vec<_>>(),
        [(1, "one", "first"), (2, "two", "second")]
    );
    assert_eq!(svc.file_content(&repo, Some(hist[1].sha.clone()), "f").await.unwrap(), "one\n");
    let cd = svc
        .diff(&repo, DiffTarget::Commit { sha: hist[0].sha.clone(), path: "f".into(), old_path: None }, DiffOptions::default())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        cd.hunks[0].lines.iter().filter(|l| l.kind == "add").map(|l| l.content.as_str()).collect::<Vec<_>>(),
        ["two"]
    );
    // root commit (diffed with `git show`) honours the options too
    let opts = DiffOptions { context: Some(0), ignore_whitespace: Some(true) };
    let root = svc.diff(&repo, DiffTarget::Commit { sha: hist[1].sha.clone(), path: "f".into(), old_path: None }, opts).await.unwrap().unwrap();
    assert_eq!(root.hunks[0].lines.len(), 1);
}

#[tokio::test]
async fn history_blame_and_diff_follow_renames() {
    let (svc, _d, repo) = setup().await;
    let first = commit_file(&repo, "a.txt", "one\ntwo\nthree\nfour\nfive\n", "first").await;
    commit_file(&repo, "a.txt", "one\nTWO\nthree\nfour\nfive\n", "second").await;
    sh(&repo, &["mv", "a.txt", "b c.txt"]).await;
    let renamed = commit_file(&repo, "b c.txt", "one\nTWO\nthree\nfour\nfive\n", "rename").await;
    commit_file(&repo, "b c.txt", "one\nTWO\nthree\nFOUR\nfive\n", "fourth").await;

    let hist = svc.file_history(&repo, "b c.txt", None).await.unwrap();
    let got: Vec<_> = hist.iter().map(|h| (h.commit.summary.as_str(), h.path.as_str(), h.old_path.as_deref())).collect();
    assert_eq!(
        got,
        [("fourth", "b c.txt", None), ("rename", "b c.txt", Some("a.txt")), ("second", "a.txt", None), ("first", "a.txt", None)]
    );
    assert_eq!(serde_json::to_value(&hist[1]).unwrap()["oldPath"], "a.txt");
    assert_eq!(serde_json::to_value(&hist[1]).unwrap()["summary"], "rename");

    // with the old path the rename commit diffs as a rename, not as an added file
    let target = DiffTarget::Commit { sha: renamed.clone(), path: "b c.txt".into(), old_path: Some("a.txt".into()) };
    let d = svc.diff(&repo, target, DiffOptions::default()).await.unwrap().unwrap();
    assert_eq!((d.path.as_str(), d.old_path.as_deref(), d.is_new), ("b c.txt", Some("a.txt"), None));
    // an older commit is diffed under its own path
    let target = DiffTarget::Commit { sha: hist[2].commit.sha.clone(), path: "a.txt".into(), old_path: None };
    assert_eq!(svc.diff(&repo, target, DiffOptions::default()).await.unwrap().unwrap().hunks.len(), 1);

    let blame = svc.blame(&repo, "b c.txt", None).await.unwrap();
    let got: Vec<_> = blame.iter().map(|l| (l.summary.as_str(), l.path.as_str())).collect();
    assert_eq!(got, [("first", "a.txt"), ("second", "a.txt"), ("first", "a.txt"), ("fourth", "b c.txt"), ("first", "a.txt")]);
    // stepping back from "fourth" blames the parent under its path there
    let prev = blame[3].previous.clone().unwrap();
    assert_eq!((prev.sha.as_str(), prev.path.as_str()), (renamed.as_str(), "b c.txt"));
    let back = svc.blame(&repo, &prev.path, Some(prev.sha.clone())).await.unwrap();
    assert_eq!(back[3].content, "four");
    let prev = blame[1].previous.clone().unwrap();
    assert_eq!((prev.sha.as_str(), prev.path.as_str()), (first.as_str(), "a.txt"));
    assert!(blame[0].previous.is_none());
}

#[tokio::test]
async fn reads_image_blobs_from_revisions_the_index_and_the_working_copy() {
    let (svc, _d, repo) = setup().await;
    let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff];
    std::fs::write(join(&repo, "img.png"), png).unwrap();
    sh(&repo, &["add", "-A"]).await;
    sh(&repo, &["commit", "-q", "-m", "image"]).await;
    std::fs::write(join(&repo, "img.png"), [png, &[1, 2]].concat()).unwrap();

    let head = svc.image_blob(&repo, Some("HEAD".into()), "img.png").await.unwrap().unwrap();
    assert_eq!((head.size, head.base64.as_str()), (10, "iVBORw0KGgoA/w=="));
    assert_eq!(svc.image_blob(&repo, Some(String::new()), "img.png").await.unwrap().unwrap().size, 10);
    assert_eq!(svc.image_blob(&repo, None, "img.png").await.unwrap().unwrap().size, 12);
    assert_eq!(svc.image_blob(&repo, Some("HEAD".into()), "missing.png").await.unwrap(), None);
    assert_eq!(svc.image_blob(&repo, None, "missing.png").await.unwrap(), None);
}

// -------------------------------------------------------------------- worktrees

#[tokio::test]
async fn adds_locks_and_removes_worktrees() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f", "x\n", "base").await;
    let (_wd, wt_root) = temp_dir("karen-wt-");
    let wt_path = join(&wt_root, "wt").to_string_lossy().into_owned();
    svc.worktree_add(&repo, &wt_path, "main", Some("wt-branch".into()), false).await.unwrap();
    let wts = svc.worktrees(&repo).await.unwrap();
    assert_eq!(wts.len(), 2);
    assert_eq!(
        (wts[1].path.as_str(), wts[1].branch.as_deref(), wts[1].is_main),
        (wt_path.as_str(), Some("wt-branch"), false)
    );
    assert_eq!(wts[1].changes, Some(WorktreeChanges::default()));
    std::fs::write(join(&wt_path, "f"), "changed\n").unwrap();
    std::fs::write(join(&wt_path, "new"), "n\n").unwrap();
    let wts = svc.worktrees(&repo).await.unwrap();
    assert_eq!(wts[0].changes, None, "the queried worktree has no summary");
    assert_eq!(wts[1].changes, Some(WorktreeChanges { modified: 1, added: 1, ..Default::default() }));
    svc.worktree_lock(&repo, &wt_path, true, Some("on a USB disk".into())).await.unwrap();
    let wts = svc.worktrees(&repo).await.unwrap();
    assert!(wts[1].locked);
    assert_eq!(wts[1].lock_reason.as_deref(), Some("on a USB disk"));
    svc.worktree_lock(&repo, &wt_path, false, None).await.unwrap();
    svc.worktree_remove(&repo, &wt_path, true).await.unwrap();
    assert_eq!(svc.worktrees(&repo).await.unwrap().len(), 1);
    // created locked
    svc.worktree_add(&repo, &wt_path, "main", Some("wt-2".into()), true).await.unwrap();
    assert!(svc.worktrees(&repo).await.unwrap()[1].locked);
    svc.worktree_lock(&repo, &wt_path, false, None).await.unwrap();
    svc.worktree_remove(&repo, &wt_path, false).await.unwrap();
    assert_eq!(svc.worktrees(&repo).await.unwrap().len(), 1);
}

// ---------------------------------------------------------------------- gitflow

#[tokio::test]
async fn gitflow_initialises_starts_and_finishes_features_and_releases() {
    let (svc, _d, repo) = setup().await;
    assert_eq!(svc.gitflow_config(&repo).await.unwrap(), None);
    let cfg = GitflowConfig {
        master: "main".into(),
        develop: "develop".into(),
        feature: "feature/".into(),
        release: "release/".into(),
        hotfix: "hotfix/".into(),
        version_tag: "v".into(),
    };
    svc.gitflow_init(&repo, cfg.clone()).await.unwrap();
    assert_eq!(svc.gitflow_config(&repo).await.unwrap(), Some(cfg));
    assert_eq!(svc.status(&repo).await.unwrap().branch.as_deref(), Some("develop"));

    svc.gitflow_start(&repo, "feature", "login").await.unwrap();
    assert_eq!(svc.status(&repo).await.unwrap().branch.as_deref(), Some("feature/login"));
    commit_file(&repo, "login.txt", "x\n", "login").await;
    svc.gitflow_finish(&repo, "feature", "login", GitflowFinishOptions::default()).await.unwrap();
    let refs = svc.refs(&repo).await.unwrap();
    assert!(!refs.iter().any(|r| r.name == "feature/login"));
    assert_eq!(svc.status(&repo).await.unwrap().branch.as_deref(), Some("develop"));
    assert!(exists(&repo, "login.txt"));

    svc.gitflow_start(&repo, "release", "1.0.0").await.unwrap();
    commit_file(&repo, "version", "1.0.0\n", "bump").await;
    let opts = GitflowFinishOptions { tag_message: Some("Release 1.0.0".into()), ..Default::default() };
    svc.gitflow_finish(&repo, "release", "1.0.0", opts).await.unwrap();
    let refs = svc.refs(&repo).await.unwrap();
    let tag = refs.iter().find(|r| r.name == "v1.0.0").unwrap();
    assert_eq!((tag.kind, tag.message.as_deref()), ("tag", Some("Release 1.0.0")));
    let main = refs.iter().find(|r| r.name == "main").unwrap();
    let develop = refs.iter().find(|r| r.name == "develop").unwrap();
    assert_eq!(sh(&repo, &["merge-base", "--is-ancestor", &main.sha, &develop.sha]).await, "");
}

// ----------------------------------------------------------------------- config

#[tokio::test]
async fn reads_and_writes_local_config() {
    let (svc, _d, repo) = setup().await;
    assert_eq!(svc.get_config(Some(&repo), "karen.test").await.unwrap(), None);
    svc.set_config(Some(&repo), "karen.test", "yes", false).await.unwrap();
    assert_eq!(svc.get_config(Some(&repo), "karen.test").await.unwrap().as_deref(), Some("yes"));
    assert_eq!(svc.get_config(None, "user.name").await.unwrap().as_deref(), Some("Test User"));
}

// ---------------------------------------------------------------- smart commit

#[tokio::test]
async fn smart_commit_probes_pending_work_and_compares_branches() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "a.txt", "a\n", "base").await;
    let (_rd, remote) = temp_dir("karen-remote-");
    sh(&remote, &["init", "-q", "--bare"]).await;
    svc.add_remote(&repo, "origin", &remote).await.unwrap();
    svc.push(&repo, PushOptions::default()).await.unwrap();

    svc.create_branch(&repo, "feature", None, true).await.unwrap();
    let s = svc.smart_status(&repo).await.unwrap();
    assert_eq!((s.branch.as_deref(), s.remote.as_deref()), (Some("feature"), Some("origin")));
    // a branch the remote doesn't have yet needs a push
    assert!(s.has_commits && s.unpushed && !s.unstaged && !s.staged && !s.untracked);

    write_file(&repo, "a.txt", "a\nchanged\n");
    write_file(&repo, "new.txt", "new\n");
    let s = svc.smart_status(&repo).await.unwrap();
    assert!(s.unstaged && s.untracked && !s.staged);
    let all = svc.pending_diff(&repo, true).await.unwrap();
    assert!(all.diff.contains("+changed"));
    assert_eq!(all.untracked, ["new.txt"]);
    // without staging, only the index counts
    let index = svc.pending_diff(&repo, false).await.unwrap();
    assert_eq!((index.diff.as_str(), index.untracked.len()), ("", 0));
    svc.stage(&repo, strs(&["a.txt"])).await.unwrap();
    assert!(svc.pending_diff(&repo, false).await.unwrap().diff.contains("+changed"));

    sh(&repo, &["commit", "-q", "-m", "feat: change a"]).await;
    svc.push(&repo, PushOptions::default()).await.unwrap();
    assert!(!svc.smart_status(&repo).await.unwrap().unpushed);

    let cmp = svc.compare_branch(&repo, "feature", "main", "origin").await.unwrap();
    assert!(cmp.target_exists);
    assert_eq!(cmp.commits, ["feat: change a"]);
    assert!(cmp.diff.contains("+changed") && cmp.stat.contains("a.txt"));
    assert!(!svc.compare_branch(&repo, "feature", "nope", "origin").await.unwrap().target_exists);

    assert_eq!(svc.pr_template(&repo).await.unwrap(), None);
    write_file(&repo, ".github/PULL_REQUEST_TEMPLATE.md", "## What\n\n");
    let t = svc.pr_template(&repo).await.unwrap().unwrap();
    assert_eq!((t.path.as_str(), t.content.as_str()), (".github/PULL_REQUEST_TEMPLATE.md", "## What"));

    // guards run before gh is ever asked to open anything
    let r = svc.create_pull_request(&repo, "origin", "feature", "nope", "t", "b").await.unwrap();
    assert_eq!(r.status, "skipped");
    let r = svc.create_pull_request(&repo, "origin", "main", "feature", "t", "b").await.unwrap();
    assert_eq!(r.status, "skipped");
}

#[tokio::test]
async fn commit_patches_carry_message_and_diff() {
    let (svc, _d, repo) = setup().await;
    let a = commit_file(&repo, "a.txt", "a\n", "first").await;
    let b = commit_file(&repo, "a.txt", "a\nb\n", "second\n\nwith a body").await;
    let patches = svc.commit_patches(&repo, &[a.clone(), b.clone()]).await.unwrap();
    assert_eq!(patches.iter().map(|p| p.sha.as_str()).collect::<Vec<_>>(), [a.as_str(), b.as_str()]);
    assert_eq!((patches[1].author.as_str(), patches[1].message.as_str()), ("Test User", "second\n\nwith a body"));
    // the root commit diffs against the empty tree
    assert!(patches[0].diff.contains("+a") && patches[1].diff.contains("+b") && !patches[1].diff.contains("+a"));
    assert!(svc.commit_patches(&repo, &["--all".into()]).await.is_err());
}

// ------------------------------------------------------------------ undo & recovery

#[tokio::test]
async fn reflog_lists_head_moves_and_branches_can_be_restored() {
    let (svc, _d, repo) = setup().await;
    let a = commit_file(&repo, "f", "a\n", "a").await;
    let b = commit_file(&repo, "f", "b\n", "b").await;
    svc.create_branch(&repo, "side", Some(a.clone()), false).await.unwrap();
    svc.reset(&repo, &a, "hard").await.unwrap();
    let log = svc.reflog(&repo, None).await.unwrap();
    assert_eq!(
        log.iter().map(|e| (e.selector.as_str(), e.action.as_str(), e.sha.as_str())).collect::<Vec<_>>(),
        [("HEAD@{0}", "reset", a.as_str()), ("HEAD@{1}", "commit", b.as_str()), ("HEAD@{2}", "commit (initial)", a.as_str())]
    );
    assert_eq!(log[1].message, "b");
    assert!(log[0].date > 0);
    assert_eq!(svc.resolve_ref(&repo, "HEAD").await.unwrap(), Some(a.clone()));
    assert_eq!(svc.resolve_ref(&repo, "nope").await.unwrap(), None);
    assert!(svc.resolve_ref(&repo, "--all").await.is_err());

    // the checked-out branch is reset (--keep), any other branch is moved without touching the work tree
    svc.restore_branch(&repo, Some("main".into()), &b).await.unwrap();
    assert_eq!((svc.resolve_ref(&repo, "HEAD").await.unwrap(), read_file(&repo, "f")), (Some(b.clone()), "b\n".into()));
    svc.restore_branch(&repo, Some("side".into()), &b).await.unwrap();
    assert_eq!(svc.resolve_ref(&repo, "side").await.unwrap(), Some(b.clone()));
    // --keep refuses to overwrite uncommitted changes
    write_file(&repo, "f", "dirty\n");
    assert!(svc.restore_branch(&repo, None, &a).await.is_err());
    assert_eq!(read_file(&repo, "f"), "dirty\n");
}

#[tokio::test]
async fn previews_discards_and_branch_deletions() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f", "1\n2\n3\n", "base").await;
    write_file(&repo, "f", "1\nchanged\n3\nnew\n");
    write_file(&repo, "u.txt", "x\ny");
    write_file(&repo, "bin", "a\0b");
    let impact = svc.discard_impact(&repo, strs(&["f", "u.txt", "bin"])).await.unwrap();
    assert_eq!(impact, DiscardImpact { files: 3, additions: 4, deletions: 1, untracked: 2, binary: 1 });

    let main = sh(&repo, &["rev-parse", "HEAD"]).await;
    svc.create_branch(&repo, "topic", None, true).await.unwrap();
    commit_file(&repo, "t", "t\n", "t1").await;
    commit_file(&repo, "t", "t2\n", "t2").await;
    svc.create_branch(&repo, "keep", Some("HEAD~1".into()), false).await.unwrap();
    svc.checkout(&repo, "main").await.unwrap();
    assert_eq!(svc.branch_impact(&repo, "topic").await.unwrap(), BranchImpact { unmerged: 2, orphaned: 1 });
    assert_eq!(svc.branch_impact(&repo, "keep").await.unwrap(), BranchImpact { unmerged: 1, orphaned: 0 });
    assert_eq!(svc.count_commits(&repo, "topic", strs(&[&main])).await.unwrap(), 2);
    assert!(svc.branch_impact(&repo, "nope").await.is_err());
}

#[tokio::test]
async fn backs_up_and_restores_discarded_files() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f", "base\n", "base").await;
    commit_file(&repo, "gone", "tracked\n", "gone").await;
    write_file(&repo, "f", "edited\n");
    write_file(&repo, "dir/new.sh", "#!/bin/sh\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(join(&repo, "dir/new.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::remove_file(join(&repo, "gone")).unwrap();
    let paths = strs(&["f", "dir/new.sh", "gone"]);
    let backups = svc.backup_files(&repo, paths.clone()).await.unwrap();
    assert_eq!(backups.len(), 3);
    svc.discard(&repo, paths).await.unwrap();
    assert_eq!((read_file(&repo, "f").as_str(), exists(&repo, "dir/new.sh"), exists(&repo, "gone")), ("base\n", false, true));

    svc.restore_files(&repo, backups).await.unwrap();
    assert_eq!(read_file(&repo, "f"), "edited\n");
    assert_eq!(read_file(&repo, "dir/new.sh"), "#!/bin/sh\n");
    assert!(!exists(&repo, "gone"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(std::fs::metadata(join(&repo, "dir/new.sh")).unwrap().permissions().mode() & 0o111, 0);
    }
    // the real index is untouched
    assert!(svc.status(&repo).await.unwrap().staged.is_empty());
}

#[tokio::test]
async fn snapshots_survive_a_hard_reset() {
    let (svc, _d, repo) = setup().await;
    let a = commit_file(&repo, "f", "a\n", "a").await;
    let b = commit_file(&repo, "f", "b\n", "b").await;
    assert_eq!(svc.snapshot(&repo).await.unwrap(), None);
    write_file(&repo, "f", "dirty\n");
    write_file(&repo, "g", "staged\n");
    svc.stage(&repo, strs(&["g"])).await.unwrap();
    let snap = svc.snapshot(&repo).await.unwrap().unwrap();
    assert_eq!(read_file(&repo, "f"), "dirty\n"); // nothing changes in the work tree
    svc.reset(&repo, &a, "hard").await.unwrap();
    // undo: back to the old commit, then the old uncommitted changes
    svc.reset(&repo, &b, "hard").await.unwrap();
    svc.apply_snapshot(&repo, &snap).await.unwrap();
    assert_eq!((read_file(&repo, "f"), read_file(&repo, "g")), ("dirty\n".into(), "staged\n".into()));
    let st = svc.status(&repo).await.unwrap();
    assert_eq!(st.staged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["g"]);
}

#[tokio::test]
async fn restores_dropped_and_popped_stashes() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "f", "base\n", "base").await;
    write_file(&repo, "f", "stashed\n");
    write_file(&repo, "u", "untracked\n");
    svc.stash_save(&repo, Some("work".into()), true).await.unwrap();
    let stash = svc.stashes(&repo).await.unwrap().remove(0);

    svc.stash_drop(&repo, 0).await.unwrap();
    svc.stash_store(&repo, &stash.sha, &stash.message).await.unwrap();
    let back = svc.stashes(&repo).await.unwrap();
    assert_eq!((back.len(), back[0].sha.as_str(), back[0].message.as_str()), (1, stash.sha.as_str(), stash.message.as_str()));

    // pop on top of an unrelated uncommitted change, then undo it
    write_file(&repo, "other", "mine\n");
    svc.stage(&repo, strs(&["other"])).await.unwrap();
    let before = svc.snapshot(&repo).await.unwrap();
    svc.stash_apply(&repo, 0, true).await.unwrap();
    assert_eq!((read_file(&repo, "f").as_str(), exists(&repo, "u")), ("stashed\n", true));
    svc.undo_stash_pop(&repo, &stash.sha, &stash.message, before).await.unwrap();
    assert_eq!((read_file(&repo, "f").as_str(), exists(&repo, "u")), ("base\n", false));
    assert_eq!(read_file(&repo, "other"), "mine\n");
    assert_eq!(svc.stashes(&repo).await.unwrap()[0].sha, stash.sha);
}

#[tokio::test]
async fn pushes_an_old_commit_back_over_a_force_push() {
    let (svc, _d, repo) = setup().await;
    let a = commit_file(&repo, "a", "a\n", "a").await;
    let b = commit_file(&repo, "a", "b\n", "b").await;
    let (_rd, remote) = temp_dir("karen-remote-");
    sh(&remote, &["init", "-q", "--bare"]).await;
    svc.add_remote(&repo, "origin", &remote).await.unwrap();
    svc.push(&repo, PushOptions::default()).await.unwrap();
    svc.reset(&repo, &a, "hard").await.unwrap();
    svc.push(&repo, PushOptions { force: Some(true), ..Default::default() }).await.unwrap();
    assert_eq!(sh(&remote, &["rev-parse", "main"]).await, a);

    // the lease protects against a remote that moved since
    assert!(svc.push_sha(&repo, "origin", &b, "main", Some(b.clone())).await.is_err());
    svc.push_sha(&repo, "origin", &b, "main", Some(a.clone())).await.unwrap();
    assert_eq!(sh(&remote, &["rev-parse", "main"]).await, b);
    // without a lease it only (re)creates or fast-forwards
    svc.push_sha(&repo, "origin", &b, "gone", None).await.unwrap();
    assert_eq!(sh(&remote, &["rev-parse", "gone"]).await, b);
    assert!(svc.push_sha(&repo, "origin", &a, "gone", None).await.is_err());
}

// ---------------------------------------------------------------------- compare and ref details

#[tokio::test]
async fn refs_carry_tip_commit_details_and_the_remote_default_branch() {
    let (svc, _d, repo) = setup().await;
    commit_file(&repo, "a", "a\n", "first").await;
    sh(&repo, &["tag", "-a", "v1", "-m", "release one"]).await;
    sh(&repo, &["tag", "light"]).await;
    let (_rd, remote) = temp_dir("karen-remote-");
    sh(&remote, &["init", "-q", "--bare"]).await;
    svc.add_remote(&repo, "origin", &remote).await.unwrap();
    svc.push(&repo, PushOptions::default()).await.unwrap();
    sh(&repo, &["remote", "set-head", "origin", "main"]).await;

    let refs = svc.refs(&repo).await.unwrap();
    let by_name = |n: &str| refs.iter().find(|r| r.full_name == n).unwrap();
    let main = by_name("refs/heads/main");
    assert_eq!((main.author.as_deref(), main.summary.as_deref()), (Some("Test User"), Some("first")));
    assert!(main.date.unwrap() > 1_000_000_000_000, "date is in milliseconds");
    assert_eq!(main.is_default, None);
    let v1 = by_name("refs/tags/v1");
    assert_eq!((v1.message.as_deref(), v1.summary.as_deref(), v1.author.as_deref()), (Some("release one"), Some("first"), Some("Test User")));
    assert_eq!(v1.date, main.date);
    assert_eq!(by_name("refs/tags/light").summary.as_deref(), Some("first"));
    assert_eq!(by_name("refs/remotes/origin/main").is_default, Some(true));
    assert!(!refs.iter().any(|r| r.name.ends_with("/HEAD")));
}

#[tokio::test]
async fn compares_two_revisions_from_the_merge_base_or_directly() {
    let (svc, _d, repo) = setup().await;
    let base = commit_file(&repo, "shared.txt", "one\n", "base").await;
    sh(&repo, &["checkout", "-q", "-b", "topic"]).await;
    commit_file(&repo, "topic.txt", "t1\nt2\n", "topic 1").await;
    commit_file(&repo, "shared.txt", "one\ntwo\n", "topic 2").await;
    sh(&repo, &["checkout", "-q", "main"]).await;
    commit_file(&repo, "main.txt", "m\n", "main only").await;

    let three = svc.compare_commits(&repo, "main", "topic", true).await.unwrap();
    assert_eq!(three.merge_base.as_deref(), Some(base.as_str()));
    let paths = |c: &CommitComparison| c.files.iter().map(|f| (f.path.clone(), f.status)).collect::<Vec<_>>();
    assert_eq!(paths(&three), [("shared.txt".to_string(), "modified"), ("topic.txt".to_string(), "added")]);
    assert_eq!(three.files[1].additions, Some(2));
    assert_eq!(summaries(&three.ahead), ["topic 2", "topic 1"]);
    assert_eq!(summaries(&three.behind), ["main only"]);
    assert_eq!((three.ahead_count, three.behind_count), (2, 1));

    // the direct diff also shows main's own change, reversed
    let two = svc.compare_commits(&repo, "main", "topic", false).await.unwrap();
    assert_eq!(
        paths(&two),
        [("main.txt".to_string(), "deleted"), ("shared.txt".to_string(), "modified"), ("topic.txt".to_string(), "added")]
    );
    assert_eq!((two.ahead_count, two.behind_count), (2, 1));

    let none = svc.compare_commits(&repo, "topic", "topic", true).await.unwrap();
    assert!(none.files.is_empty() && none.ahead.is_empty() && none.behind.is_empty());
    assert!(svc.compare_commits(&repo, "--all", "topic", true).await.is_err());
}

// ---------------------------------------------------------------------- daily usability

#[tokio::test]
async fn searches_history_by_path_and_content() {
    let (svc, _d, repo) = setup().await;
    let opts = |paths: &[&str], content: Option<&str>| SearchLogOptions {
        paths: strs(paths),
        content: content.map(String::from),
        ..Default::default()
    };
    assert!(svc.search_log(&repo, opts(&["a"], None)).await.unwrap().is_empty(), "no commits yet");
    let a = commit_file(&repo, "src/a.rs", "fn alpha() {}\n", "add a").await;
    let b = commit_file(&repo, "docs/b.md", "alpha docs\n", "add b").await;
    sh(&repo, &["checkout", "-q", "-b", "topic"]).await;
    let c = commit_file(&repo, "src/a.rs", "fn alpha() {}\nfn beta() {}\n", "beta on topic").await;
    sh(&repo, &["checkout", "-q", "main"]).await;

    // every branch, newest first; directories and globs as git pathspecs
    assert_eq!(svc.search_log(&repo, opts(&["src"], None)).await.unwrap(), [c.clone(), a.clone()]);
    assert_eq!(svc.search_log(&repo, opts(&["*.md"], None)).await.unwrap(), [b.clone()]);
    assert_eq!(svc.search_log(&repo, opts(&["docs", "src/a.rs"], None)).await.unwrap(), [c.clone(), b.clone(), a.clone()]);
    // -S: commits that change how often the string occurs
    assert_eq!(svc.search_log(&repo, opts(&[], Some("alpha"))).await.unwrap(), [b.clone(), a.clone()]);
    assert_eq!(svc.search_log(&repo, opts(&["src"], Some("alpha"))).await.unwrap(), [a.clone()]);
    assert_eq!(svc.search_log(&repo, opts(&[], Some("beta"))).await.unwrap(), [c.clone()]);
    assert_eq!(svc.search_log(&repo, opts(&[], Some("--all"))).await.unwrap(), Vec::<String>::new());
    assert!(svc.search_log(&repo, opts(&["  "], Some(""))).await.is_err());
    let limited = SearchLogOptions { limit: Some(1), ..opts(&["src"], None) };
    assert_eq!(svc.search_log(&repo, limited).await.unwrap(), [c.clone()]);
    let past = SearchLogOptions { since: Some(1_000_000_000_000), ..opts(&["src"], None) };
    assert_eq!(svc.search_log(&repo, past).await.unwrap().len(), 2);
    let future = SearchLogOptions { since: Some(2_000_000_000_000), ..opts(&["src"], None) };
    assert!(svc.search_log(&repo, future).await.unwrap().is_empty());
}

#[tokio::test]
async fn summarises_branch_upstream_and_changes() {
    let (svc, _d, repo) = setup().await;
    let empty = svc.repo_summary(&repo).await.unwrap();
    assert_eq!((empty.branch.as_deref(), empty.head_sha, empty.changes), (Some("main"), None, 0));
    commit_file(&repo, "a", "a\n", "a").await;
    let (_rd, remote) = temp_dir("karen-remote-");
    sh(&remote, &["init", "-q", "--bare"]).await;
    svc.add_remote(&repo, "origin", &remote).await.unwrap();
    svc.push(&repo, PushOptions::default()).await.unwrap();
    commit_file(&repo, "a", "b\n", "b").await;
    write_file(&repo, "a", "c\n");
    write_file(&repo, "new/one.txt", "1\n");
    write_file(&repo, "new/two.txt", "2\n");
    write_file(&repo, "staged.txt", "s\n");
    sh(&repo, &["add", "staged.txt"]).await;

    let s = svc.repo_summary(&repo).await.unwrap();
    assert_eq!((s.upstream.as_deref(), s.ahead, s.behind), (Some("origin/main"), 1, 0));
    // an untracked folder counts once, like `git status` shows it
    assert_eq!((s.changes, s.conflicted, s.operation), (3, 0, None));
    sh(&repo, &["checkout", "-q", "--detach"]).await;
    let d = svc.repo_summary(&repo).await.unwrap();
    assert!(d.detached && d.branch.is_none() && d.head_sha.is_some());
}

#[tokio::test]
async fn opens_the_repository_containing_a_file() {
    let (svc, _d, repo) = setup().await;
    write_file(&repo, "sub/dir/file.txt", "x\n");
    assert_eq!(svc.open(&join(&repo, "sub/dir/file.txt").to_string_lossy()).await.unwrap().path, repo);
    assert_eq!(svc.open(&join(&repo, "sub").to_string_lossy()).await.unwrap().path, repo);
    assert!(svc.open(&join(&repo, "missing").to_string_lossy()).await.is_err());
}

#[tokio::test]
async fn reads_the_commit_template_and_recent_authors() {
    let (svc, _d, repo) = setup().await;
    assert_eq!(svc.commit_template(&repo).await.unwrap(), None);
    assert!(svc.recent_authors(&repo, None).await.unwrap().is_empty());

    // relative to the repository root
    write_file(&repo, ".github/commit-template.txt", "feat: \n\n# Why?\n");
    sh(&repo, &["config", "commit.template", ".github/commit-template.txt"]).await;
    assert_eq!(svc.commit_template(&repo).await.unwrap().as_deref(), Some("feat: \n\n# Why?\n"));
    sh(&repo, &["config", "commit.template", "missing.txt"]).await;
    assert_eq!(svc.commit_template(&repo).await.unwrap(), None);

    commit_file(&repo, "a.txt", "1", "one").await;
    commit_file(&repo, "a.txt", "2", "two").await;
    sh(&repo, &["-c", "user.name=Ann", "-c", "user.email=ann@example.com", "commit", "-q", "--allow-empty", "-m", "three"]).await;
    let authors = svc.recent_authors(&repo, None).await.unwrap();
    let got: Vec<(&str, u32)> = authors.iter().map(|a| (a.email.as_str(), a.commits)).collect();
    assert_eq!(got, [("test@example.com", 2), ("ann@example.com", 1)]);
    assert_eq!(svc.recent_authors(&repo, Some(1)).await.unwrap().len(), 1);
}

#[tokio::test]
async fn commits_with_signoff_and_reports_unsigned_commits() {
    let (svc, _d, repo) = setup().await;
    write_file(&repo, "a.txt", "1\n");
    sh(&repo, &["add", "-A"]).await;
    let opts = CommitOptions { signoff: Some(true), sign: Some(false), ..Default::default() };
    let sha = svc.commit(&repo, "signed off", opts).await.unwrap();
    assert_eq!(svc.head_message(&repo).await.unwrap(), "signed off\n\nSigned-off-by: Test User <test@example.com>");
    assert_eq!(svc.signature_status(&repo, &sha).await.unwrap(), None);
    assert!(svc.signature_status(&repo, "--all").await.is_err());
}

#[tokio::test]
async fn signs_commits_with_an_ssh_key() {
    let (svc, _d, repo) = setup().await;
    let (_k, keys) = temp_dir("karen-keys-");
    let key = format!("{keys}/id_ed25519");
    let made = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", &key]).status();
    if !made.is_ok_and(|s| s.success()) {
        eprintln!("ssh-keygen is not available; skipping");
        return;
    }
    commit_file(&repo, "a.txt", "1\n", "first").await;
    // the overrides are what Preferences tries before saving them
    assert_eq!(svc.test_signing(Some(repo.clone()), Some("ssh".into()), Some(format!("{key}.pub"))).await.unwrap(), "ssh");
    assert_eq!(svc.test_signing(None, Some("ssh".into()), Some(format!("{key}.pub"))).await.unwrap(), "ssh");
    assert!(svc.test_signing(Some(repo.clone()), Some("pgp2".into()), None).await.is_err());
    // the test commit is never referenced
    assert_eq!(sh(&repo, &["rev-list", "--count", "--all"]).await, "1");

    sh(&repo, &["config", "gpg.format", "ssh"]).await;
    sh(&repo, &["config", "user.signingkey", &format!("{key}.pub")]).await;
    write_file(&repo, "a.txt", "2\n");
    sh(&repo, &["add", "-A"]).await;
    let sha = svc.commit(&repo, "signed", CommitOptions { sign: Some(true), ..Default::default() }).await.unwrap();
    let sig = svc.signature_status(&repo, &sha).await.unwrap().expect("signed");
    // without gpg.ssh.allowedSignersFile git cannot tell whether the key is trusted
    assert_eq!((sig.format, sig.status), ("ssh", "unverified"));

    let signers = format!("{keys}/allowed_signers");
    let public = std::fs::read_to_string(format!("{key}.pub")).unwrap();
    std::fs::write(&signers, format!("test@example.com {public}")).unwrap();
    sh(&repo, &["config", "gpg.ssh.allowedSignersFile", &signers]).await;
    let sig = svc.signature_status(&repo, &sha).await.unwrap().expect("signed");
    assert_eq!(sig.status, "good");
    assert!(sig.key.is_some_and(|k| k.starts_with("SHA256:")));

    svc.unset_config(Some(&repo), "user.signingkey", false).await.unwrap();
    svc.unset_config(Some(&repo), "user.signingkey", false).await.unwrap();
    assert_eq!(svc.get_config(Some(&repo), "user.signingkey").await.unwrap(), None);
}

#[tokio::test]
async fn head_diff_combines_staged_and_unstaged_changes() {
    let (svc, _d, repo) = setup().await;
    assert!(svc.head_diff(&repo).await.is_err());
    let numbers = |words: &[(usize, &str)]| -> String {
        (1..=30).map(|i| words.iter().find(|(n, _)| *n == i).map_or(format!("{i}\n"), |(_, w)| format!("{w}\n"))).collect()
    };
    commit_file(&repo, "a.txt", &numbers(&[]), "first").await;
    commit_file(&repo, "b.txt", "b\n", "second").await;
    write_file(&repo, "a.txt", &numbers(&[(2, "two"), (29, "twenty-nine")]));
    sh(&repo, &["add", "a.txt"]).await;
    write_file(&repo, "a.txt", &numbers(&[(2, "two"), (15, "fifteen"), (29, "twenty-nine")]));
    std::fs::remove_file(join(&repo, "b.txt")).unwrap();
    write_file(&repo, "new.txt", "untracked\n");

    let diffs = svc.head_diff(&repo).await.unwrap();
    let paths: Vec<&str> = diffs.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "b.txt"]);
    assert_eq!(diffs[0].hunks.len(), 3);
    assert_eq!(diffs[1].is_deleted, Some(true));

    // hunks applied to the index one group at a time, as the split commit does, despite shifted line numbers
    svc.unstage_all(&repo).await.unwrap();
    svc.apply_patch(&repo, &hunk_patch(&diffs[0], 2), ApplyOptions { cached: true, reverse: false }).await.unwrap();
    svc.commit(&repo, "last hunk", CommitOptions::default()).await.unwrap();
    svc.apply_patch(&repo, &hunk_patch(&diffs[0], 0), ApplyOptions { cached: true, reverse: false }).await.unwrap();
    svc.commit(&repo, "first hunk", CommitOptions::default()).await.unwrap();
    let left = svc.head_diff(&repo).await.unwrap();
    assert_eq!(left.iter().map(|d| (d.path.as_str(), d.hunks.len())).collect::<Vec<_>>(), [("a.txt", 1), ("b.txt", 1)]);
    assert!(left[0].hunks[0].lines.iter().any(|l| l.content == "fifteen"));
}
