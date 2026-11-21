// Checks for strings that reach git as positional arguments. They come from the renderer over IPC or from a hosting
// API, so none of them may be read as an option ("--upload-pack=...", "-f"). Paths go after `--` instead.
use super::service::Res;

fn plain(value: &str, what: &str) -> Res<()> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(format!("Invalid {what}: {value}"));
    }
    Ok(())
}

/// A revision: a sha, a ref name, `HEAD~2`, `stash@{0}`, `a..b`.
pub fn rev_arg(rev: &str) -> Res<String> {
    plain(rev, "revision")?;
    Ok(rev.to_string())
}

pub fn branch_name(name: &str) -> Res<&str> {
    plain(name, "branch name").map(|_| name)
}

pub fn tag_name(name: &str) -> Res<&str> {
    plain(name, "tag name").map(|_| name)
}

pub fn remote_name(name: &str) -> Res<&str> {
    plain(name, "remote name").map(|_| name)
}

/// A remote URL or path (`https://…`, `git@host:repo`, `../sibling.git`).
pub fn remote_url(url: &str) -> Res<&str> {
    plain(url, "remote URL").map(|_| url)
}

pub fn config_key(key: &str) -> Res<&str> {
    plain(key, "config key").map(|_| key)
}

/// A path or pattern that git takes positionally where `--` cannot separate it (worktree paths, LFS patterns).
pub fn path_arg(path: &str) -> Res<&str> {
    plain(path, "path").map(|_| path)
}

/// The object `rev:path`; an empty `rev` is the index (`:path`), anything else must be a revision.
pub fn object_arg(rev: &str, path: &str) -> Res<String> {
    if rev.is_empty() {
        return Ok(format!(":{path}"));
    }
    Ok(format!("{}:{path}", rev_arg(rev)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_names_and_revisions() {
        for rev in ["HEAD", "HEAD~2", "main", "origin/main", "feature/a-b", "v1.0", "stash@{0}", "a1b2c3d", "main..topic"] {
            assert_eq!(rev_arg(rev).unwrap(), rev);
        }
        assert_eq!(branch_name("feature/x-1").unwrap(), "feature/x-1");
        assert_eq!(remote_url("git@github.com:o/r.git").unwrap(), "git@github.com:o/r.git");
        assert_eq!(remote_url("../sibling.git").unwrap(), "../sibling.git");
        assert_eq!(object_arg("", "a.txt").unwrap(), ":a.txt");
        assert_eq!(object_arg("HEAD~1", "-odd.txt").unwrap(), "HEAD~1:-odd.txt");
    }

    #[test]
    fn rejects_options_empty_values_and_control_characters() {
        type Check = fn(&str) -> Res<()>;
        let checks: [(&str, Check); 7] = [
            ("revision", |s| rev_arg(s).map(drop)),
            ("branch name", |s| branch_name(s).map(drop)),
            ("tag name", |s| tag_name(s).map(drop)),
            ("remote name", |s| remote_name(s).map(drop)),
            ("remote URL", |s| remote_url(s).map(drop)),
            ("config key", |s| config_key(s).map(drop)),
            ("path", |s| path_arg(s).map(drop)),
        ];
        for (what, check) in checks {
            for bad in ["", "-f", "--upload-pack=touch x", "a\nb", "a\0b"] {
                assert_eq!(check(bad), Err(format!("Invalid {what}: {bad}")), "{what} {bad:?}");
            }
        }
        assert_eq!(object_arg("--output=x", "a"), Err("Invalid revision: --output=x".into()));
    }
}
