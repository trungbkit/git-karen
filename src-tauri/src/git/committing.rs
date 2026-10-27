// Composing commits: the commit message template, recent authors for Co-authored-by trailers, commit signing
// (trying the configuration, reading a commit's signature) and the changes against HEAD that a split commit groups.
use std::path::{Path, PathBuf};

use super::exec::{git, Opts};
use super::parse::{parse_diff, US};
use super::recovery::rev_arg;
use super::service::{GitService, Res};
use crate::types::*;

/// Templates are prose; anything bigger is not one.
const MAX_TEMPLATE_BYTES: u64 = 64 * 1024;
const SIGNING_TEST_MESSAGE: &str = "Karen signing test";

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// `git log --format=%an%x1f%ae` -> authors, most commits first (ties keep the most recent first). People are told
/// apart by email (case-insensitive) and keep the name of their latest commit.
pub fn parse_authors(out: &str) -> Vec<Author> {
    let mut authors: Vec<Author> = Vec::new();
    for line in out.lines() {
        let Some((name, email)) = line.split_once(US) else { continue };
        let (name, email) = (name.trim(), email.trim());
        if email.is_empty() {
            continue;
        }
        match authors.iter_mut().find(|x| x.email.eq_ignore_ascii_case(email)) {
            Some(known) => known.commits += 1,
            None => authors.push(Author { name: name.into(), email: email.into(), commits: 1 }),
        }
    }
    // stable: equal counts stay in order of their latest commit
    authors.sort_by(|x, y| y.commits.cmp(&x.commits));
    authors
}

/// Signature format from a raw commit object (`git cat-file commit`), or None when it is not signed.
pub fn signature_format(raw: &str) -> Option<&'static str> {
    let mut lines = raw.lines().take_while(|l| !l.is_empty());
    let first = lines.find_map(|l| l.strip_prefix("gpgsig ").or_else(|| l.strip_prefix("gpgsig-sha256 ")))?;
    Some(if first.contains("SSH SIGNATURE") {
        "ssh"
    } else if first.contains("SIGNED MESSAGE") {
        "x509"
    } else {
        "openpgp"
    })
}

/// `git log -1 --format=%G?%x1f%GS%x1f%GK` -> (status, signer, key). Statuses follow git's %G? letters; a signature
/// git does not check (no key, no allowed signers file) is "unverified".
pub fn parse_signature_check(out: &str) -> (&'static str, Option<String>, Option<String>) {
    let mut f = out.trim_end_matches('\n').split(US);
    let status = match f.next().unwrap_or("").trim() {
        "G" => "good",
        "U" => "untrusted",
        "X" | "Y" => "expired",
        "R" => "revoked",
        "B" => "bad",
        _ => "unverified",
    };
    let field = |s: Option<&str>| s.map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    (status, field(f.next()), field(f.next()))
}

impl GitService {
    /// Contents of the file `commit.template` names (`~` expanded, relative paths from the repository root), or None.
    pub async fn commit_template(&self, repo: &str) -> Res<Option<String>> {
        let r = self.read(repo, a(&["config", "--path", "--get", "commit.template"]), &[0, 1]).await?;
        let path = r.stdout.trim();
        if r.code != 0 || path.is_empty() {
            return Ok(None);
        }
        let file = Path::new(repo).join(path);
        match tokio::fs::metadata(&file).await {
            Ok(m) if m.is_file() && m.len() <= MAX_TEMPLATE_BYTES => {}
            _ => return Ok(None),
        }
        Ok(tokio::fs::read_to_string(&file).await.ok().filter(|t| !t.trim().is_empty()))
    }

    /// Authors of the latest `limit` commits on local and remote branches (default 500).
    pub async fn recent_authors(&self, repo: &str, limit: Option<u32>) -> Res<Vec<Author>> {
        let n = format!("-n{}", limit.unwrap_or(500));
        let args = [a(&["log", "--branches", "--remotes", &n]), vec![format!("--format=%an{US}%ae")]].concat();
        // a repository without commits has no log
        let r = self.read(repo, args, &[0, 128]).await?;
        Ok(if r.code == 0 { parse_authors(&r.stdout) } else { vec![] })
    }

    /// Sign a throwaway commit object with the signing setup, overriding `gpg.format` and `user.signingkey` when given.
    /// Nothing points at the commit. Returns the signing format used. Without a repository a temporary one is used.
    pub async fn test_signing(&self, repo: Option<String>, format: Option<String>, key: Option<String>) -> Res<String> {
        let temp;
        let cwd = match repo.filter(|r| !r.is_empty()) {
            Some(r) => r,
            None => {
                temp = tempfile::Builder::new().prefix("karen-sign-").tempdir().map_err(|e| e.to_string())?;
                let path = temp.path().to_string_lossy().into_owned();
                git(temp.path(), &a(&["init", "-q"]), Opts::default()).await?;
                path
            }
        };
        let mut overrides = Vec::new();
        if let Some(f) = format.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
            if !matches!(f, "openpgp" | "ssh" | "x509") {
                return Err(format!("Unknown signing format: {f}"));
            }
            overrides.extend(a(&["-c", &format!("gpg.format={f}")]));
        }
        if let Some(k) = key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            overrides.extend(a(&["-c", &format!("user.signingKey={k}")]));
        }
        let cwd = Path::new(&cwd);
        let tree = git(cwd, &a(&["mktree"]), Opts { input: Some(vec![]), ..Default::default() }).await?.stdout.trim().to_string();
        let sign = [overrides.clone(), a(&["commit-tree", "-S", "-m", SIGNING_TEST_MESSAGE, &tree])].concat();
        git(cwd, &sign, Opts::default()).await?;
        let used = git(cwd, &[overrides, a(&["config", "--get", "gpg.format"])].concat(), Opts::read().ok(&[0, 1])).await?;
        Ok(Some(used.stdout.trim()).filter(|f| !f.is_empty()).unwrap_or("openpgp").to_string())
    }

    /// The signature of a commit, or None when it is unsigned. Only signed commits ask gpg/ssh to verify.
    pub async fn signature_status(&self, repo: &str, sha: &str) -> Res<Option<CommitSignature>> {
        let raw = self.out(repo, a(&["cat-file", "commit", &rev_arg(sha)?])).await?;
        let Some(format) = signature_format(&raw) else { return Ok(None) };
        let fmt = format!("--format=%G?{US}%GS{US}%GK");
        let out = self.read(repo, a(&["log", "-1", "--no-show-signature", &fmt, sha]), &[0, 1, 128]).await?;
        let (status, signer, key) = parse_signature_check(&out.stdout);
        Ok(Some(CommitSignature { status, format, signer, key }))
    }

    /// Every tracked file's staged and unstaged changes against HEAD, parsed. Untracked files are not included.
    pub async fn head_diff(&self, repo: &str) -> Res<Vec<FileDiff>> {
        if !self.has_head(repo).await? {
            return Err("The repository has no commits yet.".into());
        }
        let out = self.out(repo, a(&["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--patch", "HEAD", "--"])).await?;
        // combined diffs (unmerged files) can't be split into patches
        Ok(parse_diff(&out).into_iter().filter(|f| !f.header_lines.first().is_some_and(|h| !h.starts_with("diff --git "))).collect())
    }

    /// `git config --unset`; a key that is not set is not an error.
    pub async fn unset_config(&self, repo: Option<&str>, key: &str, global: bool) -> Res<()> {
        let mut args = a(&["config"]);
        if global || repo.is_none() {
            args.push("--global".into());
        }
        args.extend(a(&["--unset", key]));
        let cwd = repo.map(PathBuf::from).unwrap_or_else(|| std::env::home_dir().unwrap_or_else(|| PathBuf::from("/")));
        git(&cwd, &args, Opts::default().ok(&[0, 5])).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authors_are_grouped_by_email_and_ordered_by_commits() {
        let out = [
            "Ann\x1fann@x.io",
            "Bob\x1fbob@x.io",
            "Ann Old\x1fANN@x.io",
            "Cat\x1fcat@x.io",
            "Bob\x1fbob@x.io",
            "nobody\x1f",
            "garbage line",
        ]
        .join("\n");
        let authors = parse_authors(&out);
        let got: Vec<(&str, &str, u32)> = authors.iter().map(|x| (x.name.as_str(), x.email.as_str(), x.commits)).collect();
        assert_eq!(got, [("Ann", "ann@x.io", 2), ("Bob", "bob@x.io", 2), ("Cat", "cat@x.io", 1)]);
        assert!(parse_authors("").is_empty());
    }

    #[test]
    fn signature_format_comes_from_the_commit_header() {
        let commit = |sig: &str| format!("tree abc\nparent def\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n{sig}\nmessage gpgsig -----BEGIN SSH SIGNATURE-----\n");
        assert_eq!(signature_format(&commit("gpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n")), Some("openpgp"));
        assert_eq!(signature_format(&commit("gpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n")), Some("ssh"));
        assert_eq!(signature_format(&commit("gpgsig-sha256 -----BEGIN SIGNED MESSAGE-----\n")), Some("x509"));
        // a signature-looking line in the message is not a signature
        assert_eq!(signature_format(&commit("")), None);
    }

    #[test]
    fn signature_check_maps_git_status_letters() {
        assert_eq!(parse_signature_check("G\x1fAnn <ann@x.io>\x1fABCDEF\n"), ("good", Some("Ann <ann@x.io>".into()), Some("ABCDEF".into())));
        assert_eq!(parse_signature_check("U\x1f\x1fABCDEF").0, "untrusted");
        assert_eq!(parse_signature_check("Y\x1f\x1f").0, "expired");
        assert_eq!(parse_signature_check("R\x1f\x1f").0, "revoked");
        assert_eq!(parse_signature_check("B\x1fx\x1fy").0, "bad");
        assert_eq!(parse_signature_check("E\x1f\x1fKEY"), ("unverified", None, Some("KEY".into())));
        assert_eq!(parse_signature_check("N\x1f\x1f\n"), ("unverified", None, None));
    }
}
