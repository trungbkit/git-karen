// Undo and recovery: the HEAD reflog, snapshots taken before destructive operations and the means to restore
// them, and previews of what an operation would lose.
use std::path::Path;

use super::exec::Opts;
use super::parse::*;
use super::service::{GitService, Res};
use crate::types::*;

/// Paths per git invocation, as in service.rs.
const PATH_BATCH: usize = 500;
/// Untracked files are read in full to count their lines; larger ones are reported as binary.
const MAX_COUNTED_BYTES: u64 = 4 * 1024 * 1024;

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// Revisions come from the renderer; never let one be read as an option.
pub(super) fn rev_arg(rev: &str) -> Res<String> {
    if rev.is_empty() || rev.starts_with('-') {
        return Err(format!("Invalid revision: {rev}"));
    }
    Ok(rev.to_string())
}

fn is_executable(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}

impl GitService {
    pub async fn reflog(&self, repo: &str, limit: Option<u32>) -> Res<Vec<ReflogEntry>> {
        let n = format!("-n{}", limit.unwrap_or(1000));
        let args = [a(&["log", "-g", "--date=unix"]), vec![format!("--format={REFLOG_FORMAT}"), n], a(&["HEAD", "--"])].concat();
        // a repository without commits has no HEAD reflog
        let r = self.read(repo, args, &[0, 128]).await?;
        Ok(if r.code == 0 { parse_reflog(&r.stdout) } else { vec![] })
    }

    /// The commit a revision points at, or None when it does not exist.
    pub async fn resolve_ref(&self, repo: &str, rev: &str) -> Res<Option<String>> {
        let r = self.read(repo, a(&["rev-parse", "--verify", "-q", &format!("{}^{{commit}}", rev_arg(rev)?)]), &[0, 1]).await?;
        Ok((r.code == 0).then(|| r.stdout.trim().to_string()))
    }

    /// Number of commits reachable from `include` but from none of `exclude`.
    pub async fn count_commits(&self, repo: &str, include: &str, exclude: Vec<String>) -> Res<u32> {
        let mut args = a(&["rev-list", "--count", &rev_arg(include)?]);
        if !exclude.is_empty() {
            args.push("--not".into());
            for e in &exclude {
                args.push(rev_arg(e)?);
            }
        }
        args.push("--".into());
        Ok(self.out(repo, args).await?.trim().parse().unwrap_or(0))
    }

    pub async fn branch_impact(&self, repo: &str, branch: &str) -> Res<BranchImpact> {
        let full = format!("refs/heads/{branch}");
        if self.resolve_ref(repo, &full).await?.is_none() {
            return Err(format!("Unknown branch: {branch}"));
        }
        let unmerged = if self.has_head(repo).await? {
            self.count_commits(repo, &full, vec!["HEAD".into()]).await?
        } else {
            self.count_commits(repo, &full, vec![]).await?
        };
        // --exclude patterns for --branches are relative to refs/heads/ (ref names cannot contain glob characters)
        let args = [
            a(&["rev-list", "--count", &full, "--not"]),
            vec![format!("--exclude={branch}")],
            a(&["--branches", "--remotes", "--tags", "--"]),
        ]
        .concat();
        let orphaned = self.out(repo, args).await?.trim().parse().unwrap_or(0);
        Ok(BranchImpact { unmerged, orphaned })
    }

    /// Lines and files that discarding the work-tree changes of `paths` would lose.
    pub async fn discard_impact(&self, repo: &str, paths: Vec<String>) -> Res<DiscardImpact> {
        let untracked = self.untracked(repo, &paths).await?;
        let tracked: Vec<String> = paths.into_iter().filter(|p| !untracked.contains(p)).collect();
        let mut res = DiscardImpact::default();
        for batch in tracked.chunks(PATH_BATCH) {
            let out = self.out(repo, [a(&["diff", "--numstat", "-z", "--no-renames", "--"]), batch.to_vec()].concat()).await?;
            for stat in parse_numstat_z(&out).values() {
                res.files += 1;
                res.additions += stat.additions as u32;
                res.deletions += stat.deletions as u32;
                res.binary += stat.binary as u32;
            }
        }
        for p in &untracked {
            res.files += 1;
            res.untracked += 1;
            let full = Path::new(repo).join(p);
            let small = tokio::fs::metadata(&full).await.map(|m| m.len() <= MAX_COUNTED_BYTES).unwrap_or(false);
            match tokio::fs::read(&full).await {
                Ok(bytes) if small && !bytes.iter().take(8000).any(|b| *b == 0) => {
                    let lines = bytes.iter().filter(|b| **b == b'\n').count();
                    res.additions += (lines + usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"))) as u32;
                }
                _ => res.binary += 1,
            }
        }
        Ok(res)
    }

    /// Record uncommitted changes to tracked files as a dangling stash commit, without touching the work tree.
    pub async fn snapshot(&self, repo: &str) -> Res<Option<String>> {
        let _g = self.lock(repo).await;
        let sha = self.write(repo, a(&["stash", "create", "Karen snapshot"])).await?.stdout.trim().to_string();
        Ok((!sha.is_empty()).then_some(sha))
    }

    async fn apply_stash_commit(&self, repo: &str, sha: &str) -> Res<()> {
        if self.write(repo, a(&["stash", "apply", "--index", sha])).await.is_err() {
            self.write(repo, a(&["stash", "apply", sha])).await?;
        }
        Ok(())
    }

    pub async fn apply_snapshot(&self, repo: &str, sha: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.apply_stash_commit(repo, &rev_arg(sha)?).await
    }

    /// Put a dropped stash commit back on the stash list (as stash@{0}).
    pub async fn stash_store(&self, repo: &str, sha: &str, message: &str) -> Res<()> {
        let _g = self.lock(repo).await;
        self.write(repo, a(&["stash", "store", "-m", message, &rev_arg(sha)?])).await?;
        Ok(())
    }

    /// Undo `git stash pop`: drop what the stash brought into the work tree, bring back the uncommitted
    /// changes from before (`snapshot`) and restore the stash entry.
    pub async fn undo_stash_pop(&self, repo: &str, sha: &str, message: &str, snapshot: Option<String>) -> Res<()> {
        let sha = rev_arg(sha)?;
        let _g = self.lock(repo).await;
        // untracked files saved with the stash live in its third parent
        let third = format!("{sha}^3");
        let untracked = if self.verify(repo, &third).await? {
            self.out(repo, a(&["ls-tree", "-r", "-z", "--name-only", &third])).await?
        } else {
            String::new()
        };
        self.write(repo, a(&["reset", "-q", "--hard", "HEAD"])).await?;
        for p in untracked.split('\0').filter(|p| !p.is_empty()) {
            let _ = tokio::fs::remove_file(Path::new(repo).join(p)).await;
        }
        if let Some(s) = snapshot {
            self.apply_stash_commit(repo, &rev_arg(&s)?).await?;
        }
        self.write(repo, a(&["stash", "store", "-m", message, &sha])).await?;
        Ok(())
    }

    /// Move a branch back to `sha`. The checked-out branch (or a detached HEAD, `branch` None) is reset with
    /// --keep, which refuses to overwrite uncommitted changes; any other branch is moved with update-ref.
    pub async fn restore_branch(&self, repo: &str, branch: Option<String>, sha: &str) -> Res<()> {
        let sha = rev_arg(sha)?;
        let _g = self.lock(repo).await;
        let current = self.current_branch(repo).await?;
        match branch {
            Some(b) if Some(&b) != current.as_ref() => {
                self.write(repo, a(&["update-ref", "-m", "Karen: undo", &format!("refs/heads/{b}"), &sha])).await?
            }
            _ => self.write(repo, a(&["reset", "-q", "--keep", &sha])).await?,
        };
        Ok(())
    }

    /// Save the current work-tree content of `paths` as blobs so restore_files can bring it back.
    /// Missing files are recorded as such; directories and symlinks are skipped.
    pub async fn backup_files(&self, repo: &str, paths: Vec<String>) -> Res<Vec<FileBackup>> {
        let mut res = Vec::new();
        let mut files = Vec::new();
        for p in paths {
            match tokio::fs::symlink_metadata(Path::new(repo).join(&p)).await {
                Err(_) => res.push(FileBackup { path: p, blob: None, executable: false }),
                Ok(m) if m.is_file() => files.push((p, is_executable(&m))),
                Ok(_) => {}
            }
        }
        for batch in files.chunks(PATH_BATCH) {
            let paths: Vec<String> = batch.iter().map(|(p, _)| p.clone()).collect();
            let out = self.out(repo, [a(&["hash-object", "-w", "--"]), paths].concat()).await?;
            for ((path, executable), blob) in batch.iter().zip(out.lines()) {
                res.push(FileBackup { path: path.clone(), blob: Some(blob.trim().to_string()), executable: *executable });
            }
        }
        Ok(res)
    }

    /// Write backed-up files back into the work tree (through a temporary index, so filters and the
    /// executable bit apply as on checkout) and delete the ones that did not exist.
    pub async fn restore_files(&self, repo: &str, backups: Vec<FileBackup>) -> Res<()> {
        let _g = self.lock(repo).await;
        let mut info = String::new();
        for b in &backups {
            match &b.blob {
                Some(blob) => {
                    let mode = if b.executable { "100755" } else { "100644" };
                    info.push_str(&format!("{mode} {}\t{}\0", rev_arg(blob)?, b.path));
                }
                None => {
                    let full = Path::new(repo).join(&b.path);
                    if tokio::fs::symlink_metadata(&full).await.map(|m| m.is_file()).unwrap_or(false) {
                        tokio::fs::remove_file(&full).await.map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        if info.is_empty() {
            return Ok(());
        }
        let dir = tempfile::Builder::new().prefix("karen-").tempdir().map_err(|e| e.to_string())?;
        let index = dir.path().join("index").to_string_lossy().into_owned();
        let opts = || Opts::default().env("GIT_INDEX_FILE", index.clone());
        let mut fill = opts();
        fill.input = Some(info.into_bytes());
        self.write_opts(repo, a(&["update-index", "-z", "--index-info"]), fill).await?;
        self.write_opts(repo, a(&["checkout-index", "-a", "-f"]), opts()).await?;
        Ok(())
    }

    /// Push a commit to a remote branch. With `lease`, the push is forced but only if the remote branch is
    /// still at that commit; without it, it only succeeds when it creates the branch or fast-forwards it.
    pub async fn push_sha(&self, repo: &str, remote: &str, sha: &str, branch: &str, lease: Option<String>) -> Res<()> {
        let _g = self.lock(repo).await;
        let target = format!("refs/heads/{branch}");
        let mut args = a(&["push", "--progress"]);
        if let Some(l) = lease {
            args.push(format!("--force-with-lease={target}:{}", rev_arg(&l)?));
        }
        args.extend([rev_arg(remote)?, format!("{}:{target}", rev_arg(sha)?)]);
        self.write_opts(repo, args, Opts::default().progress(self.progress(repo, "push"))).await?;
        Ok(())
    }
}
