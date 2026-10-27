// Opening repositories from outside the window: `karen [path]` (a second instance hands its arguments to the
// running one through the single-instance plugin), `karen://open?path=...` links (deep-link plugin) and files or
// folders dropped on a window. Requests are queued here; the renderer takes them when notified or once it loads.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewWindow};

pub const EVT_OPEN_REQUESTS: &str = "evt:openRequests";
pub const URL_SCHEME: &str = "karen";
/// Name of the command line tool.
pub const CLI_NAME: &str = "karen";

/// A path to open as a repository tab. `source` is "cli" (command line, Finder, Dock), "link" or "drop".
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct OpenRequest {
    pub path: String,
    pub source: &'static str,
}

fn request(path: impl Into<PathBuf>, source: &'static str) -> OpenRequest {
    OpenRequest { path: path.into().to_string_lossy().into_owned(), source }
}

/// `karen://open?path=/abs/path` -> the path. Only absolute paths: a link has no working directory.
pub fn link_path(url: &Url) -> Option<String> {
    if url.scheme() != URL_SCHEME || url.host_str() != Some("open") {
        return None;
    }
    let path = url.query_pairs().find(|(k, _)| k == "path").map(|(_, v)| v.into_owned())?;
    Path::new(&path).is_absolute().then_some(path)
}

/// What a URL handed to the app (deep link, or a file the OS asked it to open) should open.
pub fn request_from_url(url: &Url) -> Option<OpenRequest> {
    match url.scheme() {
        "file" => url.to_file_path().ok().map(|p| request(p, "cli")),
        URL_SCHEME => link_path(url).map(|p| request(p, "link")),
        _ => None,
    }
}

/// Paths in a command line (`argv[0]` is the executable), relative ones resolved against `cwd`. Options are skipped
/// (macOS may add `-psn_…`); on Windows and Linux a deep link arrives as an argument too.
pub fn requests_from_args(args: &[String], cwd: &Path) -> Vec<OpenRequest> {
    args.iter()
        .skip(1)
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .filter_map(|a| match Url::parse(a) {
            Ok(url) if url.scheme() == URL_SCHEME || url.scheme() == "file" => request_from_url(&url),
            _ => Some(request(cwd.join(a), "cli")),
        })
        .collect()
}

/// Requests waiting for a window to take them.
#[derive(Default)]
pub struct Pending(Mutex<Vec<OpenRequest>>);

impl Pending {
    pub fn push(&self, reqs: impl IntoIterator<Item = OpenRequest>) {
        self.0.lock().unwrap().extend(reqs);
    }

    pub fn take(&self) -> Vec<OpenRequest> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

/// Queue requests and bring a window forward to open them: the focused one, else the main one, else a new window
/// (macOS keeps running without windows), whose page takes the queue when it loads.
pub fn deliver(app: &AppHandle, reqs: Vec<OpenRequest>, create_window: fn(&AppHandle) -> tauri::Result<WebviewWindow>) {
    if reqs.is_empty() {
        return;
    }
    app.state::<Pending>().push(reqs);
    let windows = app.webview_windows();
    let target = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next())
        .cloned();
    match target {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            let _ = app.emit_to(w.label(), EVT_OPEN_REQUESTS, ());
        }
        None => drop(create_window(app)),
    }
}

// ------------------------------------------------------------------------------------- command line tool

/// Whether the command line tool is installed, where, and how to install it by hand.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub supported: bool,
    pub installed: bool,
    /// Where the command goes on the PATH
    pub link_path: String,
    /// The script the link points to (kept in the app data folder, rewritten when the app moves)
    pub script_path: String,
    /// Shell command that installs it with elevated rights
    pub manual_command: String,
}

/// The `.app` bundle the executable runs from, if any (`/Applications/X.app/Contents/MacOS/x` -> `/Applications/X.app`).
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension().is_some_and(|e| e == "app");
    is_bundle.then(|| bundle.to_path_buf())
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The `karen [path]` script. From a macOS bundle it goes through `open -n`, which starts a second instance
/// that hands the path to the running one (or becomes the app when none runs); otherwise it starts the executable
/// in the background, which does the same.
pub fn cli_script(exe: &Path) -> String {
    let launch = match app_bundle(exe) {
        Some(bundle) => format!("exec open -n -a {} --args \"$dir\"", sh_quote(&bundle.to_string_lossy())),
        None => format!("nohup {} \"$dir\" >/dev/null 2>&1 &", sh_quote(&exe.to_string_lossy())),
    };
    format!(
        r#"#!/bin/sh
# {CLI_NAME} [path]: open the repository containing path (default: the current folder) in Karen.
# Installed from Karen > Preferences; rewritten when the app moves.
target="${{1:-.}}"
if [ -d "$target" ]; then
  dir="$(cd "$target" && pwd -P)"
elif [ -e "$target" ]; then
  dir="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
else
  echo "{CLI_NAME}: no such file or directory: $target" >&2
  exit 1
fi
{launch}
"#
    )
}

/// Where the command is linked: /usr/local/bin on macOS, ~/.local/bin elsewhere (no admin rights needed there).
fn cli_link(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/usr/local/bin").join(CLI_NAME)
    } else {
        home.join(".local/bin").join(CLI_NAME)
    }
}

fn manual_command(script: &Path, link: &Path) -> String {
    let dir = link.parent().unwrap_or(Path::new("/"));
    let sudo = if cfg!(target_os = "macos") { "sudo " } else { "" };
    format!(
        "{sudo}mkdir -p {} && {sudo}ln -sf {} {}",
        sh_quote(&dir.to_string_lossy()),
        sh_quote(&script.to_string_lossy()),
        sh_quote(&link.to_string_lossy())
    )
}

pub fn status_at(script: &Path, link: &Path) -> CliStatus {
    CliStatus {
        supported: cfg!(unix),
        installed: std::fs::read_link(link).is_ok_and(|t| t == script) && script.is_file(),
        link_path: link.to_string_lossy().into_owned(),
        script_path: script.to_string_lossy().into_owned(),
        manual_command: manual_command(script, link),
    }
}

#[cfg(unix)]
fn write_script(script: &Path, exe: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(dir) = script.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(script, cli_script(exe)).map_err(|e| e.to_string())?;
    std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
}

/// Write the script and link it onto the PATH. A missing permission is reported with the command to run instead.
#[cfg(unix)]
pub fn install_at(script: &Path, link: &Path, exe: &Path) -> Result<CliStatus, String> {
    write_script(script, exe)?;
    // replace an older link, never somebody else's file
    if let Ok(meta) = std::fs::symlink_metadata(link) {
        if !meta.file_type().is_symlink() {
            return Err(format!("{} already exists and is not a link. Remove it first.", link.display()));
        }
    }
    let denied = |e: &std::io::Error| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!(
                "No permission to write to {}. Run this in a terminal instead:\n{}",
                link.parent().unwrap_or(Path::new("/")).display(),
                manual_command(script, link)
            )
        } else {
            format!("Could not install {}: {e}", link.display())
        }
    };
    if let Some(dir) = link.parent() {
        std::fs::create_dir_all(dir).map_err(|e| denied(&e))?;
    }
    let tmp = link.with_file_name(format!(".{CLI_NAME}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    std::os::unix::fs::symlink(script, &tmp).map_err(|e| denied(&e))?;
    std::fs::rename(&tmp, link).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        denied(&e)
    })?;
    Ok(status_at(script, link))
}

#[cfg(not(unix))]
pub fn install_at(_script: &Path, _link: &Path, _exe: &Path) -> Result<CliStatus, String> {
    Err("The command line tool is only available on macOS and Linux.".into())
}

fn cli_paths(app: &AppHandle) -> (PathBuf, PathBuf) {
    let data = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("/"));
    (data.join("bin").join(CLI_NAME), cli_link(&home))
}

pub fn cli_status(app: &AppHandle) -> CliStatus {
    let (script, link) = cli_paths(app);
    status_at(&script, &link)
}

pub fn install_cli(app: &AppHandle) -> Result<CliStatus, String> {
    let (script, link) = cli_paths(app);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    install_at(&script, &link, &exe)
}

/// Keep an installed script pointing at this executable (the app may have been moved or updated). Needs no rights:
/// the script lives in the app data folder.
pub fn refresh_cli_script(app: &AppHandle) {
    #[cfg(unix)]
    {
        let (script, _) = cli_paths(app);
        if let (true, Ok(exe)) = (script.is_file(), std::env::current_exe()) {
            if std::fs::read_to_string(&script).ok() != Some(cli_script(&exe)) {
                let _ = write_script(&script, &exe);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_paths_and_links_from_the_command_line() {
        let cwd = Path::new("/work");
        let reqs = requests_from_args(&strs(&["/app/karen", "-psn_0_123", "repo", "/abs/x", ""]), cwd);
        assert_eq!(reqs, [request("/work/repo", "cli"), request("/abs/x", "cli")]);
        assert!(requests_from_args(&strs(&["/app/karen"]), cwd).is_empty());
        let link = requests_from_args(&strs(&["kc", "karen://open?path=%2Ftmp%2Fmy%20repo"]), cwd);
        assert_eq!(link, [request("/tmp/my repo", "link")]);
        assert_eq!(requests_from_args(&strs(&["kc", "file:///tmp/a"]), cwd), [request("/tmp/a", "cli")]);
    }

    #[test]
    fn accepts_only_absolute_open_links() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert_eq!(link_path(&url("karen://open?path=/a/b")).as_deref(), Some("/a/b"));
        assert_eq!(link_path(&url("karen://open?x=1&path=/a")).as_deref(), Some("/a"));
        assert_eq!(link_path(&url("karen://open?path=relative")), None);
        assert_eq!(link_path(&url("karen://clone?path=/a")), None);
        assert_eq!(link_path(&url("https://open?path=/a")), None);
        assert_eq!(request_from_url(&url("https://example.com/x")), None);
    }

    #[test]
    fn script_launches_the_bundle_or_the_executable() {
        let bundle = Path::new("/Applications/Karen.app/Contents/MacOS/karen");
        assert_eq!(app_bundle(bundle).as_deref(), Some(Path::new("/Applications/Karen.app")));
        assert!(cli_script(bundle).contains("exec open -n -a '/Applications/Karen.app' --args \"$dir\""));
        let dev = Path::new("/src/target/debug/karen");
        assert_eq!(app_bundle(dev), None);
        assert!(cli_script(dev).contains("nohup '/src/target/debug/karen' \"$dir\""));
    }

    #[cfg(unix)]
    #[test]
    fn installs_a_link_and_explains_missing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("data/bin/karen");
        let link = dir.path().join("bin/karen");
        let exe = Path::new("/opt/kc/karen");
        assert!(!status_at(&script, &link).installed);
        let st = install_at(&script, &link, exe).unwrap();
        assert!(st.installed);
        assert_eq!(std::fs::read_link(&link).unwrap(), script);
        assert_eq!(std::fs::metadata(&script).unwrap().permissions().mode() & 0o777, 0o755);
        // reinstalling replaces the link
        install_at(&script, &link, exe).unwrap();

        // somebody else's file is left alone
        let other = dir.path().join("taken/karen");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, "x").unwrap();
        assert!(install_at(&script, &other, exe).unwrap_err().contains("not a link"));

        // a folder we cannot write to: the error carries the command to run by hand
        let locked = dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let res = install_at(&script, &locked.join("karen"), exe);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        // root ignores folder permissions
        let Err(err) = res else { return };
        assert!(err.starts_with("No permission"), "{err}");
        assert!(err.contains("ln -sf"), "{err}");
        assert!(err.contains(&script.to_string_lossy().into_owned()), "{err}");
    }
}
