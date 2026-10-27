// Repository probes and pull request creation for the smart commit workflow (stage -> commit -> push -> PR).
// Diffs are returned raw; condensing them for the AI and building prompts happens in the renderer.
use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;

use regex::Regex;
use tokio::process::Command;

use super::service::{GitService, Res};
use crate::types::*;

/// Raw diffs larger than this are cut at a line boundary; the renderer condenses far below it anyway.
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;
const MAX_UNTRACKED: usize = 200;
const MAX_BRANCH_COMMITS: usize = 30;
const PR_TEMPLATE_MAX_CHARS: usize = 4000;

static PR_TEMPLATE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^pull_request_template\.(md|txt)$").unwrap());
static GITHUB_SLUG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"github\.com[:/]+([^/]+/[^/]+?)(?:\.git)?/*$").unwrap());

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn cap(mut s: String) -> String {
    if s.len() > MAX_DIFF_BYTES {
        let mut end = MAX_DIFF_BYTES;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        let end = s[..end].rfind('\n').map(|i| i + 1).unwrap_or(end);
        s.truncate(end);
    }
    s
}

fn lines(s: &str) -> Vec<String> {
    s.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

/// "owner/repo" from a GitHub remote URL (HTTPS or SSH).
pub fn github_slug(url: &str) -> Option<String> {
    GITHUB_SLUG_RE.captures(url.trim()).map(|c| c[1].to_string())
}

struct GhOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

async fn gh(cwd: &str, args: &[String]) -> Result<GhOutput, String> {
    let out = Command::new("gh")
        .args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("Failed to run gh: {e}"))?;
    Ok(GhOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

fn skipped(message: String) -> PullRequestResult {
    PullRequestResult { status: "skipped", url: None, message: Some(message) }
}

impl GitService {
    /// Whether `git diff <args> --quiet` finds a difference.
    async fn differs(&self, repo: &str, args: &[&str]) -> Res<bool> {
        Ok(self.read(repo, a(args), &[0, 1]).await?.code == 1)
    }

    async fn untracked_files(&self, repo: &str) -> Res<Vec<String>> {
        Ok(lines(&self.out(repo, a(&["ls-files", "--others", "--exclude-standard"])).await?))
    }

    async fn rev_count(&self, repo: &str, range: &str) -> Res<u32> {
        let out = self.out(repo, a(&["rev-list", "--count", range])).await?;
        out.trim().parse().map_err(|_| format!("Unexpected rev-list output: {out}"))
    }

    /// What each step of the pipeline would have to do. `unpushed` assumes the remote was just fetched.
    pub async fn smart_status(&self, repo: &str) -> Res<SmartStatus> {
        let branch = self.current_branch(repo).await?;
        let remote = self.default_remote(repo).await.ok();
        let has_commits = self.has_head(repo).await?;
        let unpushed = match (&branch, &remote, has_commits) {
            (Some(b), Some(r), true) => {
                let tracking = format!("refs/remotes/{r}/{b}");
                // a branch the remote doesn't have needs the push that creates it; if unsure, assume a push is needed
                !self.verify(repo, &tracking).await? || self.rev_count(repo, &format!("{tracking}..HEAD")).await.map(|n| n > 0).unwrap_or(true)
            }
            _ => false,
        };
        let gh = matches!(gh(repo, &a(&["--version"])).await, Ok(o) if o.code == 0);
        Ok(SmartStatus {
            branch,
            remote,
            has_commits,
            unstaged: self.differs(repo, &["diff", "--quiet"]).await?,
            untracked: !self.untracked_files(repo).await?.is_empty(),
            staged: self.differs(repo, &["diff", "--cached", "--quiet"]).await?,
            unpushed,
            gh,
        })
    }

    /// The changes a commit would contain: the whole working tree when it stages everything first, the index otherwise.
    pub async fn pending_diff(&self, repo: &str, include_unstaged: bool) -> Res<PendingDiff> {
        // `git diff HEAD` needs a HEAD; in a fresh repo everything is staged or untracked anyway
        let working_tree = include_unstaged && self.has_head(repo).await?;
        let diff = self.out(repo, a(if working_tree { &["diff", "HEAD"] } else { &["diff", "--cached"] })).await?;
        let mut untracked = if include_unstaged { self.untracked_files(repo).await? } else { vec![] };
        untracked.truncate(MAX_UNTRACKED);
        Ok(PendingDiff { diff: cap(diff), untracked })
    }

    /// The tree `target_ref` would have after merging `from`, or None when git can't build one cleanly
    /// (git < 2.38, or the merge conflicts).
    async fn merged_tree(&self, repo: &str, target_ref: &str, from: &str) -> Option<String> {
        let out = self.out(repo, a(&["merge-tree", "--write-tree", "--no-messages", target_ref, from])).await.ok()?;
        out.lines().next().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
    }

    /// What a pull request from `from` into `remote/target` would change. Never a plain two-dot diff: that compares
    /// the tips, so work that landed on the target after the branches diverged shows up as removed. Diffing the
    /// target against the would-be merge result lets changes the target already has cancel out; the merge-base
    /// (three-dot) diff is the fallback.
    pub async fn compare_branch(&self, repo: &str, from: &str, target: &str, remote: &str) -> Res<BranchComparison> {
        let target_ref = format!("{remote}/{target}");
        if !self.verify(repo, &format!("refs/remotes/{target_ref}")).await? {
            return Ok(BranchComparison::default());
        }
        let range = match self.merged_tree(repo, &target_ref, from).await {
            Some(tree) => vec![target_ref.clone(), tree],
            None => vec![format!("{target_ref}...{from}")],
        };
        let diff = self.out(repo, [a(&["diff"]), range.clone()].concat()).await.unwrap_or_default();
        let stat = self.out(repo, [a(&["diff", "--stat", "--stat-width=100"]), range].concat()).await.unwrap_or_default();
        let max = format!("--max-count={MAX_BRANCH_COMMITS}");
        // --cherry-pick drops commits whose patch the target already has (cherry-picked or rebased copies)
        let log = a(&["log", "--no-merges", "--cherry-pick", "--right-only", &max, "--format=%s", &format!("{target_ref}...{from}")]);
        let commits = lines(&self.out(repo, log).await.unwrap_or_default());
        Ok(BranchComparison { target_exists: true, commits, stat: stat.trim_end().to_string(), diff: cap(diff) })
    }

    /// The repository's pull request template, where GitHub looks for one: the root, .github/ and docs/.
    /// A PULL_REQUEST_TEMPLATE/ directory of several templates is ignored, since there is no right default.
    pub async fn pr_template(&self, repo: &str) -> Res<Option<PrTemplate>> {
        let root = self.out(repo, a(&["rev-parse", "--show-toplevel"])).await?.trim().to_string();
        for dir in ["", ".github", "docs"] {
            let base = Path::new(&root).join(dir);
            let Ok(mut entries) = tokio::fs::read_dir(&base).await else { continue };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !PR_TEMPLATE_RE.is_match(&name) {
                    continue;
                }
                let Ok(content) = tokio::fs::read_to_string(entry.path()).await else { break };
                let content: String = content.trim().chars().take(PR_TEMPLATE_MAX_CHARS).collect();
                if content.is_empty() {
                    break;
                }
                let path = if dir.is_empty() { name } else { format!("{dir}/{name}") };
                return Ok(Some(PrTemplate { path, content }));
            }
        }
        Ok(None)
    }

    /// Open a GitHub pull request with the gh CLI. Guarded so that nothing is opened when the branches aren't on the
    /// remote, the source has nothing the target lacks, or a PR between them is already open. Expects the remote
    /// tracking refs to be current (fetched or just pushed).
    pub async fn create_pull_request(&self, repo: &str, remote: &str, from: &str, to: &str, title: &str, body: &str) -> Res<PullRequestResult> {
        if !matches!(gh(repo, &a(&["--version"])).await, Ok(o) if o.code == 0) {
            return Ok(skipped("The GitHub CLI (gh) is not installed. Install it and run `gh auth login`.".into()));
        }
        if !self.verify(repo, &format!("refs/remotes/{remote}/{from}")).await? {
            return Ok(skipped(format!("{from} is not on {remote}; push it first.")));
        }
        if !self.verify(repo, &format!("refs/remotes/{remote}/{to}")).await? {
            return Ok(skipped(format!("{remote}/{to} does not exist.")));
        }
        if self.rev_count(repo, &format!("refs/remotes/{remote}/{to}..refs/remotes/{remote}/{from}")).await? == 0 {
            return Ok(skipped(format!("{remote}/{from} has no commits that {remote}/{to} doesn't already have.")));
        }

        // the push URL is the repo GitHub must find the head branch in (it differs from the fetch URL in fork setups)
        let url = self.out(repo, a(&["remote", "get-url", "--push", remote])).await.unwrap_or_default();
        let slug = github_slug(&url);
        let repo_args = slug.as_deref().map(|s| a(&["--repo", s])).unwrap_or_default();

        let list = [a(&["pr", "list", "--base", to, "--head", from, "--state", "open", "--json", "url", "--jq", ".[0].url"]), repo_args.clone()].concat();
        if let Ok(o) = gh(repo, &list).await {
            if o.code == 0 && !o.stdout.is_empty() {
                return Ok(PullRequestResult { status: "exists", url: Some(o.stdout), message: None });
            }
        }

        let create = [a(&["pr", "create", "--base", to, "--head", from, "--title", title, "--body", body]), repo_args].concat();
        let o = gh(repo, &create).await?;
        if o.code == 0 {
            let url = o.stdout.lines().rev().map(str::trim).find(|l| l.starts_with("http")).map(String::from);
            return Ok(PullRequestResult { status: "created", url, message: None });
        }
        let err = if o.stderr.is_empty() { o.stdout } else { o.stderr };
        if err.contains("already exists") {
            let url = err.split_whitespace().find(|w| w.starts_with("https://")).map(String::from);
            return Ok(PullRequestResult { status: "exists", url, message: None });
        }
        Ok(skipped(if err.contains("No commits between") {
            format!("No new commits between {to} and {from}.")
        } else if err.contains("Head ref must be a branch") {
            format!("GitHub cannot find {from} in {}. With a fork, the head may need the owner:{from} form.", slug.as_deref().unwrap_or("the repository"))
        } else {
            // gh often ends stderr with a blank line; the last line that says something is the useful one
            err.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gh pr create failed").to_string()
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_slugs() {
        assert_eq!(github_slug("git@github.com:owner/repo.git").as_deref(), Some("owner/repo"));
        assert_eq!(github_slug("https://github.com/owner/repo").as_deref(), Some("owner/repo"));
        assert_eq!(github_slug("https://github.com/owner/my.repo.git").as_deref(), Some("owner/my.repo"));
        assert_eq!(github_slug("ssh://git@github.com/owner/repo/").as_deref(), Some("owner/repo"));
        assert_eq!(github_slug("https://gitlab.com/owner/repo.git"), None);
    }

    #[test]
    fn caps_at_a_line_boundary() {
        let line = "x".repeat(1023) + "\n";
        let big = line.repeat(MAX_DIFF_BYTES / 1024 + 10);
        let capped = cap(big);
        assert!(capped.len() <= MAX_DIFF_BYTES);
        assert!(capped.ends_with('\n'));
        assert_eq!(cap("short".into()), "short");
    }
}
