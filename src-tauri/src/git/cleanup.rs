// Cleaning up merged branches: finding local branches whose work already reached a base branch (usually the
// remote's default branch) and deleting them in one go.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::exec::{git, Opts};
use super::parse::*;
use super::recovery::rev_arg;
use super::service::{GitService, Res};
use crate::types::*;

/// Branch names never offered for cleanup, whatever their state.
const PROTECTED: [&str; 6] = ["main", "master", "develop", "development", "trunk", "HEAD"];
/// Branches checked for squash merges at the same time.
const SQUASH_JOBS: usize = 8;

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

async fn run(repo: &Path, args: Vec<String>) -> Option<String> {
    git(repo, &args, Opts::read()).await.ok().map(|o| o.stdout)
}

/// Whether every change of `branch` reached `base` as other commits: either commit by commit (a rebase merge,
/// `git cherry` marks them all with "-") or as one squashed commit, found by comparing a throwaway commit that
/// holds the branch's whole diff since the merge base against the base's commits.
async fn squash_merged(repo: &Path, base: &str, branch: &str) -> bool {
    let Some(cherry) = run(repo, a(&["cherry", base, branch])).await else { return false };
    let lines: Vec<&str> = cherry.lines().filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return false;
    }
    if lines.iter().all(|l| l.starts_with('-')) {
        return true;
    }
    let Some(mb) = run(repo, a(&["merge-base", base, branch])).await else { return false };
    let Some(tree) = run(repo, vec!["rev-parse".into(), format!("{branch}^{{tree}}")]).await else { return false };
    // the identity only names the throwaway (unreferenced) commit; it keeps commit-tree working without user.name
    let env = ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]
        .iter()
        .map(|k| (k.to_string(), if k.ends_with("EMAIL") { "karen@localhost" } else { "Karen" }.to_string()))
        .collect();
    let opts = Opts { env, ..Opts::read() };
    let args = a(&["commit-tree", "--no-gpg-sign", tree.trim(), "-p", mb.trim(), "-m", "squash check"]);
    let Ok(squash) = git(repo, &args, opts).await else { return false };
    let Some(out) = run(repo, a(&["cherry", base, squash.stdout.trim()])).await else { return false };
    out.trim().starts_with('-')
}

impl GitService {
    /// Local branches whose work is already in `base` (a ref such as "refs/remotes/origin/main"). A branch qualifies
    /// when its tip is in the base ("merged"), when, with `squashed`, its changes reached the base as other commits
    /// ("squashed"), or when its upstream was deleted on the remote ("gone"; the work may then be anywhere).
    /// Never lists the base's own branch, common long-lived branches, Gitflow's branches or a branch that is
    /// checked out in any worktree.
    pub async fn merged_branches(&self, repo: &str, base: &str, squashed: bool) -> Res<Vec<MergedBranch>> {
        let base = rev_arg(base)?;
        if !self.verify(repo, &format!("{base}^{{commit}}")).await? {
            return Err(format!("Unknown branch: {base}"));
        }
        let fmt = [
            "%(refname)",
            "%(objectname)",
            "%(upstream)",
            "%(upstream:track)",
            "%(committerdate:unix)",
            "%(authorname)",
            "%(contents:subject)",
        ]
        .join(US);
        let merged_arg = format!("--merged={base}");
        let (heads, merged, worktrees, gitflow, remotes) = tokio::try_join!(
            self.out(repo, vec!["for-each-ref".into(), format!("--format={fmt}{RS}"), "refs/heads".into()]),
            self.out(repo, vec!["for-each-ref".into(), "--format=%(refname)".into(), merged_arg, "refs/heads".into(), "refs/remotes".into()]),
            self.out(repo, a(&["worktree", "list", "--porcelain"])),
            self.read(repo, a(&["config", "--get-regexp", r"^gitflow\.branch\."]), &[0, 1]),
            self.out(repo, a(&["remote"]))
        )?;
        let merged: HashSet<&str> = merged.lines().collect();

        let mut protected: HashSet<String> = PROTECTED.iter().map(|s| s.to_string()).collect();
        protected.extend(parse_worktrees(&worktrees).into_iter().filter_map(|w| w.branch));
        protected.extend(gitflow.stdout.lines().filter_map(|l| l.split_once(' ')).map(|(_, v)| v.trim().to_string()));
        let base_short = base.strip_prefix("refs/remotes/").or_else(|| base.strip_prefix("refs/heads/")).unwrap_or(&base);
        let base_branch = remotes
            .lines()
            .filter(|r| !r.is_empty() && base_short.starts_with(&format!("{r}/")))
            .max_by_key(|r| r.len())
            .map_or(base_short, |r| &base_short[r.len() + 1..]);
        protected.insert(base_branch.to_string());
        protected.insert(base_short.to_string());
        // an upstream may be deleted on its remote only when it is not one of the protected branches there
        let remote_list: Vec<String> = remotes.lines().filter(|r| !r.is_empty()).map(String::from).collect();
        let deletable_upstream = |u: &str| {
            let Some(short) = u.strip_prefix("refs/remotes/") else { return false };
            let name = remote_list
                .iter()
                .filter(|r| short.starts_with(&format!("{r}/")))
                .max_by_key(|r| r.len())
                .map_or(short, |r| &short[r.len() + 1..]);
            u != base && !protected.contains(name)
        };

        let mut res = Vec::new();
        for rec in heads.split(RS) {
            let line = rec.strip_prefix('\n').unwrap_or(rec);
            if line.trim().is_empty() {
                continue;
            }
            let f: Vec<&str> = line.split(US).collect();
            let get = |i: usize| f.get(i).copied().unwrap_or("");
            let Some(name) = get(0).strip_prefix("refs/heads/") else { continue };
            let upstream = get(2);
            if protected.contains(name) || upstream == base {
                continue;
            }
            let gone = get(3) == "[gone]";
            let live_upstream = (!upstream.is_empty() && !gone).then(|| upstream.to_string());
            let reason = if merged.contains(get(0)) {
                "merged"
            } else if gone {
                "gone"
            } else {
                ""
            };
            res.push(MergedBranch {
                name: name.into(),
                sha: get(1).into(),
                reason,
                gone,
                upstream_merged: live_upstream.as_deref().is_some_and(|u| merged.contains(u) && deletable_upstream(u)),
                upstream: live_upstream,
                date: get(4).parse::<i64>().ok().map(|s| s * 1000),
                author: Some(get(5)).filter(|s| !s.is_empty()).map(String::from),
                summary: Some(get(6)).filter(|s| !s.is_empty()).map(String::from),
            });
        }

        if squashed {
            let limit = Arc::new(tokio::sync::Semaphore::new(SQUASH_JOBS));
            let mut jobs = tokio::task::JoinSet::new();
            for (i, b) in res.iter().enumerate().filter(|(_, b)| b.reason != "merged") {
                let (path, base, branch, limit) = (PathBuf::from(repo), base.clone(), format!("refs/heads/{}", b.name), limit.clone());
                jobs.spawn(async move {
                    let _permit = limit.acquire_owned().await;
                    (i, squash_merged(&path, &base, &branch).await)
                });
            }
            let mut squashes = Vec::new();
            while let Some(Ok((i, yes))) = jobs.join_next().await {
                if yes {
                    squashes.push(i);
                }
            }
            for i in squashes {
                res[i].reason = "squashed";
            }
            // an upstream that still exists counts as merged when it matches the squash-merged local branch
            for b in res.iter_mut().filter(|b| b.reason == "squashed" && !b.upstream_merged) {
                if let Some(u) = b.upstream.as_deref().filter(|u| deletable_upstream(u)) {
                    b.upstream_merged = self.resolve_ref(repo, u).await?.as_deref() == Some(b.sha.as_str());
                }
            }
        }
        res.retain(|b| !b.reason.is_empty());
        Ok(res)
    }

    /// Delete local branches whether or not git considers them merged; one failure does not stop the others.
    pub async fn delete_branches(&self, repo: &str, names: Vec<String>) -> Res<Vec<BranchDeletion>> {
        let _g = self.lock(repo).await;
        let mut res = Vec::new();
        for name in names {
            let name = name.strip_prefix("refs/heads/").unwrap_or(&name).to_string();
            let error = match rev_arg(&name) {
                Ok(n) => self.write(repo, a(&["branch", "-D", &n])).await.err(),
                Err(e) => Some(e),
            };
            res.push(BranchDeletion { name, error });
        }
        Ok(res)
    }

    /// Delete several branches of one remote with a single push.
    pub async fn delete_remote_branches(&self, repo: &str, remote: &str, names: Vec<String>) -> Res<()> {
        if names.is_empty() {
            return Ok(());
        }
        let _g = self.lock(repo).await;
        let mut args = a(&["push", "--progress", &rev_arg(remote)?, "--delete"]);
        for n in &names {
            args.push(rev_arg(n)?);
        }
        self.write_opts(repo, args, Opts::default().progress(self.progress(repo, "push"))).await?;
        Ok(())
    }
}
