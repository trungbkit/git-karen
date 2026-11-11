// The environment of the user's login shell. A GUI app on macOS doesn't inherit what ~/.zshrc exports (PATH entries
// from nvm, bun, pyenv…, API keys, proxies), so it is read once from an interactive login shell and handed to the
// child processes that need it.
use std::collections::HashMap;
#[cfg(all(not(windows), not(test)))]
use std::process::Stdio;
#[cfg(all(not(windows), not(test)))]
use std::time::Duration;

#[cfg(all(not(windows), not(test)))]
use tokio::process::Command;
use tokio::sync::OnceCell;

static SHELL_ENV: OnceCell<HashMap<String, String>> = OnceCell::const_new();

/// The environment an interactive login shell ends up with, read once. Empty when it can't be read in time.
#[cfg(not(test))]
pub(crate) async fn shell_env() -> &'static HashMap<String, String> {
    SHELL_ENV.get_or_init(read_shell_env).await
}

#[cfg(test)]
pub(crate) async fn shell_env() -> &'static HashMap<String, String> {
    SHELL_ENV.get_or_init(|| async { HashMap::new() }).await
}

#[cfg(all(windows, not(test)))]
async fn read_shell_env() -> HashMap<String, String> {
    HashMap::new()
}

#[cfg(all(not(windows), not(test)))]
async fn read_shell_env() -> HashMap<String, String> {
    const MARK: &str = "__KAREN_ENV__";
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    // rc files may print banners; everything before the marker is ignored
    let script = format!("printf '%s' {MARK}; env -0");
    let child = Command::new(shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(5), child).await else { return HashMap::new() };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some((_, vars)) = text.split_once(MARK) else { return HashMap::new() };
    vars.split('\0').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// The given variables as the login shell exports them, for those this process doesn't have.
pub(crate) async fn shell_vars(names: &[&str]) -> Vec<(String, String)> {
    let mut env = vec![];
    for var in names {
        if std::env::var_os(var).is_none() {
            if let Some(v) = shell_env().await.get(*var) {
                env.push((var.to_string(), v.clone()));
            }
        }
    }
    env
}

/// Variables that describe the shell session itself, not the user's setup.
const SESSION_VARS: [&str; 4] = ["PWD", "OLDPWD", "SHLVL", "_"];

/// Environment for git commands that may run hooks (commit, push, merge…). Hooks are written against the terminal, so
/// the login shell's PATH goes first (the tools a hook calls, such as node, bun or lefthook, are often only there),
/// followed by this process's entries; variables the shell exports and this process lacks (NVM_DIR, BUN_INSTALL…)
/// come along too.
pub(crate) async fn hook_env() -> Vec<(String, String)> {
    let path = std::env::var("PATH").ok();
    merge_env(shell_env().await, path.as_deref(), |name| std::env::var_os(name).is_some())
}

fn merge_env(shell: &HashMap<String, String>, path: Option<&str>, has: impl Fn(&str) -> bool) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = shell
        .iter()
        .filter(|(k, _)| k.as_str() != "PATH" && !SESSION_VARS.contains(&k.as_str()) && !has(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if let Some(shell_path) = shell.get("PATH").filter(|p| !p.is_empty()) {
        let mut parts: Vec<&str> = vec![];
        for p in shell_path.split(':').chain(path.unwrap_or("").split(':')) {
            if !p.is_empty() && !parts.contains(&p) {
                parts.push(p);
            }
        }
        env.push(("PATH".into(), parts.join(":")));
    }
    env.sort();
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn shell_path_goes_first_without_duplicates() {
        let shell = map(&[("PATH", "/Users/me/.bun/bin:/opt/homebrew/bin:/usr/bin")]);
        let env = merge_env(&shell, Some("/opt/homebrew/bin:/usr/bin:/bin"), |_| true);
        assert_eq!(env, vec![("PATH".into(), "/Users/me/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin".into())]);
    }

    #[test]
    fn adds_only_missing_non_session_vars() {
        let shell = map(&[("NVM_DIR", "/n"), ("HOME", "/h"), ("PWD", "/x"), ("SHLVL", "2"), ("_", "/usr/bin/env")]);
        let env = merge_env(&shell, Some("/usr/bin"), |name| name == "HOME");
        assert_eq!(env, vec![("NVM_DIR".into(), "/n".into())]);
    }

    #[test]
    fn nothing_when_the_shell_could_not_be_read() {
        assert!(merge_env(&HashMap::new(), Some("/usr/bin"), |_| false).is_empty());
    }
}
