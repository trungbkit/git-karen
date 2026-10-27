// Pure parsers for git's machine-readable output. No I/O here so they are easy to unit test.
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::types::{
    BlameLine, BlamePrevious, Commit, CommitStats, DiffHunk, DiffLine, FileChange, FileDiff, ReflogEntry, Remote, Signature, Stash,
    Submodule, WorkingStatus, Worktree, WorktreeChanges,
};

pub const RS: &str = "\x1e";
pub const US: &str = "\x1f";

/// `git log` format producing records parsed by parse_log. %B is last so it may contain anything but RS/US.
pub const LOG_FORMAT: &str = "\x1e%H\x1f%P\x1f%an\x1f%ae\x1f%at\x1f%cn\x1f%ce\x1f%ct\x1f%D\x1f%B";

pub const STASH_FORMAT: &str = "\x1e%H\x1f%P\x1f%gd\x1f%gs\x1f%ct";

/// `git log -g --date=unix` format parsed by parse_reflog: %gd then reads "HEAD@{<unix time>}".
pub const REFLOG_FORMAT: &str = "\x1e%H\x1f%gd\x1f%gs";

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}

re!(DIFF_GIT_RE, r#"^diff --git (?:"?a/(.*?)"?) (?:"?b/(.*?)"?)$"#);
re!(DIFF_PREFIX_RE, r"^diff --\S+ ");
re!(HUNK_RE, r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@");
re!(NUMSTAT_RE, r"(?s)^(-|\d+)\t(-|\d+)\t(.*)$");
re!(NUMSTAT_LINE_RE, r"^(-|\d+)\t(-|\d+)\t");
re!(STASH_INDEX_RE, r"\{(\d+)\}");
re!(REFLOG_SELECTOR_RE, r"^(.*)@\{(\d+)\}$");
re!(REMOTE_RE, r"^(\S+)\t(.+?) \((fetch|push)\)$");
re!(SUBMODULE_RE, r"^([ +\-U])([0-9a-f]+) (.+?)(?: \(.*\))?$");
re!(GITMODULES_RE, r"^submodule\.(.+)\.(path|url) (.*)$");
re!(BLAME_HEADER_RE, r"^([0-9a-f]{40}) (\d+) (\d+)");
re!(AB_RE, r"\+(\d+) -(\d+)");

fn num<T: std::str::FromStr + Default>(s: &str) -> T {
    s.trim().parse().unwrap_or_default()
}

pub fn parse_decorations(d: &str) -> Vec<String> {
    let mut refs = Vec::new();
    for part in d.split(", ") {
        let mut part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some(rest) = part.strip_prefix("HEAD -> ") {
            part = rest;
        } else if part == "HEAD" {
            refs.push("HEAD".to_string());
            continue;
        }
        if let Some(rest) = part.strip_prefix("tag: ") {
            part = rest;
        }
        if part == "refs/stash" || part.ends_with("/HEAD") {
            continue;
        }
        refs.push(part.to_string());
    }
    refs
}

pub fn split_message(raw: &str) -> (String, String) {
    let msg = raw.trim_end();
    match msg.find('\n') {
        None => (msg.to_string(), String::new()),
        Some(nl) => (msg[..nl].trim().to_string(), msg[nl + 1..].trim().to_string()),
    }
}

pub fn parse_log(out: &str) -> Vec<Commit> {
    let mut commits = Vec::new();
    for rec in out.split(RS) {
        if rec.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split(US).collect();
        if f.len() < 10 {
            continue;
        }
        let (summary, body) = split_message(&f[9..].join(US));
        let parents = f[1].trim();
        commits.push(Commit {
            sha: f[0].trim().to_string(),
            parents: if parents.is_empty() { vec![] } else { parents.split(' ').map(String::from).collect() },
            author: Signature { name: f[2].into(), email: f[3].into(), date: num::<i64>(f[4]) * 1000 },
            committer: Signature { name: f[5].into(), email: f[6].into(), date: num::<i64>(f[7]) * 1000 },
            summary,
            body,
            refs: parse_decorations(f[8]),
        });
    }
    commits
}

fn status_from_char(c: char) -> &'static str {
    match c {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        'U' => "conflicted",
        _ => "modified",
    }
}

/// Parse `git status --porcelain=v2 --branch -z -uall`. `operation` is filled in by the caller.
pub fn parse_status(out: &str) -> WorkingStatus {
    let mut st = WorkingStatus::default();
    let entries: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < entries.len() {
        let e = entries[i];
        i += 1;
        if e.is_empty() {
            continue;
        }
        if let Some(header) = e.strip_prefix("# ") {
            let (key, val) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => st.head_sha = if val == "(initial)" { None } else { Some(val.into()) },
                "branch.head" => {
                    if val == "(detached)" {
                        st.detached = true
                    } else {
                        st.branch = Some(val.into())
                    }
                }
                "branch.upstream" => st.upstream = Some(val.into()),
                "branch.ab" => {
                    if let Some(m) = AB_RE.captures(val) {
                        st.ahead = num(&m[1]);
                        st.behind = num(&m[2]);
                    }
                }
                _ => {}
            }
            continue;
        }
        match e.as_bytes()[0] {
            b'?' => st.unstaged.push(FileChange::new(e.get(2..).unwrap_or(""), "untracked")),
            t @ (b'1' | b'2') => {
                let parts: Vec<&str> = e.split(' ').collect();
                let field_count = if t == b'1' { 8 } else { 9 };
                let path = parts.get(field_count..).map(|p| p.join(" ")).unwrap_or_default();
                let mut old_path = None;
                if t == b'2' {
                    old_path = entries.get(i).map(|s| s.to_string());
                    i += 1;
                }
                let mut xy = parts.get(1).copied().unwrap_or("..").chars();
                let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                if x != '.' {
                    let mut f = FileChange::new(path.clone(), status_from_char(x));
                    if x == 'R' || x == 'C' {
                        f.old_path = old_path;
                    }
                    st.staged.push(f);
                }
                if y != '.' {
                    st.unstaged.push(FileChange::new(path, status_from_char(y)));
                }
            }
            b'u' => {
                let parts: Vec<&str> = e.split(' ').collect();
                let path = parts.get(10..).map(|p| p.join(" ")).unwrap_or_default();
                st.conflicted.push(FileChange::new(path, "conflicted"));
            }
            _ => {}
        }
    }
    st
}

fn unquote_c(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('"') | Some('\\') => out.push(chars.next().unwrap()),
                Some('t') => {
                    chars.next();
                    out.push('\t')
                }
                Some('n') => {
                    chars.next();
                    out.push('\n')
                }
                Some('r') => {
                    chars.next();
                    out.push('\r')
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn strip_prefix_path(p: &str, prefix: &str) -> String {
    let mut s = p.strip_suffix('\t').unwrap_or(p).to_string();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s = unquote_c(&s[1..s.len() - 1]);
    }
    match s.strip_prefix(prefix) {
        Some(rest) => rest.to_string(),
        None => s,
    }
}

/// Parse a unified diff (possibly several files).
pub fn parse_diff(out: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut lines: Vec<&str> = out.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut in_hunk = false;
    let mut old_line = 0u32;
    let mut new_line = 0u32;
    for line in lines {
        if line.starts_with("diff --git ") || line.starts_with("diff --cc ") || line.starts_with("diff --combined ") {
            let path = match DIFF_GIT_RE.captures(line) {
                Some(m) => m[2].to_string(),
                None => DIFF_PREFIX_RE.replace(line, "").into_owned(),
            };
            files.push(FileDiff { path, header_lines: vec![line.into()], ..Default::default() });
            in_hunk = false;
            continue;
        }
        let Some(file) = files.last_mut() else { continue };
        if line.starts_with("@@") {
            let Some(m) = HUNK_RE.captures(line) else {
                // combined diff hunks (@@@) are not supported for line staging
                file.hunks.push(DiffHunk {
                    header: line.into(),
                    old_start: 0,
                    old_lines: 0,
                    new_start: 0,
                    new_lines: 0,
                    lines: vec![],
                });
                in_hunk = true;
                continue;
            };
            old_line = num(&m[1]);
            new_line = num(&m[3]);
            file.hunks.push(DiffHunk {
                header: line.into(),
                old_start: old_line,
                old_lines: m.get(2).map_or(1, |g| num(g.as_str())),
                new_start: new_line,
                new_lines: m.get(4).map_or(1, |g| num(g.as_str())),
                lines: vec![],
            });
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            file.header_lines.push(line.into());
            if line.starts_with("new file mode") {
                file.is_new = Some(true);
            } else if line.starts_with("deleted file mode") {
                file.is_deleted = Some(true);
            } else if let Some(p) = line.strip_prefix("rename from ") {
                file.old_path = Some(p.into());
            } else if let Some(p) = line.strip_prefix("rename to ") {
                file.path = p.into();
            } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
                file.binary = true;
            } else if line.starts_with("+++ ") && line != "+++ /dev/null" {
                file.path = strip_prefix_path(&line[4..], "b/");
            } else if line.starts_with("--- ") && line != "--- /dev/null" {
                let p = strip_prefix_path(&line[4..], "a/");
                if p != file.path {
                    file.old_path = Some(p);
                }
            }
            continue;
        }
        let hunk = file.hunks.last_mut().expect("in_hunk implies a hunk");
        let mut chars = line.chars();
        let c = chars.next();
        let content = chars.as_str().to_string();
        let dl = match c {
            Some('+') => {
                new_line += 1;
                DiffLine { kind: "add", content, old_line: None, new_line: Some(new_line - 1) }
            }
            Some('-') => {
                old_line += 1;
                DiffLine { kind: "del", content, old_line: Some(old_line - 1), new_line: None }
            }
            Some('\\') => DiffLine { kind: "meta", content: line.into(), old_line: None, new_line: None },
            _ => {
                old_line += 1;
                new_line += 1;
                DiffLine { kind: "context", content, old_line: Some(old_line - 1), new_line: Some(new_line - 1) }
            }
        };
        hunk.lines.push(dl);
    }
    files
}

/// Parse `git diff-tree -r -z -M --name-status`
pub fn parse_name_status_z(out: &str) -> Vec<FileChange> {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let code = parts[i];
        i += 1;
        let Some(c) = code.chars().next() else { continue };
        let take = |i: &mut usize| {
            let v = parts.get(*i).copied().unwrap_or("").to_string();
            *i += 1;
            v
        };
        if c == 'R' || c == 'C' {
            let old_path = take(&mut i);
            let path = take(&mut i);
            files.push(FileChange { old_path: Some(old_path), ..FileChange::new(path, status_from_char(c)) });
        } else {
            files.push(FileChange::new(take(&mut i), status_from_char(c)));
        }
    }
    files
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NumStat {
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

/// Parse `--numstat -z` into a map keyed by (new) path.
pub fn parse_numstat_z(out: &str) -> HashMap<String, NumStat> {
    let mut map = HashMap::new();
    let parts: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let rec = parts[i];
        i += 1;
        if rec.is_empty() {
            continue;
        }
        let Some(m) = NUMSTAT_RE.captures(rec) else { continue };
        let mut path = m[3].to_string();
        if path.is_empty() {
            // rename: old\0new follow
            path = parts.get(i + 1).copied().unwrap_or("").to_string();
            i += 2;
        }
        let binary = &m[1] == "-";
        map.insert(
            path,
            NumStat {
                additions: if binary { 0 } else { num(&m[1]) },
                deletions: if binary { 0 } else { num(&m[2]) },
                binary,
            },
        );
    }
    map
}

pub fn parse_stashes(out: &str) -> Vec<Stash> {
    let mut res: Vec<Stash> = Vec::new();
    for rec in out.split(RS) {
        if rec.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split(US).collect();
        let get = |i: usize| f.get(i).copied().unwrap_or("");
        let reference = get(2);
        let index = STASH_INDEX_RE.captures(reference).map_or(res.len() as u32, |m| num(&m[1]));
        res.push(Stash {
            index,
            reference: reference.trim().into(),
            sha: get(0).trim().into(),
            message: get(3).trim().into(),
            date: num::<i64>(get(4)) * 1000,
            base_sha: get(1).trim().split(' ').next().unwrap_or("").into(),
        });
    }
    res
}

/// Reflog records, newest first. "checkout: moving from a to b" splits into action "checkout" and its message.
pub fn parse_reflog(out: &str) -> Vec<ReflogEntry> {
    let mut res: Vec<ReflogEntry> = Vec::new();
    for rec in out.split(RS) {
        if rec.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split(US).collect();
        let get = |i: usize| f.get(i).copied().unwrap_or("").trim();
        let (name, date) = REFLOG_SELECTOR_RE
            .captures(get(1))
            .map_or(("HEAD".to_string(), 0), |m| (m[1].to_string(), num::<i64>(&m[2]) * 1000));
        let (action, message) = get(2).split_once(": ").unwrap_or((get(2), ""));
        let index = res.len() as u32;
        res.push(ReflogEntry {
            index,
            selector: format!("{name}@{{{index}}}"),
            sha: get(0).into(),
            action: action.into(),
            message: message.into(),
            date,
        });
    }
    res
}

pub fn parse_remotes(out: &str) -> Vec<Remote> {
    let mut res: Vec<Remote> = Vec::new();
    for line in out.split('\n') {
        let Some(m) = REMOTE_RE.captures(line) else { continue };
        let idx = match res.iter().position(|r| r.name == m[1]) {
            Some(i) => i,
            None => {
                res.push(Remote { name: m[1].into(), fetch_url: String::new(), push_url: String::new() });
                res.len() - 1
            }
        };
        if &m[3] == "fetch" {
            res[idx].fetch_url = m[2].into();
        } else {
            res[idx].push_url = m[2].into();
        }
    }
    res
}

pub fn parse_worktrees(out: &str) -> Vec<Worktree> {
    let mut res: Vec<Worktree> = Vec::new();
    for block in out.split("\n\n") {
        if block.trim().is_empty() {
            continue;
        }
        let mut wt = Worktree { is_main: res.is_empty(), ..Default::default() };
        for line in block.split('\n') {
            let (key, val) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => wt.path = val.into(),
                "HEAD" => wt.head = val.into(),
                "branch" => wt.branch = Some(val.strip_prefix("refs/heads/").unwrap_or(val).into()),
                "detached" => wt.detached = true,
                "locked" => {
                    wt.locked = true;
                    wt.lock_reason = Some(val.to_string()).filter(|r| !r.is_empty());
                }
                "prunable" => wt.prunable = true,
                _ => {}
            }
        }
        res.push(wt);
    }
    res
}

/// Per-file change kinds of a status, counted the way the graph's WIP row shows them.
pub fn worktree_changes(st: &WorkingStatus) -> WorktreeChanges {
    let mut kinds: HashMap<&str, &str> = HashMap::new();
    for f in st.unstaged.iter().chain(&st.staged) {
        kinds.insert(f.path.as_str(), f.status);
    }
    let mut c = WorktreeChanges { conflicted: st.conflicted.len() as u32, ..Default::default() };
    for k in kinds.values() {
        match *k {
            "added" | "untracked" => c.added += 1,
            "deleted" => c.deleted += 1,
            _ => c.modified += 1,
        }
    }
    c
}

pub struct ModuleInfo {
    pub name: String,
    pub url: String,
}

/// Parse `git submodule status` combined with `.gitmodules` (path -> {name,url}).
pub fn parse_submodules(out: &str, modules: &HashMap<String, ModuleInfo>) -> Vec<Submodule> {
    let mut res = Vec::new();
    for line in out.split('\n') {
        let Some(m) = SUBMODULE_RE.captures(line) else { continue };
        let path = m[3].to_string();
        let info = modules.get(&path);
        let state = match &m[1] {
            "-" => "uninitialized",
            "+" => "modified",
            "U" => "conflict",
            _ => "clean",
        };
        res.push(Submodule {
            name: info.map_or_else(|| path.clone(), |i| i.name.clone()),
            url: info.map(|i| i.url.clone()).unwrap_or_default(),
            path,
            sha: m[2].into(),
            state,
        });
    }
    res
}

/// Parse `git config -f .gitmodules --get-regexp ^submodule\.`
pub fn parse_gitmodules(out: &str) -> HashMap<String, ModuleInfo> {
    let mut by_name: Vec<(String, Option<String>, Option<String>)> = Vec::new();
    for line in out.split('\n') {
        let Some(m) = GITMODULES_RE.captures(line) else { continue };
        let idx = match by_name.iter().position(|e| e.0 == m[1]) {
            Some(i) => i,
            None => {
                by_name.push((m[1].into(), None, None));
                by_name.len() - 1
            }
        };
        if &m[2] == "path" {
            by_name[idx].1 = Some(m[3].into());
        } else {
            by_name[idx].2 = Some(m[3].into());
        }
    }
    by_name
        .into_iter()
        .filter_map(|(name, path, url)| path.map(|p| (p, ModuleInfo { name, url: url.unwrap_or_default() })))
        .collect()
}

/// Parses `git blame --porcelain`. Commit details (and `previous`) are printed only the first time a commit
/// appears; `filename` is repeated only when the commit's lines come from more than one path (`-C`).
pub fn parse_blame_porcelain(out: &str) -> Vec<BlameLine> {
    struct Meta {
        author: String,
        date: i64,
        summary: String,
        previous: Option<BlamePrevious>,
        path: String,
    }
    let mut info: HashMap<String, Meta> = HashMap::new();
    let mut res = Vec::new();
    // sha, line in the commit, line in the final file
    let mut cur: Option<(String, u32, u32)> = None;
    let (mut author, mut date, mut summary, mut previous, mut path): (
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<BlamePrevious>,
        Option<String>,
    ) = (None, None, None, None, None);
    for l in out.split('\n') {
        let Some((sha, orig_line, line)) = &cur else {
            if let Some(m) = BLAME_HEADER_RE.captures(l) {
                cur = Some((m[1].to_string(), num(&m[2]), num(&m[3])));
                (author, date, summary, previous, path) = (None, None, None, None, None);
            }
            continue;
        };
        if let Some(content) = l.strip_prefix('\t') {
            let meta = info.entry(sha.clone()).or_insert_with(|| Meta {
                author: author.take().unwrap_or_default(),
                date: date.unwrap_or(0),
                summary: summary.take().unwrap_or_default(),
                previous: previous.take(),
                path: String::new(),
            });
            if let Some(p) = path.take() {
                meta.path = p;
            }
            res.push(BlameLine {
                sha: sha.clone(),
                author: meta.author.clone(),
                date: meta.date,
                summary: meta.summary.clone(),
                line: *line,
                content: content.into(),
                orig_line: *orig_line,
                path: meta.path.clone(),
                previous: meta.previous.clone(),
            });
            cur = None;
        } else if let Some(v) = l.strip_prefix("author ") {
            author = Some(v.into());
        } else if let Some(v) = l.strip_prefix("author-time ") {
            date = Some(num::<i64>(v) * 1000);
        } else if let Some(v) = l.strip_prefix("summary ") {
            summary = Some(v.into());
        } else if let Some(v) = l.strip_prefix("previous ") {
            // "previous <sha> <path>": the path may contain spaces
            if let Some((sha, p)) = v.split_once(' ') {
                previous = Some(BlamePrevious { sha: sha.into(), path: unquote_path(p) });
            }
        } else if let Some(v) = l.strip_prefix("filename ") {
            path = Some(unquote_path(v));
        }
    }
    res
}

/// A path as git prints it in porcelain output: quoted C-style when it has unusual characters.
fn unquote_path(p: &str) -> String {
    match p.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        Some(inner) => unquote_c(inner),
        None => p.to_string(),
    }
}

/// The followed file's path in each commit of `git log --follow --name-status -z --format=%x1e%H`, newest first.
/// Returns (sha, path, old path when the commit renamed or copied it). Commits without a status (merges) keep
/// the path of the newer commit before them.
pub fn parse_follow_paths(out: &str, path: &str) -> Vec<(String, String, Option<String>)> {
    let mut current = path.to_string();
    let mut res = Vec::new();
    for record in out.split(RS) {
        let mut fields = record.split('\0').map(|f| f.trim_start_matches('\n'));
        let sha = fields.next().unwrap_or("").trim();
        if sha.is_empty() {
            continue;
        }
        let status = fields.next().unwrap_or("");
        let (path, old) = match status.chars().next() {
            Some('R') | Some('C') => {
                let old = fields.next().unwrap_or("").to_string();
                let new = fields.next().unwrap_or("").to_string();
                (new, Some(old).filter(|o| !o.is_empty()))
            }
            Some(_) => (fields.next().map(String::from).filter(|p| !p.is_empty()).unwrap_or_else(|| current.clone()), None),
            None => (current.clone(), None),
        };
        // older commits know the file by the name it had before the rename or copy
        current = old.clone().unwrap_or_else(|| path.clone());
        res.push((sha.to_string(), path, old));
    }
    res
}

/// Parses `git log --numstat --format=<RS>%H` output into per-commit line and file counts.
pub fn parse_commit_stats(out: &str) -> HashMap<String, CommitStats> {
    let mut res = HashMap::new();
    for block in out.split(RS) {
        let mut lines = block.split('\n');
        let sha = lines.next().unwrap_or("").trim();
        if sha.is_empty() {
            continue;
        }
        let mut stats = CommitStats::default();
        for line in lines {
            let Some(m) = NUMSTAT_LINE_RE.captures(line) else { continue };
            stats.files += 1;
            if &m[1] != "-" {
                stats.additions += num::<u64>(&m[1]);
            }
            if &m[2] != "-" {
                stats.deletions += num::<u64>(&m[2]);
            }
        }
        res.insert(sha.to_string(), stats);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflog_entries_with_actions_and_dates() {
        let out = [
            "\x1eaaa\x1fHEAD@{1700000100}\x1fcheckout: moving from main to dev\n",
            "\x1ebbb\x1fHEAD@{1700000050}\x1fcommit (amend): fix: a: b\n",
            "\x1eccc\x1fHEAD@{1700000000}\x1freset\n",
        ]
        .concat();
        let r = parse_reflog(&out);
        assert_eq!(r.len(), 3);
        assert_eq!(
            r[0],
            ReflogEntry {
                index: 0,
                selector: "HEAD@{0}".into(),
                sha: "aaa".into(),
                action: "checkout".into(),
                message: "moving from main to dev".into(),
                date: 1_700_000_100_000,
            }
        );
        assert_eq!((r[1].action.as_str(), r[1].message.as_str()), ("commit (amend)", "fix: a: b"));
        assert_eq!((r[2].selector.as_str(), r[2].action.as_str(), r[2].message.as_str()), ("HEAD@{2}", "reset", ""));
        assert!(parse_reflog("").is_empty());
    }

    #[test]
    fn decorations_normalise_head_and_tags() {
        assert_eq!(
            parse_decorations(
                "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/stash"
            ),
            vec!["refs/heads/main", "refs/tags/v1", "refs/remotes/origin/main"]
        );
        assert_eq!(parse_decorations("HEAD"), vec!["HEAD"]);
    }

    #[test]
    fn status_porcelain_v2() {
        let out = [
            "# branch.oid 1234567890123456789012345678901234567890",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
            "1 .M N... 100644 100644 100644 aaa bbb dir/with space.txt",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt",
            "old.txt",
            "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
            "? untracked.txt",
            "",
        ]
        .join("\0");
        let st = parse_status(&out);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(
            st.staged,
            vec![
                FileChange::new("staged.txt", "modified"),
                FileChange { old_path: Some("old.txt".into()), ..FileChange::new("new.txt", "renamed") }
            ]
        );
        assert_eq!(
            st.unstaged,
            vec![FileChange::new("dir/with space.txt", "modified"), FileChange::new("untracked.txt", "untracked")]
        );
        assert_eq!(st.conflicted, vec![FileChange::new("conflict.txt", "conflicted")]);
    }

    #[test]
    fn status_unborn_branch() {
        let st = parse_status("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(st.head_sha, None);
        assert_eq!(st.branch.as_deref(), Some("main"));
    }

    #[test]
    fn diff_hunks_with_line_numbers() {
        let diff = [
            "diff --git a/f.txt b/f.txt",
            "index 1..2 100644",
            "--- a/f.txt",
            "+++ b/f.txt",
            "@@ -1,3 +1,3 @@ ctx",
            " a",
            "-b",
            "+B",
            " c",
            "\\ No newline at end of file",
            "",
        ]
        .join("\n");
        let files = parse_diff(&diff);
        let f = &files[0];
        assert_eq!(f.path, "f.txt");
        assert_eq!(f.header_lines.len(), 4);
        assert_eq!(f.hunks.len(), 1);
        let h = &f.hunks[0];
        assert_eq!((h.old_start, h.old_lines, h.new_start, h.new_lines), (1, 3, 1, 3));
        assert_eq!(h.lines.iter().map(|l| l.kind).collect::<Vec<_>>(), ["context", "del", "add", "context", "meta"]);
        assert_eq!(h.lines[2], DiffLine { kind: "add", content: "B".into(), old_line: None, new_line: Some(2) });
    }

    #[test]
    fn diff_new_binary_and_renamed() {
        let diff = [
            "diff --git a/a.bin b/a.bin",
            "new file mode 100644",
            "Binary files /dev/null and b/a.bin differ",
            "diff --git a/old.txt b/new.txt",
            "similarity index 100%",
            "rename from old.txt",
            "rename to new.txt",
            "",
        ]
        .join("\n");
        let files = parse_diff(&diff);
        assert_eq!(files[0].is_new, Some(true));
        assert!(files[0].binary);
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[1].old_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn numstat_renames_and_binaries() {
        let m = parse_numstat_z("1\t2\ta.txt\0-\t-\tb.png\03\t0\t\0old.txt\0new.txt\0");
        assert_eq!(m["a.txt"], NumStat { additions: 1, deletions: 2, binary: false });
        assert!(m["b.png"].binary);
        assert_eq!(m["new.txt"], NumStat { additions: 3, deletions: 0, binary: false });
    }

    #[test]
    fn worktree_porcelain_blocks() {
        let wts = parse_worktrees(
            "worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\nlocked reason\n\n",
        );
        assert_eq!(wts.len(), 2);
        assert_eq!((wts[0].path.as_str(), wts[0].is_main, wts[0].branch.as_deref()), ("/a", true, Some("main")));
        assert_eq!((wts[1].path.as_str(), wts[1].is_main, wts[1].detached, wts[1].locked), ("/b", false, true, true));
        assert_eq!((wts[0].lock_reason.as_deref(), wts[1].lock_reason.as_deref()), (None, Some("reason")));
    }

    #[test]
    fn log_records_and_messages() {
        let out = format!(
            "{RS}abc{US}p1 p2{US}A{US}a@x{US}10{US}C{US}c@x{US}20{US}HEAD -> refs/heads/main{US}subject\n\n  body line\n\n"
        );
        let c = &parse_log(&out)[0];
        assert_eq!(c.parents, vec!["p1", "p2"]);
        assert_eq!((c.summary.as_str(), c.body.as_str()), ("subject", "body line"));
        assert_eq!((c.author.date, c.committer.date), (10_000, 20_000));
        assert_eq!(c.refs, vec!["refs/heads/main"]);
    }

    #[test]
    fn serializes_to_typescript_shapes() {
        let f = FileChange { old_path: Some("o".into()), ..FileChange::new("p", "renamed") };
        assert_eq!(serde_json::to_string(&f).unwrap(), r#"{"path":"p","oldPath":"o","status":"renamed"}"#);
        let st = parse_status("# branch.oid (initial)\0");
        let v = serde_json::to_value(&st).unwrap();
        assert!(v["branch"].is_null() && v["headSha"].is_null() && v["operation"].is_null());
        assert!(v.get("upstream").is_none());
    }

    #[test]
    fn blame_lines_carry_paths_and_the_previous_commit() {
        let (a, b) = ("a".repeat(40), "b".repeat(40));
        let out = [
            format!("{a} 1 1 2"),
            "author Ann".into(),
            "author-time 10".into(),
            "summary first".into(),
            "boundary".into(),
            "filename old name.txt".into(),
            "\tone".into(),
            format!("{a} 2 2"),
            "\ttwo".into(),
            format!("{b} 2 3 1"),
            "author Bob".into(),
            "author-time 20".into(),
            "summary renamed and changed".into(),
            format!("previous {a} old name.txt"),
            "filename \"new\\tname.txt\"".into(),
            "\tTHREE".into(),
            String::new(),
        ]
        .join("\n");
        let lines = parse_blame_porcelain(&out);
        let got: Vec<_> = lines.iter().map(|l| (l.line, l.orig_line, l.path.as_str(), l.content.as_str(), l.author.as_str())).collect();
        assert_eq!(
            got,
            [(1, 1, "old name.txt", "one", "Ann"), (2, 2, "old name.txt", "two", "Ann"), (3, 2, "new\tname.txt", "THREE", "Bob")]
        );
        assert_eq!(lines[0].previous, None);
        assert_eq!(lines[2].previous, Some(BlamePrevious { sha: a.clone(), path: "old name.txt".into() }));
        assert_eq!(lines[2].date, 20_000);
        let v = serde_json::to_value(&lines[2]).unwrap();
        assert_eq!((v["origLine"].as_u64(), v["previous"]["path"].as_str()), (Some(2), Some("old name.txt")));
        assert!(serde_json::to_value(&lines[0]).unwrap().get("previous").is_none());
    }

    #[test]
    fn follow_paths_track_renames_back_in_time() {
        let rec = |sha: &str, fields: &[&str]| format!("\x1e{sha}\0\n{}\0", fields.join("\0"));
        let out = [
            rec("4", &["M", "b c.txt"]),
            format!("\x1e3\0"), // a merge: no status
            rec("2", &["R100", "a.txt", "b c.txt"]),
            rec("1", &["A", "a.txt"]),
        ]
        .concat();
        assert_eq!(
            parse_follow_paths(&out, "b c.txt"),
            [
                ("4".to_string(), "b c.txt".to_string(), None),
                ("3".into(), "b c.txt".into(), None),
                ("2".into(), "b c.txt".into(), Some("a.txt".to_string())),
                ("1".into(), "a.txt".into(), None),
            ]
        );
        // following a copy continues with the original file
        let copied = [rec("3", &["C075", "src.txt", "dst.txt"]), format!("\x1e2\0"), rec("1", &["A", "src.txt"])].concat();
        let paths: Vec<_> = parse_follow_paths(&copied, "dst.txt").into_iter().map(|(_, p, _)| p).collect();
        assert_eq!(paths, ["dst.txt", "src.txt", "src.txt"]);
    }
}
