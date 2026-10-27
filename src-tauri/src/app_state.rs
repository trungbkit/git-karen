// Persistent app state (recent repos, open tabs, preferences) stored as JSON in the app data folder.
// Preferences are kept as an open JSON object: defaults and the allowed keys live in src/shared/types.ts,
// and the renderer bridge merges/filters them, so the TypeScript contract stays the single source of truth.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const MAX_RECENT: usize = 30;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
}

/// A named list of repositories shown together in the workspace view.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Workspace {
    pub name: String,
    pub repos: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub recent: Vec<RecentRepo>,
    pub open_tabs: Vec<String>,
    pub active_tab: Option<String>,
    pub preferences: Map<String, Value>,
    pub workspaces: Vec<Workspace>,
}

fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub struct AppStateStore {
    file: PathBuf,
    state: AppState,
}

impl AppStateStore {
    pub fn new(file: PathBuf) -> Self {
        let state = Self::load(&file);
        AppStateStore { file, state }
    }

    fn load(file: &Path) -> AppState {
        let raw: Value = std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let strings = |v: &Value| -> Vec<String> {
            v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
        };
        AppState {
            recent: raw["recent"]
                .as_array()
                .map(|a| a.iter().filter_map(|r| serde_json::from_value(r.clone()).ok()).collect())
                .unwrap_or_default(),
            open_tabs: strings(&raw["openTabs"]),
            active_tab: raw["activeTab"].as_str().map(String::from),
            preferences: raw["preferences"].as_object().cloned().unwrap_or_default(),
            workspaces: raw["workspaces"]
                .as_array()
                .map(|a| a.iter().filter_map(|w| serde_json::from_value(w.clone()).ok()).collect())
                .unwrap_or_default(),
        }
    }

    fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&self.state).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }

    pub fn get(&self) -> AppState {
        self.state.clone()
    }

    pub fn preference_str(&self, key: &str) -> Option<String> {
        self.state.preferences.get(key).and_then(Value::as_str).map(String::from)
    }

    pub fn set_open_tabs(&mut self, tabs: Vec<String>, active: Option<String>) -> Result<(), String> {
        self.state.open_tabs = tabs;
        self.state.active_tab = active;
        self.save()
    }

    pub fn add_recent(&mut self, path: &str) -> Result<Vec<RecentRepo>, String> {
        let favorite = self.state.recent.iter().find(|r| r.path == path).and_then(|r| r.favorite);
        let entry = RecentRepo { path: path.into(), name: basename(path), last_opened: now_ms(), favorite };
        let mut all: Vec<RecentRepo> = std::iter::once(entry)
            .chain(self.state.recent.iter().filter(|r| r.path != path).cloned())
            .collect();
        all.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
        // favorites are never evicted
        let mut kept = 0;
        all.retain(|r| {
            if r.favorite == Some(true) {
                return true;
            }
            kept += 1;
            kept <= MAX_RECENT
        });
        self.state.recent = all;
        self.save()?;
        Ok(self.state.recent.clone())
    }

    pub fn toggle_favorite(&mut self, path: &str) -> Result<Vec<RecentRepo>, String> {
        match self.state.recent.iter_mut().find(|r| r.path == path) {
            Some(r) => r.favorite = Some(r.favorite != Some(true)),
            None => self.state.recent.push(RecentRepo {
                path: path.into(),
                name: basename(path),
                last_opened: now_ms(),
                favorite: Some(true),
            }),
        }
        self.save()?;
        Ok(self.state.recent.clone())
    }

    pub fn remove_recent(&mut self, path: &str) -> Result<Vec<RecentRepo>, String> {
        self.state.recent.retain(|r| r.path != path);
        self.save()?;
        Ok(self.state.recent.clone())
    }

    pub fn set_preferences(&mut self, prefs: Map<String, Value>) -> Result<Map<String, Value>, String> {
        self.state.preferences.extend(prefs);
        self.save()?;
        Ok(self.state.preferences.clone())
    }

    /// Replace every workspace; names are trimmed and must be unique, repo paths are kept once each.
    pub fn set_workspaces(&mut self, workspaces: Vec<Workspace>) -> Result<Vec<Workspace>, String> {
        let mut names = std::collections::HashSet::new();
        let mut clean = Vec::new();
        for w in workspaces {
            let name = w.name.trim().to_string();
            if name.is_empty() || !names.insert(name.clone()) {
                return Err(format!("Workspace names must be unique and not empty: \"{name}\""));
            }
            let mut seen = std::collections::HashSet::new();
            let repos = w.repos.into_iter().filter(|r| !r.is_empty() && seen.insert(r.clone())).collect();
            clean.push(Workspace { name, repos });
        }
        self.state.workspaces = clean;
        self.save()?;
        Ok(self.state.workspaces.clone())
    }
}

/// A repository found by `discover_repos`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRepo {
    pub path: String,
    pub name: String,
    /// Last change to its index or HEAD (ms), 0 when unknown
    pub modified: i64,
}

/// How far below a scan folder repositories are looked for (folder/a/b is two levels).
pub const DISCOVER_DEPTH: usize = 2;
/// Bounds that keep a scan of a huge folder (or of the whole home folder) quick.
const DISCOVER_MAX_DIRS: usize = 5000;
const DISCOVER_MAX_REPOS: usize = 300;

/// `~` and `~/x` relative to `home`; other paths are kept as they are.
fn expand_home(dir: &str, home: Option<&Path>) -> Option<PathBuf> {
    let dir = dir.trim();
    if dir.is_empty() {
        return None;
    }
    match (dir.strip_prefix('~'), home) {
        (Some(""), Some(h)) => Some(h.to_path_buf()),
        (Some(rest), Some(h)) if rest.starts_with('/') || rest.starts_with('\\') => Some(h.join(&rest[1..])),
        (Some(_), _) => None,
        (None, _) => Some(PathBuf::from(dir)),
    }
}

fn mtime_ms(p: &Path) -> Option<i64> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// Repositories in `dirs` and up to `DISCOVER_DEPTH` levels below them, most recently changed first.
/// A repository's own subfolders are not searched; hidden folders, node_modules and symlinks are skipped.
pub fn discover_repos(dirs: &[String], home: Option<&Path>) -> Vec<DiscoveredRepo> {
    discover_repos_bounded(dirs, home, DISCOVER_MAX_DIRS, DISCOVER_MAX_REPOS)
}

fn discover_repos_bounded(dirs: &[String], home: Option<&Path>, max_dirs: usize, max_repos: usize) -> Vec<DiscoveredRepo> {
    let mut seen = std::collections::HashSet::new();
    let mut found = Vec::new();
    let mut visited = 0usize;
    let mut queue: std::collections::VecDeque<(PathBuf, usize)> =
        dirs.iter().filter_map(|d| expand_home(d, home)).filter(|p| p.is_dir()).map(|p| (p, 0)).collect();
    while let Some((dir, depth)) = queue.pop_front() {
        if visited >= max_dirs || found.len() >= max_repos {
            break;
        }
        visited += 1;
        let dot_git = dir.join(".git");
        if dot_git.exists() {
            let path = std::fs::canonicalize(&dir).unwrap_or(dir.clone());
            let key = path.to_string_lossy().into_owned();
            if seen.insert(key.clone()) {
                let modified = [dot_git.join("index"), dot_git.join("HEAD"), dot_git.clone()]
                    .iter()
                    .filter_map(|p| mtime_ms(p))
                    .max()
                    .unwrap_or(0);
                found.push(DiscoveredRepo { name: basename(&key), path: key, modified });
            }
            continue;
        }
        if depth >= DISCOVER_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut children: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            // DirEntry::file_type does not follow symlinks, so linked folders (and loops) are left out
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                !name.starts_with('.') && name != "node_modules"
            })
            .map(|e| e.path())
            .collect();
        children.sort();
        queue.extend(children.into_iter().map(|c| (c, depth + 1)));
    }
    found.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    found
}

/// Spawn a detached GUI process, returning once it started (or an error if the binary is missing).
pub fn launch(cmd: &str, args: &[&str], cwd: Option<&str>) -> Result<(), String> {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    // reap it so short-lived launchers like `open` do not linger as zombies
    std::thread::spawn(move || drop(child.wait()));
    Ok(())
}

pub fn looks_like_mac_app(value: &str) -> bool {
    value.ends_with(".app") || value.contains(char::is_whitespace) || value.starts_with(|c: char| c.is_ascii_uppercase())
}

pub fn open_in_editor(editor: &str, repo: &str, file: Option<&str>) -> Result<(), String> {
    let target = match file {
        Some(f) => Path::new(repo).join(f).to_string_lossy().into_owned(),
        None => repo.to_string(),
    };
    let mac = cfg!(target_os = "macos");
    let cmd = match editor.trim() {
        "" if mac => "TextEdit",
        "" => "code",
        e => e,
    };
    if mac && looks_like_mac_app(cmd) {
        return launch("open", &["-a", cmd, &target], None);
    }
    match launch(cmd, &[&target], Some(repo)) {
        Ok(()) => Ok(()),
        Err(_) if mac => launch("open", &["-a", cmd, &target], None),
        Err(e) => Err(format!("Could not start editor \"{cmd}\": {e}")),
    }
}

pub fn open_terminal(terminal: &str, repo: &str) -> Result<(), String> {
    let t = terminal.trim();
    if cfg!(target_os = "macos") {
        return launch("open", &["-a", if t.is_empty() { "Terminal" } else { t }, repo], None);
    }
    if cfg!(windows) {
        if !t.is_empty() {
            return launch(t, &[], Some(repo));
        }
        return launch("cmd.exe", &["/c", "start", "cmd.exe"], Some(repo));
    }
    launch(if t.is_empty() { "x-terminal-emulator" } else { t }, &[], Some(repo))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persists_recents_favorites_tabs_and_preferences() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested").join("state.json");
        let mut s = AppStateStore::new(file.clone());
        assert!(s.get().preferences.is_empty());
        s.add_recent("/a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        s.add_recent("/b").unwrap();
        s.toggle_favorite("/a").unwrap();
        s.set_open_tabs(vec!["/a".into(), "/b".into()], Some("/b".into())).unwrap();
        s.set_preferences(json!({ "theme": "light" }).as_object().unwrap().clone()).unwrap();

        let reloaded = AppStateStore::new(file).get();
        let recent: Vec<_> =
            reloaded.recent.iter().map(|r| (r.path.as_str(), r.name.as_str(), r.favorite == Some(true))).collect();
        assert_eq!(recent, [("/b", "b", false), ("/a", "a", true)]);
        assert_eq!(reloaded.open_tabs, ["/a", "/b"]);
        assert_eq!(reloaded.active_tab.as_deref(), Some("/b"));
        assert_eq!(reloaded.preferences["theme"], "light");
    }

    #[test]
    fn caps_non_favorite_recents_and_keeps_favorites() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = AppStateStore::new(dir.path().join("state.json"));
        s.add_recent("/fav").unwrap();
        s.toggle_favorite("/fav").unwrap();
        for i in 0..40 {
            s.add_recent(&format!("/r{i}")).unwrap();
        }
        let recent = s.get().recent;
        assert!(recent.iter().any(|r| r.path == "/fav"));
        assert_eq!(recent.iter().filter(|r| r.favorite != Some(true)).count(), 30);
    }

    #[test]
    fn persists_workspaces_without_duplicate_repos() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        let mut s = AppStateStore::new(file.clone());
        let ws = |name: &str, repos: &[&str]| Workspace { name: name.into(), repos: repos.iter().map(|r| r.to_string()).collect() };
        let saved = s.set_workspaces(vec![ws(" work ", &["/a", "/b", "/a", ""])]).unwrap();
        assert_eq!(saved, [ws("work", &["/a", "/b"])]);
        assert!(s.set_workspaces(vec![ws("x", &[]), ws("x ", &[])]).is_err());
        assert!(s.set_workspaces(vec![ws("  ", &[])]).is_err());
        assert_eq!(AppStateStore::new(file).get().workspaces, [ws("work", &["/a", "/b"])]);
    }

    #[test]
    fn discovers_repositories_two_levels_deep() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let mk = |rel: &str| std::fs::create_dir_all(root.join(rel)).unwrap();
        mk("scan/a/.git");
        mk("scan/group/b/.git");
        mk("scan/group/b/nested/.git"); // inside a repository: not searched
        mk("scan/deep/x/y/.git"); // three levels down
        mk("scan/.hidden/c/.git");
        mk("scan/node_modules/d/.git");
        mk("scan/group/w");
        std::fs::write(root.join("scan/group/w/.git"), "gitdir: /elsewhere\n").unwrap(); // linked worktree
        mk("home/Projects/p/.git");

        let home = root.join("home");
        let dirs = vec![
            root.join("scan").to_string_lossy().into_owned(),
            root.join("scan/group").to_string_lossy().into_owned(), // overlaps the first folder
            "~/Projects".to_string(),
            "~/missing".to_string(),
            "".to_string(),
        ];
        let mut names: Vec<String> = discover_repos(&dirs, Some(&home)).into_iter().map(|r| r.name).collect();
        names.sort();
        assert_eq!(names, ["a", "b", "p", "w"]);

        let found = discover_repos(&[root.join("scan/a").to_string_lossy().into_owned()], None);
        assert_eq!(found.len(), 1, "a scan folder that is itself a repository");
        assert_eq!(found[0].path, root.join("scan/a").to_string_lossy());
        assert!(found[0].modified > 0);
        assert!(discover_repos(&["~/Projects".into()], None).is_empty(), "~ needs a home folder");

        let capped = discover_repos_bounded(&[root.join("scan").to_string_lossy().into_owned()], None, 1000, 2);
        assert_eq!(capped.len(), 2);
        assert!(discover_repos_bounded(&[root.join("scan").to_string_lossy().into_owned()], None, 1, 100).is_empty());
    }

    #[test]
    fn reads_the_electron_state_format() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        std::fs::write(
            &file,
            r#"{"recent":[{"path":"/x","name":"x","lastOpened":5,"favorite":true},{"bogus":1}],"openTabs":["/x",3],"activeTab":"/x","preferences":{"fontSize":14}}"#,
        )
        .unwrap();
        let st = AppStateStore::new(file).get();
        assert_eq!(st.recent.len(), 1);
        assert_eq!(st.open_tabs, ["/x"]);
        assert_eq!(st.preferences["fontSize"], 14);
    }
}
