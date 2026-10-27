// Everyday helpers: the commit search filters that need history (`path:`, `content:` in the graph search box)
// and the light status the workspace view polls for every repository it lists.
use std::collections::HashSet;

use super::parse::parse_status;
use super::service::{GitService, Res};
use crate::types::*;

/// Branch selector of the graph log, as in service.rs: everything except refs/stash.
const LOG_REFS: [&str; 4] = ["--branches", "--remotes", "--tags", "HEAD"];

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

impl GitService {
    /// Shas of the graph's commits (newest first, at most `limit`) that touch one of `paths` and,
    /// with `content`, add or remove that string (`git log -S`). `since` bounds the walk to the loaded history.
    pub async fn search_log(&self, repo: &str, opts: SearchLogOptions) -> Res<Vec<String>> {
        let content = opts.content.filter(|c| !c.is_empty());
        let paths: Vec<String> = opts.paths.into_iter().filter(|p| !p.trim().is_empty()).collect();
        if content.is_none() && paths.is_empty() {
            return Err("Nothing to search for".into());
        }
        let mut args = a(&["log", "--date-order", "--format=%H"]);
        args.push(format!("-n{}", opts.limit.unwrap_or(2000)));
        if let Some(ms) = opts.since {
            args.push(format!("--since=@{}", ms / 1000));
        }
        if let Some(c) = content {
            args.push(format!("-S{c}"));
        }
        args.extend(LOG_REFS.map(String::from));
        // pathspecs after `--` are never read as options; without paths `--` still ends the revisions
        args.push("--".into());
        args.extend(paths);
        // an empty repository has no HEAD to start from
        let r = self.read(repo, args, &[0, 128]).await?;
        Ok(if r.code == 0 { r.stdout.lines().filter(|l| !l.is_empty()).map(String::from).collect() } else { vec![] })
    }

    /// Branch, upstream distance and number of changed files, from one `git status` without line counts.
    pub async fn repo_summary(&self, repo: &str) -> Res<RepoSummary> {
        let out = self.out(repo, a(&["-c", "core.quotepath=false", "status", "--porcelain=v2", "--branch", "-z", "-unormal"])).await?;
        let st = parse_status(&out);
        let changed: HashSet<&str> = st.staged.iter().chain(&st.unstaged).chain(&st.conflicted).map(|f| f.path.as_str()).collect();
        Ok(RepoSummary {
            changes: changed.len() as u32,
            conflicted: st.conflicted.len() as u32,
            operation: self.operation(repo).await?,
            branch: st.branch,
            detached: st.detached,
            head_sha: st.head_sha,
            upstream: st.upstream,
            ahead: st.ahead,
            behind: st.behind,
        })
    }
}
