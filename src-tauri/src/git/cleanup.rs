// Cleaning up merged branches: finding local branches whose work already reached a base branch (usually the
// remote's default branch) and deleting them in one go.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::exec::{git, Opts};
use super::parse::*;
use super::args::rev_arg;
use super::service::{match_remote, GitService, Res};
use crate::types::*;

/// Branch names never offered for cleanup, whatever their state.
const PROTECTED: [&str; 6] = ["main", "master", "develop", "development", "trunk", "HEAD"];
/// Branches checked for squash merges at the same time.
const SQUASH_JOBS: usize = 8;
/// Unmerged commits listed per branch; the count covers the rest.
const MAX_UNMERGED: usize = 20;

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

async fn run(repo: &Path, args: Vec<String>) -> Option<String> {
    git(repo, &args, Opts::read()).await.ok().map(|o| o.stdout)
}

/// The branch name of `short` ("origin/feature/x" -> "feature/x") when it starts with one of `remotes`.
fn strip_remote<'s>(remotes: &[String], short: &'s str) -> &'s str {
    match_remote(remotes, short).map_or(short, |r| &short[r.len() + 1..])
}

/// Whether the branch's whole diff since its merge base, as one throwaway commit, matches a commit of `base`
/// (a squash merge `git cherry` cannot see commit by commit).
async fn squash_commit_in_base(repo: &Path, base: &str, branch: &str) -> bool {
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

/// Whether every change of local branch `name` reached `base` as other commits, and if not, which commits did not.
/// Merging the branch into the base is tried first: when that changes nothing, the base has it all. That misses
/// a base that later rewrote the same lines, so patches are compared next, commit by commit (a rebase merge) and
/// then as one squashed commit.
async fn squash_check(repo: &Path, base: &str, base_tree: &str, name: String) -> SquashCheck {
    let branch = format!("refs/heads/{name}");
    let mut check = SquashCheck { name, squashed: false, unmerged: vec![], unmerged_count: 0 };
    // fails on git < 2.38 and on conflicts; the patch comparison below covers both
    let merged = run(repo, a(&["merge-tree", "--write-tree", "--no-messages", base, &branch])).await;
    if merged.as_deref().and_then(|o| o.lines().next()).map(str::trim) == Some(base_tree) {
        check.squashed = true;
        return check;
    }
    let Some(cherry) = run(repo, a(&["cherry", "-v", base, &branch])).await else { return check };
    let lines: Vec<&str> = cherry.lines().filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return check;
    }
    // "+ <sha> <subject>" for each commit whose patch is not in the base, oldest first
    let unmerged: Vec<&str> = lines.iter().filter_map(|l| l.strip_prefix("+ ")).collect();
    if unmerged.is_empty() || squash_commit_in_base(repo, base, &branch).await {
        check.squashed = true;
        return check;
    }
    check.unmerged_count = unmerged.len() as u32;
    check.unmerged = unmerged
        .iter()
        .rev()
        .take(MAX_UNMERGED)
        .map(|l| {
            let (sha, summary) = l.split_once(' ').unwrap_or((l, ""));
            UnmergedCommit { sha: sha.into(), summary: summary.into() }
        })
        .collect();
    check
}

impl GitService {
    /// Every local branch that may be cleaned up, compared with `base` (a ref such as "refs/remotes/origin/main"):
    /// "merged" when its tip is in the base, "gone" when its upstream was deleted on the remote, "unknown" otherwise
    /// (`check_squash_merged` tells whether its changes reached the base as other commits). Never lists the base's
    /// own branch, a branch tracking the base, common long-lived branches, Gitflow's branches or `opts.protected`;
    /// a branch checked out in a worktree is listed with that worktree's path.
    pub async fn merged_branches(&self, repo: &str, base: &str, opts: MergedBranchOptions) -> Res<Vec<MergedBranch>> {
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
        let checked_out: HashMap<String, String> =
            parse_worktrees(&worktrees).into_iter().filter_map(|w| Some((w.branch?, w.path))).collect();
        let remotes: Vec<String> = remotes.lines().filter(|r| !r.is_empty()).map(String::from).collect();

        let mut protected: HashSet<String> = PROTECTED.iter().map(|s| s.to_string()).collect();
        protected.extend(opts.protected.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
        protected.extend(gitflow.stdout.lines().filter_map(|l| l.split_once(' ')).map(|(_, v)| v.trim().to_string()));
        let base_short = base.strip_prefix("refs/remotes/").or_else(|| base.strip_prefix("refs/heads/")).unwrap_or(&base);
        protected.insert(strip_remote(&remotes, base_short).to_string());
        protected.insert(base_short.to_string());
        // an upstream may be deleted on its remote only when it is not one of the protected branches there
        let deletable_upstream = |u: &str| {
            let Some(short) = u.strip_prefix("refs/remotes/") else { return false };
            u != base && !protected.contains(strip_remote(&remotes, short))
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
            let deletable = live_upstream.as_deref().is_some_and(|u| deletable_upstream(u));
            let reason = if merged.contains(get(0)) {
                "merged"
            } else if gone {
                "gone"
            } else {
                "unknown"
            };
            res.push(MergedBranch {
                name: name.into(),
                sha: get(1).into(),
                reason,
                gone,
                upstream_merged: deletable && merged.contains(upstream),
                // no ahead/behind counts: the upstream points at the branch's own commit
                upstream_matches: deletable && get(3).is_empty(),
                upstream: live_upstream,
                worktree: checked_out.get(name).cloned(),
                date: get(4).parse::<i64>().ok().map(|s| s * 1000),
                author: Some(get(5)).filter(|s| !s.is_empty()).map(String::from),
                summary: Some(get(6)).filter(|s| !s.is_empty()).map(String::from),
            });
        }
        Ok(res)
    }

    /// For each local branch of `names`, whether its changes reached `base` as other commits (squash or rebase
    /// merge), and the commits that did not. Results keep the order of `names`.
    pub async fn check_squash_merged(&self, repo: &str, base: &str, names: Vec<String>) -> Res<Vec<SquashCheck>> {
        let base = rev_arg(base)?;
        let base_tree = self.out(repo, vec!["rev-parse".into(), format!("{base}^{{tree}}")]).await?.trim().to_string();
        let limit = Arc::new(tokio::sync::Semaphore::new(SQUASH_JOBS));
        let mut jobs = tokio::task::JoinSet::new();
        for (i, name) in names.into_iter().enumerate() {
            let name = rev_arg(name.strip_prefix("refs/heads/").unwrap_or(&name))?;
            let (path, base, base_tree, limit) = (PathBuf::from(repo), base.clone(), base_tree.clone(), limit.clone());
            jobs.spawn(async move {
                let _permit = limit.acquire_owned().await;
                (i, squash_check(&path, &base, &base_tree, name).await)
            });
        }
        let mut res: Vec<(usize, SquashCheck)> = Vec::new();
        while let Some(job) = jobs.join_next().await {
            res.push(job.map_err(|e| e.to_string())?);
        }
        res.sort_by_key(|(i, _)| *i);
        Ok(res.into_iter().map(|(_, c)| c).collect())
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
        let mut args = a(&["push", "--progress", &rev_arg(remote)?, "--delete"]);
        for n in &names {
            args.push(rev_arg(n)?);
        }
        let op = self.remote_op(repo);
        let _n = self.net_lock(repo, &op).await?;
        self.write_opts(repo, args, self.remote_opts(repo, "push", &op)).await?;
        Ok(())
    }
}
