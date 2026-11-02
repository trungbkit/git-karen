// The GitHub CLI (gh) as a credential source for GitHub hosts: instead of a personal access token pasted into
// Preferences, the token gh already holds (`gh auth login`, in gh's own keyring entry or config) is asked for when
// needed with `gh auth token`. Requests still go through curl (http.rs) like every other hosting call; gh is only
// asked for the token, which stays in the backend like a keychain token does.
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(15);

/// Variables gh reads that a login shell may export but a GUI app doesn't inherit
pub const GH_VARS: [&str; 5] = ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/// An account gh is signed in to.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GhAccount {
    pub host: String,
    pub login: String,
    /// The account gh uses for the host when none is named
    pub active: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct GhStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub accounts: Vec<GhAccount>,
    /// Why accounts could not be listed (old gh, broken config), when gh is installed
    pub error: Option<String>,
}

/// The gh executable: KAREN_GH_PATH, or `gh` on the PATH (Homebrew's bin is added at startup on macOS).
pub fn program() -> String {
    std::env::var("KAREN_GH_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "gh".into())
}

fn not_installed() -> String {
    "The GitHub CLI (gh) was not found. Install it from https://cli.github.com and run `gh auth login`.".into()
}

async fn run(program: &str, args: &[&str], env: &[(String, String)]) -> Result<Output, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        // never prompt, print update notices or colour codes into output we parse
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let child = cmd.output();
    match tokio::time::timeout(TIMEOUT, child).await {
        Err(_) => Err(format!("The GitHub CLI did not answer within {}s.", TIMEOUT.as_secs())),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Err(not_installed()),
        Ok(Err(e)) => Err(format!("Could not run the GitHub CLI: {e}")),
        Ok(Ok(out)) => Ok(out),
    }
}

fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().to_string()
}

/// "gh version 2.94.0 (2026-06-10)" → "2.94.0"
pub fn parse_version(out: &str) -> Option<String> {
    out.lines().next()?.strip_prefix("gh version ")?.split_whitespace().next().map(String::from)
}

/// Signed-in accounts from `gh auth status --json hosts`; accounts whose token gh can't use are left out.
pub fn parse_accounts(v: &Value) -> Vec<GhAccount> {
    let Some(hosts) = v["hosts"].as_object() else { return vec![] };
    hosts
        .iter()
        .flat_map(|(host, list)| list.as_array().into_iter().flatten().map(move |a| (host, a)))
        .filter(|(_, a)| a["state"].as_str() == Some("success"))
        .filter_map(|(host, a)| {
            Some(GhAccount { host: a["host"].as_str().unwrap_or(host).to_string(), login: a["login"].as_str()?.to_string(), active: a["active"].as_bool().unwrap_or(false) })
        })
        .collect()
}

pub async fn status(program: &str, env: &[(String, String)]) -> GhStatus {
    let version = match run(program, &["--version"], env).await {
        Ok(out) if out.status.success() => parse_version(&String::from_utf8_lossy(&out.stdout)),
        _ => return GhStatus::default(),
    };
    // exits 1 when any account has a problem, but still prints the JSON
    let (accounts, error) = match run(program, &["auth", "status", "--json", "hosts"], env).await {
        Ok(out) => match serde_json::from_slice::<Value>(&out.stdout) {
            Ok(v) => (parse_accounts(&v), None),
            Err(_) => {
                let msg = first_line(&out.stderr);
                (vec![], Some(if msg.contains("unknown flag") { "This gh version can't list its accounts; update gh, or try connecting anyway.".to_string() } else { msg }))
            }
        },
        Err(e) => (vec![], Some(e)),
    };
    GhStatus { installed: true, version, accounts, error }
}

/// The token gh holds for `host` (as `user`, or its active account).
pub async fn token(program: &str, host: &str, user: Option<&str>, env: &[(String, String)]) -> Result<String, String> {
    let mut args = vec!["auth", "token", "--hostname", host];
    if let Some(u) = user {
        args.extend(["--user", u]);
    }
    let out = run(program, &args, env).await?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && !token.is_empty() && !token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Ok(token);
    }
    let who = user.map(|u| format!(" as {u}")).unwrap_or_default();
    let detail = first_line(&out.stderr);
    let mut msg = format!("The GitHub CLI is not signed in to {host}{who}. Run `gh auth login --hostname {host}` in a terminal.");
    if !detail.is_empty() {
        msg.push_str(&format!(" ({detail})"));
    }
    Err(msg)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A fake gh: a shell script answering --version, auth status and auth token like gh does.
    #[cfg(unix)]
    pub fn fake_gh(dir: &std::path::Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("gh");
        let script = r#"#!/bin/sh
case "$1 $2" in
  "--version ") echo "gh version 2.94.0 (2026-06-10)" ;;
  "auth status") echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octo"},{"state":"success","active":false,"host":"github.com","login":"work"},{"state":"error","active":false,"host":"github.com","login":"stale"}]}}'; exit 1 ;;
  "auth token")
    [ "$4" = "github.com" ] || { echo "no oauth token found for $4" >&2; exit 1; }
    if [ "$6" = "work" ]; then echo "gho_WORK"; else echo "gho_OCTO"; fi ;;
  *) exit 2 ;;
esac
"#;
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn parses_version_and_accounts() {
        assert_eq!(parse_version("gh version 2.94.0 (2026-06-10)\nhttps://github.com/cli/cli/releases/tag/v2.94.0\n").as_deref(), Some("2.94.0"));
        assert_eq!(parse_version("something else"), None);
        let v: Value = serde_json::from_str(
            r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"a"},{"state":"timeout","active":false,"host":"github.com","login":"b"}],"ghe.corp.io":[{"state":"success","active":true,"login":"c"}]}}"#,
        )
        .unwrap();
        let accounts = parse_accounts(&v);
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0], GhAccount { host: "ghe.corp.io".into(), login: "c".into(), active: true });
        assert_eq!(accounts[1].login, "a");
        assert!(parse_accounts(&Value::Null).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_status_and_tokens_from_gh() {
        let dir = tempfile::tempdir().unwrap();
        let gh = fake_gh(dir.path());
        let st = status(&gh, &[]).await;
        assert!(st.installed);
        assert_eq!(st.version.as_deref(), Some("2.94.0"));
        assert_eq!(st.accounts.iter().map(|a| a.login.as_str()).collect::<Vec<_>>(), ["octo", "work"]);
        assert_eq!(token(&gh, "github.com", None, &[]).await.unwrap(), "gho_OCTO");
        assert_eq!(token(&gh, "github.com", Some("work"), &[]).await.unwrap(), "gho_WORK");
        let err = token(&gh, "ghe.corp.io", None, &[]).await.unwrap_err();
        assert!(err.contains("gh auth login --hostname ghe.corp.io") && err.contains("no oauth token"), "{err}");

        let missing = dir.path().join("nope").to_string_lossy().to_string();
        assert!(!status(&missing, &[]).await.installed);
        assert!(token(&missing, "github.com", None, &[]).await.unwrap_err().contains("cli.github.com"));
    }
}
