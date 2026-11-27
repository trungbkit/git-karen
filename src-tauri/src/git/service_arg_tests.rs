// Strings from the renderer (and hosting APIs) never reach git as options. Uses the helpers of service_tests.rs.
use std::path::Path;

use serde_json::json;

use super::*;

/// Each value is rejected before git runs, with the usual message.
#[tokio::test]
async fn rejects_option_like_names_revisions_and_urls_from_ipc() {
    let (svc, _d, repo) = setup().await;
    let sha = commit_file(&repo, "a", "a\n", "a").await;
    let (_pd, parent) = temp_dir("karen-clone-");
    let dest = join(&parent, "copy").to_string_lossy().into_owned();
    let new_repo = join(&parent, "new").to_string_lossy().into_owned();
    let up = "--upload-pack=touch pwned";
    let gitflow = json!({"master": "-f", "develop": "develop", "feature": "f/", "release": "r/", "hotfix": "h/", "versionTag": ""});
    let cases = [
        ("init", json!([new_repo, "-f"]), "Invalid branch name: -f"),
        ("clone", json!([up, dest]), "Invalid remote URL: --upload-pack=touch pwned"),
        ("commitDetail", json!([repo, "--output=x"]), "Invalid revision: --output=x"),
        ("diff", json!([repo, {"kind": "commit", "sha": "-p", "path": "a"}]), "Invalid revision: -p"),
        ("diff", json!([repo, {"kind": "compare", "from": sha, "to": "--output=x", "path": "a"}]), "Invalid revision: --output=x"),
        ("fileContent", json!([repo, "--output=x", "a"]), "Invalid revision: --output=x"),
        ("blame", json!([repo, "a", "--contents=/etc/hosts"]), "Invalid revision: --contents=/etc/hosts"),
        ("imageBlob", json!([repo, "-p", "a"]), "Invalid revision: -p"),
        ("createBranch", json!([repo, "-f", sha]), "Invalid branch name: -f"),
        ("createBranch", json!([repo, "x", "--orphan"]), "Invalid revision: --orphan"),
        ("deleteBranch", json!([repo, "refs/heads/-f"]), "Invalid branch name: -f"),
        ("deleteRemoteBranch", json!([repo, up, "x"]), "Invalid remote name: --upload-pack=touch pwned"),
        ("deleteRemoteBranch", json!([repo, "origin", "-f"]), "Invalid branch name: -f"),
        ("renameBranch", json!([repo, "main", "-f"]), "Invalid branch name: -f"),
        ("moveBranch", json!([repo, "-f", sha, sha]), "Invalid branch name: -f"),
        ("moveBranch", json!([repo, "main", "--all", sha]), "Invalid revision: --all"),
        ("moveBranch", json!([repo, "main", sha, "--all"]), "Invalid revision: --all"),
        ("checkout", json!([repo, "-f"]), "Invalid revision: -f"),
        ("checkoutRemote", json!([repo, "refs/remotes/-f"]), "Invalid revision: -f"),
        ("checkoutRemote", json!([repo, "origin/x", "-f"]), "Invalid branch name: -f"),
        ("setUpstream", json!([repo, "-f", "origin/main"]), "Invalid branch name: -f"),
        ("createTag", json!([repo, "-f", sha]), "Invalid tag name: -f"),
        ("createTag", json!([repo, "v1", "--contains"]), "Invalid revision: --contains"),
        ("deleteTag", json!([repo, "-l"]), "Invalid tag name: -l"),
        ("pushTag", json!([repo, up, "v1"]), "Invalid remote name: --upload-pack=touch pwned"),
        ("deleteRemoteTag", json!([repo, "origin", "-f"]), "Invalid tag name: -f"),
        ("merge", json!([repo, "--abort"]), "Invalid revision: --abort"),
        ("rebase", json!([repo, "--exec=touch pwned"]), "Invalid revision: --exec=touch pwned"),
        ("interactiveRebase", json!([repo, "--exec=touch pwned", []]), "Invalid revision: --exec=touch pwned"),
        ("cherryPick", json!([repo, [sha, "-n"]]), "Invalid revision: -n"),
        ("revert", json!([repo, "--quit"]), "Invalid revision: --quit"),
        ("reset", json!([repo, "--", "hard"]), "Invalid revision: --"),
        ("fetch", json!([repo, up]), "Invalid remote name: --upload-pack=touch pwned"),
        ("push", json!([repo, {"remote": "--receive-pack=touch pwned"}]), "Invalid remote name: --receive-pack=touch pwned"),
        ("push", json!([repo, {"branch": "--all"}]), "Invalid branch name: --all"),
        ("addRemote", json!([repo, "-f", "https://example.com/r.git"]), "Invalid remote name: -f"),
        ("addRemote", json!([repo, "o", "--mirror=fetch"]), "Invalid remote URL: --mirror=fetch"),
        ("removeRemote", json!([repo, "-v"]), "Invalid remote name: -v"),
        ("editRemote", json!([repo, "origin", "--push"]), "Invalid remote URL: --push"),
        ("submoduleAdd", json!([repo, up, "sub"]), "Invalid remote URL: --upload-pack=touch pwned"),
        ("worktreeAdd", json!([repo, "wt", "--detach"]), "Invalid revision: --detach"),
        ("worktreeAdd", json!([repo, "wt", "main", "-f"]), "Invalid branch name: -f"),
        ("worktreeRemove", json!([repo, "--force"]), "Invalid path: --force"),
        ("worktreeLock", json!([repo, "--reason=x", true]), "Invalid path: --reason=x"),
        ("getConfig", json!([repo, "--file=/etc/passwd"]), "Invalid config key: --file=/etc/passwd"),
        ("setConfig", json!([repo, "--file=x", "y"]), "Invalid config key: --file=x"),
        ("unsetConfig", json!([repo, "--global"]), "Invalid config key: --global"),
        ("gitflowInit", json!([repo, gitflow]), "Invalid branch name: -f"),
        ("compareBranch", json!([repo, "--output=x", "main", "origin"]), "Invalid revision: --output=x"),
        ("createPullRequest", json!([repo, "origin", "-f", "main", "t", "b"]), "Invalid branch name: -f"),
        ("lfsTrack", json!([repo, "--lockable"]), "Invalid path: --lockable"),
        ("restoreBranch", json!([repo, "-f", sha]), "Invalid branch name: -f"),
        ("restoreFiles", json!([repo, [{"path": "a\u{0}b", "blob": sha, "executable": false}]]), "Invalid path: a\u{0}b"),
        ("pushSha", json!([repo, "origin", sha, "-f"]), "Invalid branch name: -f"),
    ];
    for (method, args, expected) in cases {
        let args = args.as_array().unwrap().clone();
        assert_eq!(svc.call(method, args).await.unwrap_err(), expected, "{method}");
    }
    assert!(!Path::new(&dest).exists() && !Path::new(&new_repo).exists() && !exists(&repo, "pwned"));
    assert_eq!(svc.refs(&repo).await.unwrap().len(), 1, "no branch or tag was created");
}

#[tokio::test]
async fn argument_checks_keep_ordinary_values_working() {
    let (svc, _d, repo) = setup().await;
    let sha = commit_file(&repo, "a", "a\n", "a").await;
    commit_file(&repo, "a", "b\n", "b").await;
    svc.create_branch(&repo, "feature/x-1", Some("HEAD~1".into()), false).await.unwrap();
    svc.checkout(&repo, "refs/heads/feature/x-1").await.unwrap();
    assert_eq!(svc.file_content(&repo, Some("main".into()), "a").await.unwrap(), "b\n");
    // an empty revision reads the index
    write_file(&repo, "a", "staged\n");
    svc.stage(&repo, strs(&["a"])).await.unwrap();
    assert_eq!(svc.file_content(&repo, Some(String::new()), "a").await.unwrap(), "staged\n");
    // a config value may start with "-": options end at the key
    svc.set_config(Some(&repo), "karen.flags", "-R --quiet", false).await.unwrap();
    assert_eq!(svc.get_config(Some(&repo), "karen.flags").await.unwrap().as_deref(), Some("-R --quiet"));
    svc.create_tag(&repo, "v1.0", &sha, None).await.unwrap();
    svc.add_remote(&repo, "up-stream", "../sibling.git").await.unwrap();
    assert_eq!(svc.remotes(&repo).await.unwrap()[0].fetch_url, "../sibling.git");
}
