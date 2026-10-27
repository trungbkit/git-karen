// AI provider access for commit messages and pull request texts (Claude, OpenAI or Gemini, with the user's own key).
// Keys live in their own file (owner-only permissions) and never cross into the renderer: it only learns where each
// one comes from. Anything not set in the app falls back to the environment, including the login shell's, since a GUI
// app doesn't inherit what ~/.zshrc exports. Requests go through the system curl, which brings proxy support
// (HTTPS_PROXY, NO_PROXY) with it.
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::OnceCell;

pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-haiku-5-5";
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-6-luna";
pub const DEFAULT_GEMINI_MODEL: &str = "gemini-3.1-flash-lite";
const DEFAULT_ANTHROPIC_URL: &str = "https://api.anthropic.com";
const DEFAULT_OPENAI_URL: &str = "https://api.openai.com";
const DEFAULT_GEMINI_URL: &str = "https://generativelanguage.googleapis.com";
const DEFAULT_MAX_TOKENS: u32 = 500;

/// Credentials in priority order, each with the environment variables it falls back to.
const SECRETS: [(&str, &[&str]); 4] = [
    ("anthropicOauthToken", &["CLAUDE_CODE_OAUTH_TOKEN"]),
    ("anthropicApiKey", &["ANTHROPIC_API_KEY"]),
    ("openaiApiKey", &["OPENAI_API_KEY"]),
    ("geminiApiKey", &["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
];
const PROXY_VARS: [&str; 6] = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// "auto" (first provider with a credential: Anthropic, OpenAI, Gemini) or a provider name
    pub provider: String,
    /// Empty = the default (or the OPENAI_MODEL / GEMINI_MODEL environment variable)
    pub anthropic_model: String,
    pub openai_model: String,
    pub gemini_model: String,
    /// Empty = the public endpoint (or the *_BASE_URL environment variable); set to route through a gateway
    pub anthropic_base_url: String,
    pub openai_base_url: String,
    pub gemini_base_url: String,
    pub timeout_seconds: u32,
    /// Total attempts per request, including the first
    pub attempts: u32,
}

impl Default for AiSettings {
    fn default() -> Self {
        AiSettings {
            provider: "auto".into(),
            anthropic_model: String::new(),
            openai_model: String::new(),
            gemini_model: String::new(),
            anthropic_base_url: String::new(),
            openai_base_url: String::new(),
            gemini_base_url: String::new(),
            timeout_seconds: 30,
            attempts: 3,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
struct AiFile {
    settings: AiSettings,
    secrets: BTreeMap<String, String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SecretInfo {
    /// "app", "env", or None when the credential isn't available
    pub source: Option<&'static str>,
    /// Masked key ("…a1b2") or the environment variable it was read from
    pub hint: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ActiveProvider {
    pub provider: &'static str,
    pub model: String,
    pub credential: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub settings: AiSettings,
    pub secrets: BTreeMap<&'static str, SecretInfo>,
    pub active: Option<ActiveProvider>,
    /// Model used when the setting is empty, per provider
    pub default_models: BTreeMap<&'static str, String>,
}

// ------------------------------------------------------------- environment

static SHELL_ENV: OnceCell<HashMap<String, String>> = OnceCell::const_new();

/// The environment an interactive login shell ends up with, read once. Empty when it can't be read in time.
async fn shell_env() -> &'static HashMap<String, String> {
    SHELL_ENV.get_or_init(read_shell_env).await
}

#[cfg(windows)]
async fn read_shell_env() -> HashMap<String, String> {
    HashMap::new()
}

#[cfg(not(windows))]
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

/// A non-empty environment variable from this process, or else from the login shell.
#[cfg(not(test))]
async fn env_value(name: &str) -> Option<String> {
    if let Some(v) = std::env::var(name).ok().filter(|v| !v.trim().is_empty()) {
        return Some(v.trim().to_string());
    }
    shell_env().await.get(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Tests must not depend on the developer's keys or shell.
#[cfg(test)]
async fn env_value(_name: &str) -> Option<String> {
    None
}

/// Proxy variables exported only by the login shell, for other curl-based clients (hosting integrations).
pub(crate) async fn proxy_env() -> Vec<(String, String)> {
    let mut env = vec![];
    for var in PROXY_VARS {
        if std::env::var_os(var).is_none() {
            if let Some(v) = shell_env().await.get(var) {
                env.push((var.to_string(), v.clone()));
            }
        }
    }
    env
}

// ------------------------------------------------------------------- store

pub struct AiStore {
    file: PathBuf,
    data: AiFile,
}

fn mask(secret: &str) -> String {
    let tail: String = secret.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

fn non_empty(s: &str) -> Option<String> {
    Some(s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Everything a request needs, resolved from settings, stored secrets and the environment.
#[derive(Clone, Debug)]
pub struct Resolved {
    provider: &'static str,
    credential: &'static str,
    secret: String,
    model: String,
    base_url: String,
    timeout_seconds: u32,
    attempts: u32,
    env: Vec<(String, String)>,
}

impl AiStore {
    pub fn new(file: PathBuf) -> Self {
        let data = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        AiStore { file, data }
    }

    fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }

    /// Merge a partial settings object, and set (string) or clear (null / empty) secrets.
    pub fn update(&mut self, settings: Option<Map<String, Value>>, secrets: Option<Map<String, Value>>) -> Result<(), String> {
        if let Some(patch) = settings {
            let mut current = serde_json::to_value(&self.data.settings).map_err(|e| e.to_string())?;
            let obj = current.as_object_mut().expect("settings serialize to an object");
            for (k, v) in patch {
                if obj.contains_key(&k) {
                    obj.insert(k, v);
                }
            }
            let next: AiSettings = serde_json::from_value(current).map_err(|e| format!("Invalid AI settings: {e}"))?;
            if !["auto", "anthropic", "openai", "gemini"].contains(&next.provider.as_str()) {
                return Err(format!("Unknown AI provider: {}", next.provider));
            }
            self.data.settings = AiSettings { timeout_seconds: next.timeout_seconds.clamp(5, 600), attempts: next.attempts.clamp(1, 10), ..next };
        }
        for (name, value) in secrets.unwrap_or_default() {
            if !SECRETS.iter().any(|(n, _)| *n == name) {
                return Err(format!("Unknown credential: {name}"));
            }
            match value.as_str().and_then(non_empty) {
                Some(v) => self.data.secrets.insert(name, v),
                None => self.data.secrets.remove(&name),
            };
        }
        self.save()
    }

    /// A snapshot that can be used without holding the store's lock.
    pub fn snapshot(&self) -> AiSnapshot {
        AiSnapshot { settings: self.data.settings.clone(), secrets: self.data.secrets.clone() }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AiSnapshot {
    settings: AiSettings,
    secrets: BTreeMap<String, String>,
}

impl AiSnapshot {
    async fn secret(&self, name: &str) -> Option<(String, &'static str, String)> {
        if let Some(v) = self.secrets.get(name).and_then(|v| non_empty(v)) {
            return Some((v.clone(), "app", mask(&v)));
        }
        let vars = SECRETS.iter().find(|(n, _)| *n == name).map(|(_, v)| *v).unwrap_or(&[]);
        for var in vars {
            if let Some(v) = env_value(var).await {
                return Some((v, "env", (*var).to_string()));
            }
        }
        None
    }

    async fn model(&self, provider: &str) -> String {
        let s = &self.settings;
        match provider {
            "anthropic" => non_empty(&s.anthropic_model).unwrap_or_else(|| DEFAULT_ANTHROPIC_MODEL.into()),
            "openai" => match non_empty(&s.openai_model) {
                Some(m) => m,
                None => env_value("OPENAI_MODEL").await.unwrap_or_else(|| DEFAULT_OPENAI_MODEL.into()),
            },
            _ => match non_empty(&s.gemini_model) {
                Some(m) => m,
                None => env_value("GEMINI_MODEL").await.unwrap_or_else(|| DEFAULT_GEMINI_MODEL.into()),
            },
        }
    }

    async fn base_url(&self, provider: &str) -> String {
        let s = &self.settings;
        let (setting, var, default) = match provider {
            "anthropic" => (&s.anthropic_base_url, "ANTHROPIC_BASE_URL", DEFAULT_ANTHROPIC_URL),
            "openai" => (&s.openai_base_url, "OPENAI_BASE_URL", DEFAULT_OPENAI_URL),
            _ => (&s.gemini_base_url, "GEMINI_BASE_URL", DEFAULT_GEMINI_URL),
        };
        match non_empty(setting) {
            Some(u) => u,
            None => env_value(var).await.unwrap_or_else(|| default.into()),
        }
    }

    /// The provider and credential requests will use. Anthropic prefers the OAuth token over the API key.
    async fn pick(&self) -> Result<(&'static str, &'static str), String> {
        let candidates: &[(&'static str, &'static str)] = &[
            ("anthropic", "anthropicOauthToken"),
            ("anthropic", "anthropicApiKey"),
            ("openai", "openaiApiKey"),
            ("gemini", "geminiApiKey"),
        ];
        let wanted = self.settings.provider.as_str();
        for (provider, credential) in candidates {
            if (wanted == "auto" || wanted == *provider) && self.secret(credential).await.is_some() {
                return Ok((provider, credential));
            }
        }
        Err(match wanted {
            "auto" => "No AI credentials found. Add an API key in Preferences > AI, or set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY.".into(),
            p => format!("No credential for {p}. Add one in Preferences > AI."),
        })
    }

    pub async fn status(&self) -> AiStatus {
        let mut secrets = BTreeMap::new();
        for (name, _) in SECRETS {
            let found = self.secret(name).await;
            secrets.insert(name, SecretInfo { source: found.as_ref().map(|f| f.1), hint: found.map(|f| f.2) });
        }
        let active = match self.pick().await {
            Ok((provider, credential)) => Some(ActiveProvider { provider, model: self.model(provider).await, credential }),
            Err(_) => None,
        };
        let mut default_models = BTreeMap::new();
        let unset = AiSnapshot::default();
        for p in ["anthropic", "openai", "gemini"] {
            default_models.insert(p, unset.model(p).await);
        }
        AiStatus { settings: self.settings.clone(), secrets, active, default_models }
    }

    pub async fn resolve(&self) -> Result<Resolved, String> {
        let (provider, credential) = self.pick().await?;
        let (secret, _, _) = self.secret(credential).await.ok_or("Credential disappeared")?;
        // a proxy configured only in the login shell still has to reach curl
        let mut env = vec![];
        for var in PROXY_VARS {
            if std::env::var_os(var).is_none() {
                if let Some(v) = shell_env().await.get(var) {
                    env.push((var.to_string(), v.clone()));
                }
            }
        }
        Ok(Resolved {
            provider,
            credential,
            secret,
            model: self.model(provider).await,
            base_url: self.base_url(provider).await,
            timeout_seconds: self.settings.timeout_seconds,
            attempts: self.settings.attempts.max(1),
            env,
        })
    }
}

// --------------------------------------------------------------- transport

#[derive(Debug)]
struct HttpError {
    message: String,
    retryable: bool,
    retry_after: Option<f64>,
}

fn join_url(base: &str, path: &str) -> String {
    format!("{}{path}", base.trim_end_matches('/'))
}

fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host)
}

/// Quote a value for a curl config file.
fn curl_quote(v: &str) -> String {
    let clean: String = v.chars().filter(|c| *c != '\r' && *c != '\n').collect();
    format!("\"{}\"", clean.replace('\\', "\\\\").replace('"', "\\\""))
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn base_url_setting(host: &str) -> &'static str {
    if host.contains("openai") {
        "OpenAI base URL"
    } else if host.contains("googleapis") {
        "Gemini base URL"
    } else {
        "Anthropic base URL"
    }
}

/// Turn a curl failure into something actionable: a bare "Could not resolve host" says nothing about the usual
/// causes (no connectivity, a VPN that is down, a proxy-only network).
fn network_error(code: i32, stderr: &str, host: &str, timeout: u32) -> HttpError {
    let (message, retryable) = match code {
        5 => (format!("Cannot resolve the proxy for {host}. Check HTTPS_PROXY."), true),
        6 => (
            format!(
                "Cannot resolve {host}. Check your internet connection, VPN or DNS. Behind a corporate proxy? Set HTTPS_PROXY. Using a gateway? Set the {} in Preferences > AI.",
                base_url_setting(host)
            ),
            true,
        ),
        7 => (format!("Could not connect to {host}. A firewall or proxy may be blocking it."), true),
        28 => (format!("The request to {host} timed out after {timeout}s. Raise the timeout in Preferences > AI if the network is just slow."), true),
        35 | 52 | 55 | 56 => (format!("The connection to {host} was dropped ({}).", stderr.trim()), true),
        60 | 77 => (format!("TLS certificate problem talking to {host}: {}. A TLS-inspecting proxy may be in the way.", stderr.trim()), false),
        _ => (format!("curl failed (exit {code}): {}", stderr.trim()), false),
    };
    HttpError { message, retryable, retry_after: None }
}

fn retry_after(headers: &str) -> Option<f64> {
    // after redirects or a proxy CONNECT there are several header blocks; the last one is the response's
    headers
        .lines()
        .rev()
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.trim().eq_ignore_ascii_case("retry-after"))
        .find_map(|(_, v)| v.trim().parse::<f64>().ok())
}

/// Interpret curl's stdout (body, then the status code on the last line, from --write-out).
fn parse_response(stdout: &str, headers: &str) -> Result<Value, HttpError> {
    let (body, code) = stdout.rsplit_once('\n').unwrap_or(("", stdout));
    let status: u16 = code.trim().parse().unwrap_or(0);
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    if (200..300).contains(&status) {
        return parsed.ok_or_else(|| HttpError { message: "Unexpected non-JSON response from the AI provider".into(), retryable: false, retry_after: None });
    }
    // some errors carry an uninformative message (just "Error"), so always include the status and error type
    let p = parsed.unwrap_or(Value::Null);
    let detail = p["error"]["message"].as_str().or(p["message"].as_str()).or(p[0]["error"]["message"].as_str());
    let kind = p["error"]["type"].as_str().or(p["error"]["status"].as_str());
    let mut message = format!("API error (HTTP {status}{})", kind.map(|k| format!(", {k}")).unwrap_or_default());
    if let Some(d) = detail {
        message.push_str(&format!(": {d}"));
    } else if status == 0 {
        message = "No response from the AI provider".into();
    }
    let retryable = status == 0 || status == 408 || status == 429 || (500..600).contains(&status);
    Err(HttpError { message, retryable, retry_after: retry_after(headers) })
}

async fn post_once(url: &str, headers: &[(&str, String)], body: &Value, r: &Resolved) -> Result<Value, HttpError> {
    let fail = |message: String| HttpError { message, retryable: false, retry_after: None };
    let dir = tempfile::Builder::new().prefix("karen-ai-").tempdir().map_err(|e| fail(e.to_string()))?;
    let body_file = dir.path().join("body.json");
    let header_file = dir.path().join("headers");
    tokio::fs::write(&body_file, body.to_string()).await.map_err(|e| fail(e.to_string()))?;

    // credentials go through stdin, never the command line where `ps` would show them
    let mut config = format!("url = {}\n", curl_quote(url));
    for (k, v) in headers {
        config.push_str(&format!("header = {}\n", curl_quote(&format!("{k}: {v}"))));
    }
    config.push_str(&format!("data-binary = {}\n", curl_quote(&format!("@{}", body_file.to_string_lossy()))));
    config.push_str(&format!("dump-header = {}\n", curl_quote(&header_file.to_string_lossy())));

    let timeout = r.timeout_seconds.max(1);
    let mut cmd = Command::new("curl");
    cmd.args(["--silent", "--show-error", "--config", "-", "--write-out", "\n%{http_code}"])
        .args(["--max-time", &timeout.to_string(), "--connect-timeout", &timeout.min(15).to_string()])
        .envs(r.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| fail(format!("AI requests need curl on PATH: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(config.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let out = child.wait_with_output().await.map_err(|e| fail(e.to_string()))?;
    let code = out.status.code().unwrap_or(-1);
    if code != 0 {
        return Err(network_error(code, &String::from_utf8_lossy(&out.stderr), host_of(url), timeout));
    }
    let headers_text = tokio::fs::read_to_string(&header_file).await.unwrap_or_default();
    parse_response(&String::from_utf8_lossy(&out.stdout), &headers_text)
}

/// POST with retries on transient failures (DNS and connection errors, timeouts, 408, 429 and 5xx) with
/// exponential backoff, honouring Retry-After. Auth and validation errors fail immediately.
async fn post_json(url: &str, headers: &[(&str, String)], body: &Value, r: &Resolved) -> Result<Value, String> {
    let mut attempt = 1;
    loop {
        match post_once(url, headers, body, r).await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < r.attempts && e.retryable => {
                let wait = e.retry_after.map(|s| s.clamp(0.0, 60.0)).unwrap_or(0.5 * 2f64.powi(attempt as i32 - 1));
                tokio::time::sleep(Duration::from_secs_f64(wait)).await;
                attempt += 1;
            }
            Err(e) => return Err(e.message),
        }
    }
}

/// Send one prompt to the resolved provider and return the text of the reply.
pub async fn complete(r: &Resolved, prompt: &str, max_tokens: Option<u32>) -> Result<String, String> {
    let max_tokens = max_tokens.unwrap_or(DEFAULT_MAX_TOKENS).clamp(16, 8192);
    match r.provider {
        "anthropic" => {
            let oauth = r.credential == "anthropicOauthToken";
            let mut body = json!({
                "model": r.model,
                "max_tokens": max_tokens,
                // thinking can spend the whole budget before any text is written; these tasks don't need it
                "thinking": { "type": "disabled" },
                "messages": [{ "role": "user", "content": prompt }],
            });
            let mut headers = vec![("Content-Type", "application/json".to_string()), ("anthropic-version", "2023-06-01".to_string())];
            if oauth {
                // subscription OAuth tokens are scoped to Claude Code; without this system prompt the API rejects them
                body["system"] = json!("You are Claude Code, Anthropic's official CLI for Claude.");
                headers.push(("Authorization", format!("Bearer {}", r.secret)));
                headers.push(("anthropic-beta", "oauth-2025-04-20".into()));
            } else {
                headers.push(("x-api-key", r.secret.clone()));
            }
            let res = post_json(&join_url(&r.base_url, "/v1/messages"), &headers, &body, r).await?;
            // newer models may lead with thinking blocks, so collect every text block
            Ok(res["content"]
                .as_array()
                .map(|blocks| blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<String>())
                .unwrap_or_default())
        }
        "openai" => {
            let body = json!({
                "model": r.model,
                "max_completion_tokens": max_tokens,
                "messages": [{ "role": "user", "content": prompt }],
            });
            let headers = [("Content-Type", "application/json".to_string()), ("Authorization", format!("Bearer {}", r.secret))];
            let res = post_json(&join_url(&r.base_url, "/v1/chat/completions"), &headers, &body, r).await?;
            Ok(res["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string())
        }
        _ => {
            let body = json!({
                "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
                "generationConfig": { "maxOutputTokens": max_tokens },
            });
            // the key goes in a header, not the query string, so it never lands in logs
            let headers = [("Content-Type", "application/json".to_string()), ("x-goog-api-key", r.secret.clone())];
            let path = format!("/v1beta/models/{}:generateContent", percent_encode(&r.model));
            let res = post_json(&join_url(&r.base_url, &path), &headers, &body, r).await?;
            Ok(res["candidates"][0]["content"]["parts"]
                .as_array()
                .map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect::<String>())
                .unwrap_or_default())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn snapshot(provider: &str, secrets: &[(&str, &str)]) -> AiSnapshot {
        AiSnapshot {
            settings: AiSettings { provider: provider.into(), ..Default::default() },
            secrets: secrets.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    #[tokio::test]
    async fn picks_providers_in_priority_order() {
        let s = snapshot("auto", &[("geminiApiKey", "g"), ("openaiApiKey", "o"), ("anthropicApiKey", "a"), ("anthropicOauthToken", "t")]);
        assert_eq!(s.pick().await.unwrap(), ("anthropic", "anthropicOauthToken"));
        let s = snapshot("auto", &[("geminiApiKey", "g"), ("openaiApiKey", "o")]);
        assert_eq!(s.pick().await.unwrap(), ("openai", "openaiApiKey"));
        let s = snapshot("gemini", &[("geminiApiKey", "g"), ("openaiApiKey", "o")]);
        assert_eq!(s.pick().await.unwrap(), ("gemini", "geminiApiKey"));
    }

    #[tokio::test]
    async fn status_masks_stored_keys() {
        let s = snapshot("openai", &[("openaiApiKey", "sk-secret-1234")]);
        let status = s.status().await;
        let info = &status.secrets["openaiApiKey"];
        assert_eq!(info.source, Some("app"));
        assert_eq!(info.hint.as_deref(), Some("…1234"));
        assert!(!serde_json::to_string(&status).unwrap().contains("sk-secret"));
        assert_eq!(status.active.unwrap().provider, "openai");
    }

    #[test]
    fn update_merges_settings_and_clears_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = AiStore::new(dir.path().join("ai.json"));
        let settings = json!({ "provider": "openai", "openaiModel": "m", "timeoutSeconds": 1, "bogus": 1 });
        store.update(settings.as_object().cloned(), json!({ "openaiApiKey": " k " }).as_object().cloned()).unwrap();
        assert_eq!(store.data.settings.provider, "openai");
        assert_eq!(store.data.settings.openai_model, "m");
        assert_eq!(store.data.settings.timeout_seconds, 5);
        assert_eq!(store.data.secrets["openaiApiKey"], "k");

        let reloaded = AiStore::new(dir.path().join("ai.json"));
        assert_eq!(reloaded.data.secrets["openaiApiKey"], "k");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("ai.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        store.update(None, json!({ "openaiApiKey": null }).as_object().cloned()).unwrap();
        assert!(store.data.secrets.is_empty());
        assert!(store.update(json!({ "provider": "x" }).as_object().cloned(), None).is_err());
        assert!(store.update(None, json!({ "nope": "k" }).as_object().cloned()).is_err());
    }

    #[test]
    fn parses_responses_and_errors() {
        assert_eq!(parse_response("{\"a\":1}\n200", "").unwrap()["a"], 1);
        let e = parse_response("{\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n529", "Retry-After: 2\r\n").unwrap_err();
        assert_eq!(e.message, "API error (HTTP 529, overloaded_error): busy");
        assert!(e.retryable);
        assert_eq!(e.retry_after, Some(2.0));
        let e = parse_response("{\"error\":{\"message\":\"bad key\"}}\n401", "").unwrap_err();
        assert!(!e.retryable);
        assert!(parse_response("<html>\n200", "").is_err());
    }

    #[test]
    fn quotes_and_hosts() {
        assert_eq!(curl_quote("a\"b\\c\nd"), "\"a\\\"b\\\\cd\"");
        assert_eq!(host_of("https://user:pw@api.example.com:8443/v1/x?y"), "api.example.com:8443");
        assert_eq!(percent_encode("models/x y"), "models%2Fx%20y");
        assert_eq!(join_url("https://h/", "/v1/messages"), "https://h/v1/messages");
    }

    /// An HTTP server answering one connection per (status line, extra headers, body), in order.
    fn serve(responses: Vec<(&'static str, &'static str, &'static str)>) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for (stream, (status, headers, body)) in listener.incoming().zip(responses) {
                let mut stream = stream.unwrap();
                let mut buf = vec![0u8; 65536];
                let mut seen = Vec::new();
                // the request body is JSON, so it ends with a closing brace
                while !String::from_utf8_lossy(&seen).ends_with('}') {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    seen.extend_from_slice(&buf[..n]);
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let response = format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (url, hits)
    }

    fn resolved(base_url: String) -> Resolved {
        Resolved {
            provider: "openai",
            credential: "openaiApiKey",
            secret: "k".into(),
            model: "m".into(),
            base_url,
            timeout_seconds: 10,
            attempts: 3,
            env: vec![("NO_PROXY".into(), "*".into()), ("no_proxy".into(), "*".into())],
        }
    }

    #[tokio::test]
    async fn retries_transient_errors_through_curl() {
        let (url, hits) = serve(vec![
            ("503 Service Unavailable", "Retry-After: 0\r\n", "{}"),
            ("200 OK", "Content-Type: application/json\r\n", r#"{"choices":[{"message":{"content":"fix: it"}}]}"#),
        ]);
        let text = complete(&resolved(url), "hi", None).await.unwrap();
        assert_eq!(text, "fix: it");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn does_not_retry_auth_errors() {
        let (url, hits) = serve(vec![("401 Unauthorized", "", r#"{"error":{"message":"bad key 1"}}"#)]);
        let err = complete(&resolved(url), "hi", None).await.unwrap_err();
        assert_eq!(err, "API error (HTTP 401): bad key 1");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
