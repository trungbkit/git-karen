// Hosting integrations (plan 07): pull requests, CI status and PR creation on GitHub and GitLab with the user's own
// personal access tokens. No account or cloud of ours sits in between.
//
// - Tokens live in the OS keychain (secrets.rs), keyed by host. integrations.json only holds the self-hosted host
//   list and the login names a connection test returned. Tokens never cross into the webview: it learns whether a
//   host has one, nothing more.
// - Every API call is made here, through curl (http.rs).
// - The provider comes from the remote URL (remote.rs): the public hosts are built in, self-hosted ones configured.
mod github;
mod gitlab;
pub mod http;
pub mod remote;
pub mod secrets;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::git::exec::{git, Opts};
use crate::git::service::Args;
use http::{Request, Response};
use remote::{HostConfig, Kind, Provider, RepoRef};
use secrets::{Keychain, SecretStore};

const TIMEOUT_SECS: u32 = 20;
/// CI results that may still change are refetched at most this often, whatever the caller asks
const MIN_PENDING_AGE: Duration = Duration::from_secs(30);
/// Commits without any check are rechecked at most this often (CI may not have started yet)
const MIN_NONE_AGE: Duration = Duration::from_secs(600);
/// Shas fetched per CI request
const MAX_CI_SHAS: usize = 100;
const MAX_CI_CACHE: usize = 20_000;
/// The public hosts shown in Preferences even before a token is added (the others are configured)
const BUILTIN_HOSTS: [&str; 2] = ["github.com", "gitlab.com"];

// ------------------------------------------------------------------ model

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CiState {
    Pending,
    Success,
    Failure,
    /// Skipped, neutral or cancelled
    Neutral,
}

impl CiState {
    pub fn is_final(self) -> bool {
        self != CiState::Pending
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CiCheck {
    pub name: String,
    pub state: CiState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CiStatus {
    pub state: CiState,
    pub checks: Vec<CiCheck>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub draft: bool,
    pub head_branch: String,
    /// Path of the repository the head branch lives in, when known
    pub head_repo: Option<String>,
    /// The head branch is in the same repository (not a fork)
    pub same_repo: bool,
    pub base_branch: String,
    /// ISO 8601
    pub updated_at: String,
    /// Combined check state of the head commit, when the provider lists it
    pub checks: Option<CiState>,
    pub reviewers: Vec<String>,
    /// The connected user is a requested reviewer
    pub review_requested: bool,
    /// Opened by the connected user
    pub mine: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PullRequestList {
    pub viewer: Option<String>,
    pub items: Vec<PullRequest>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CreatePrInput {
    /// Remote of the repository the PR is opened in (default: upstream, origin, first remote)
    pub base_remote: Option<String>,
    /// Remote the head branch was pushed to (default: the base remote)
    pub head_remote: Option<String>,
    pub base: String,
    pub head: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
    pub reviewers: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CreatedPr {
    pub number: u64,
    pub url: String,
    /// A PR between these branches was already open; this is that one
    pub existing: bool,
    /// Created, but something optional failed (e.g. requesting reviewers)
    pub warning: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub host: String,
    pub kind: Kind,
    pub label: &'static str,
    pub api_url: String,
    pub web_url: String,
    pub built_in: bool,
    pub api_supported: bool,
    pub has_token: bool,
    /// Login name from the last successful connection test
    pub user: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoHosting {
    pub remote: String,
    pub kind: Kind,
    pub label: &'static str,
    pub host: String,
    pub path: String,
    pub owner: String,
    pub name: String,
    pub web_url: String,
    /// Issue URL with `$1` standing for the number
    pub issue_url: String,
    pub api_supported: bool,
    /// A token is set for the host
    pub connected: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Viewer {
    pub user: String,
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
struct IntegrationsFile {
    hosts: Vec<HostConfig>,
    /// host → login from the last connection test (not a secret)
    users: BTreeMap<String, String>,
}

struct CiEntry {
    status: Option<CiStatus>,
    at: Instant,
}

impl CiEntry {
    fn fresh(&self, max_age: Duration) -> bool {
        match &self.status {
            Some(s) if s.state.is_final() => true,
            Some(_) => self.at.elapsed() < max_age.max(MIN_PENDING_AGE),
            None => self.at.elapsed() < max_age.max(MIN_NONE_AGE),
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Percent-encode a path segment or query value.
pub fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn is_full_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// -------------------------------------------------------------------- api

/// An authenticated client for one provider. Tracks rate limits per host so background polling backs off.
pub struct Api<'a> {
    pub provider: &'a Provider,
    token: String,
    env: &'a [(String, String)],
    limits: &'a Mutex<HashMap<String, u64>>,
}

impl Api<'_> {
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.provider.api_url)
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut h = vec![("Authorization".to_string(), format!("Bearer {}", self.token)), ("User-Agent".to_string(), "Karen".to_string())];
        if self.provider.kind == Kind::Github {
            h.push(("Accept".into(), "application/vnd.github+json".into()));
            h.push(("X-GitHub-Api-Version".into(), "2022-11-28".into()));
        } else {
            h.push(("Accept".into(), "application/json".into()));
        }
        h
    }

    /// Seconds until the host accepts requests again, when a rate limit was hit.
    fn blocked_for(&self) -> Option<u64> {
        let until = *self.limits.lock().unwrap().get(&self.provider.host)?;
        let now = now_secs();
        (until > now).then(|| until - now)
    }

    fn note_limits(&self, res: &Response) {
        let remaining = res.header("x-ratelimit-remaining").or(res.header("ratelimit-remaining")).and_then(|v| v.parse::<u64>().ok());
        let reset = res.header("x-ratelimit-reset").or(res.header("ratelimit-reset")).and_then(|v| v.parse::<u64>().ok());
        let retry_after = res.header("retry-after").and_then(|v| v.parse::<u64>().ok());
        let until = if res.status == 429 || (res.status == 403 && (remaining == Some(0) || retry_after.is_some())) {
            Some(retry_after.map(|s| now_secs() + s).or(reset).unwrap_or(now_secs() + 60))
        } else if remaining == Some(0) {
            reset
        } else {
            None
        };
        if let Some(until) = until {
            self.limits.lock().unwrap().insert(self.provider.host.clone(), until);
        }
    }

    pub async fn call(&self, method: &str, url: &str, body: Option<&Value>) -> Result<Response, String> {
        if let Some(wait) = self.blocked_for() {
            return Err(format!("{} rate limit reached; requests resume in {} min.", self.provider.kind.label(), wait.div_ceil(60)));
        }
        let res = http::send(Request { method, url, headers: self.headers(), body }, TIMEOUT_SECS, self.env).await?;
        self.note_limits(&res);
        Ok(res)
    }

    /// A JSON request that must succeed (2xx).
    pub async fn json(&self, method: &str, url: &str, body: Option<&Value>) -> Result<Value, String> {
        let res = self.call(method, url, body).await?;
        if res.ok() {
            Ok(res.json())
        } else {
            Err(api_error(self.provider.kind, &res))
        }
    }
}

fn message_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        // GitLab validation errors: {"message": {"title": ["can't be blank"]}}
        Value::Object(m) if !m.is_empty() => Some(
            m.iter()
                .map(|(k, v)| format!("{k} {}", v.as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_else(|| v.to_string())))
                .collect::<Vec<_>>()
                .join("; "),
        ),
        Value::Array(a) if !a.is_empty() => Some(a.iter().filter_map(|x| message_of(&x["message"]).or_else(|| message_of(x))).collect::<Vec<_>>().join("; ")),
        _ => None,
    }
}

pub fn api_error(kind: Kind, res: &Response) -> String {
    let body = res.json();
    let mut detail = message_of(&body["message"]).or_else(|| message_of(&body["error"])).or_else(|| message_of(&body["errors"]));
    // GitHub: "Validation Failed" says nothing; the errors array has the reason
    if detail.as_deref() == Some("Validation Failed") {
        if let Some(more) = message_of(&body["errors"]) {
            detail = Some(format!("Validation Failed: {more}"));
        }
    }
    let mut msg = format!("{} API error (HTTP {})", kind.label(), res.status);
    if let Some(d) = detail {
        msg.push_str(&format!(": {d}"));
    }
    if res.status == 401 {
        msg.push_str(". Check the token in Preferences > Integrations.");
    }
    msg
}

// ----------------------------------------------------------------- service

pub struct Integrations {
    file: PathBuf,
    data: Mutex<IntegrationsFile>,
    secrets: Arc<dyn SecretStore>,
    /// Tokens read from the keychain this session (None = known to be absent)
    tokens: Mutex<HashMap<String, Option<String>>>,
    viewers: Mutex<HashMap<String, String>>,
    ci: Mutex<HashMap<String, HashMap<String, CiEntry>>>,
    limits: Mutex<HashMap<String, u64>>,
    env: OnceCell<Vec<(String, String)>>,
}

async fn git_out(repo: &str, args: &[&str]) -> Result<String, String> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    Ok(git(Path::new(repo), &args, Opts::read()).await?.stdout.trim().to_string())
}

async fn git_write(repo: &str, args: &[&str]) -> Result<(), String> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    git(Path::new(repo), &args, Opts::default()).await.map(|_| ())
}

fn safe_name(name: &str, what: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || name.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("Invalid {what}: {name}"));
    }
    Ok(())
}

/// Fetch a PR's head and check it out. Same-repository PRs check out their real branch (tracking the remote);
/// fork PRs go to `pr/<n>` (GitHub) or `mr/<n>` (GitLab) from the provider's read-only PR ref. Never forces:
/// a local `pr/<n>` with commits of its own makes the fetch fail instead of losing them.
async fn checkout_pr(repo: &str, remote: &str, kind: Kind, number: u64, head_branch: &str, same_repo: bool) -> Result<String, String> {
    let current = git_out(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).await.unwrap_or_default();
    if same_repo && !head_branch.is_empty() {
        safe_name(head_branch, "branch name")?;
        let tracking = format!("refs/remotes/{remote}/{head_branch}");
        git_write(repo, &["fetch", "--no-tags", remote, &format!("+refs/heads/{head_branch}:{tracking}")]).await?;
        let exists = git_out(repo, &["rev-parse", "--verify", "-q", &format!("refs/heads/{head_branch}")]).await.is_ok_and(|o| !o.is_empty());
        if current != head_branch {
            if exists {
                git_write(repo, &["checkout", "-q", head_branch]).await?;
            } else {
                git_write(repo, &["checkout", "-q", "-b", head_branch, "--track", &format!("{remote}/{head_branch}")]).await?;
            }
        }
        return Ok(head_branch.to_string());
    }
    let (src, local) = match kind {
        Kind::Github => (format!("refs/pull/{number}/head"), format!("pr/{number}")),
        Kind::Gitlab => (format!("refs/merge-requests/{number}/head"), format!("mr/{number}")),
        k => return Err(format!("Checking out pull requests from {} is not supported.", k.label())),
    };
    if current == local {
        git_write(repo, &["fetch", "--no-tags", remote, &src]).await?;
        git_write(repo, &["merge", "--ff-only", "-q", "FETCH_HEAD"]).await?;
    } else {
        git_write(repo, &["fetch", "--no-tags", remote, &format!("{src}:refs/heads/{local}")])
            .await
            .map_err(|e| if e.contains("non-fast-forward") || e.contains("rejected") { format!("{local} has commits the pull request doesn't; rename or delete it first.\n{e}") } else { e })?;
        git_write(repo, &["checkout", "-q", &local]).await?;
    }
    Ok(local)
}

impl Integrations {
    pub fn new(file: PathBuf) -> Self {
        Self::with_store(file, Arc::new(Keychain))
    }

    pub fn with_store(file: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        let data = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Integrations {
            file,
            data: Mutex::new(data),
            secrets,
            tokens: Mutex::default(),
            viewers: Mutex::default(),
            ci: Mutex::default(),
            limits: Mutex::default(),
            env: OnceCell::new(),
        }
    }

    fn save(&self) -> Result<(), String> {
        let data = self.data.lock().unwrap().clone();
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }

    async fn env(&self) -> &[(String, String)] {
        self.env.get_or_init(crate::ai::proxy_env).await
    }

    fn hosts(&self) -> Vec<HostConfig> {
        self.data.lock().unwrap().hosts.clone()
    }

    /// The provider a token for `host` is used with.
    fn provider_for_host(&self, host: &str) -> Option<Provider> {
        let host = host.trim().to_ascii_lowercase();
        if let Some(cfg) = self.hosts().iter().find(|h| h.host == host) {
            return Some(remote::configured_provider(cfg));
        }
        BUILTIN_HOSTS.contains(&host.as_str()).then(|| remote::builtin_provider(&host)).flatten()
    }

    async fn token(&self, host: &str) -> Result<Option<String>, String> {
        if let Some(t) = self.tokens.lock().unwrap().get(host) {
            return Ok(t.clone());
        }
        let (store, key) = (self.secrets.clone(), host.to_string());
        let t = tokio::task::spawn_blocking(move || store.get(&key)).await.map_err(|e| e.to_string())??;
        self.tokens.lock().unwrap().insert(host.to_string(), t.clone());
        Ok(t)
    }

    async fn api<'a>(&'a self, provider: &'a Provider) -> Result<Api<'a>, String> {
        if !provider.kind.api_supported() {
            return Err(format!("{} is not supported yet; only web links are available.", provider.kind.label()));
        }
        let token = self.token(&provider.host).await?.ok_or_else(|| {
            format!("No {} token for {}. Add one in Preferences > Integrations.", provider.kind.label(), provider.host)
        })?;
        Ok(Api { provider, token, env: self.env().await, limits: &self.limits })
    }

    // ------------------------------------------------------------ accounts

    pub async fn accounts(&self) -> Result<Vec<Account>, String> {
        let users = self.data.lock().unwrap().users.clone();
        let mut providers: Vec<(Provider, bool)> = BUILTIN_HOSTS.iter().filter_map(|h| remote::builtin_provider(h)).map(|p| (p, true)).collect();
        providers.extend(self.hosts().iter().map(|h| (remote::configured_provider(h), false)));
        let mut out = vec![];
        for (p, built_in) in providers {
            // an unreadable keychain entry shows as "no token" rather than failing the whole list
            let has_token = self.token(&p.host).await.ok().flatten().is_some();
            out.push(Account {
                user: users.get(&p.host).cloned(),
                host: p.host,
                kind: p.kind,
                label: p.kind.label(),
                api_url: p.api_url,
                web_url: p.web_url,
                built_in,
                api_supported: p.kind.api_supported(),
                has_token,
            });
        }
        Ok(out)
    }

    pub fn save_host(&self, cfg: HostConfig) -> Result<(), String> {
        // accept a pasted URL: keep just the host name (remotes are matched without user or port)
        let raw = cfg.host.trim().to_ascii_lowercase();
        let rest = raw.split_once("://").map(|(_, r)| r).unwrap_or(&raw);
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
        let host = authority.split(':').next().unwrap_or("").to_string();
        if host.is_empty() || host.chars().any(|c| c.is_whitespace()) {
            return Err("Enter a host name, e.g. gitlab.example.com".into());
        }
        if BUILTIN_HOSTS.contains(&host.as_str()) {
            return Err(format!("{host} is built in; add its token directly."));
        }
        for url in [&cfg.api_url, &cfg.web_url] {
            let u = url.trim().to_ascii_lowercase();
            if !u.is_empty() && !u.starts_with("https://") && !u.starts_with("http://") {
                return Err(format!("Not an http(s) URL: {url}"));
            }
        }
        let cfg = HostConfig { host: host.clone(), kind: cfg.kind, api_url: cfg.api_url.trim().to_string(), web_url: cfg.web_url.trim().to_string() };
        {
            let mut data = self.data.lock().unwrap();
            match data.hosts.iter_mut().find(|h| h.host == host) {
                Some(existing) => *existing = cfg,
                None => data.hosts.push(cfg),
            }
        }
        self.save()
    }

    pub async fn remove_host(&self, host: &str) -> Result<(), String> {
        self.set_token(host, None).await?;
        self.data.lock().unwrap().hosts.retain(|h| h.host != host);
        self.save()
    }

    pub async fn set_token(&self, host: &str, token: Option<String>) -> Result<(), String> {
        if self.provider_for_host(host).is_none() {
            return Err(format!("Unknown host: {host}"));
        }
        let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        if token.as_ref().is_some_and(|t| t.chars().any(|c| c.is_whitespace() || c.is_control())) {
            return Err("A token cannot contain spaces or line breaks.".into());
        }
        let (store, key, value) = (self.secrets.clone(), host.to_string(), token.clone());
        tokio::task::spawn_blocking(move || match value {
            Some(t) => store.set(&key, &t),
            None => store.delete(&key),
        })
        .await
        .map_err(|e| e.to_string())??;
        self.tokens.lock().unwrap().insert(host.to_string(), token);
        self.viewers.lock().unwrap().remove(host);
        self.limits.lock().unwrap().remove(host);
        self.data.lock().unwrap().users.remove(host);
        self.ci.lock().unwrap().clear();
        self.save()
    }

    /// Call the API as the token's user; remembers the login name.
    pub async fn test(&self, host: &str) -> Result<Viewer, String> {
        let provider = self.provider_for_host(host).ok_or_else(|| format!("Unknown host: {host}"))?;
        let api = self.api(&provider).await?;
        let viewer = match provider.kind {
            Kind::Github => github::viewer(&api).await?,
            _ => gitlab::viewer(&api).await?,
        };
        self.viewers.lock().unwrap().insert(provider.host.clone(), viewer.user.clone());
        self.data.lock().unwrap().users.insert(provider.host.clone(), viewer.user.clone());
        self.save()?;
        Ok(viewer)
    }

    async fn viewer_login(&self, api: &Api<'_>) -> Option<String> {
        if let Some(v) = self.viewers.lock().unwrap().get(&api.provider.host) {
            return Some(v.clone());
        }
        let v = match api.provider.kind {
            Kind::Github => github::viewer(api).await,
            _ => gitlab::viewer(api).await,
        }
        .ok()?;
        self.viewers.lock().unwrap().insert(api.provider.host.clone(), v.user.clone());
        Some(v.user)
    }

    // --------------------------------------------------------------- repos

    /// The remote PRs and issues belong to: upstream (fork setups), origin, or the first remote.
    async fn pick_remote(repo: &str) -> Result<String, String> {
        let names = git_out(repo, &["remote"]).await?;
        let names: Vec<&str> = names.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        ["upstream", "origin"]
            .iter()
            .find(|n| names.contains(n))
            .map(|n| n.to_string())
            .or_else(|| names.first().map(|n| n.to_string()))
            .ok_or_else(|| "This repository has no remotes".to_string())
    }

    async fn repo_ref(&self, repo: &str, remote: Option<String>) -> Result<(String, RepoRef), String> {
        let remote = match remote.filter(|r| !r.is_empty()) {
            Some(r) => r,
            None => Self::pick_remote(repo).await?,
        };
        safe_name(&remote, "remote name")?;
        let url = git_out(repo, &["remote", "get-url", &remote]).await?;
        let r = remote::resolve(&url, &self.hosts()).ok_or_else(|| format!("{remote} is not on a recognized hosting provider. Self-hosted? Add the host in Preferences > Integrations."))?;
        Ok((remote, r))
    }

    pub async fn repo_info(&self, repo: &str, remote: Option<String>) -> Result<Option<RepoHosting>, String> {
        let Ok((remote, r)) = self.repo_ref(repo, remote).await else { return Ok(None) };
        let connected = r.provider.kind.api_supported() && self.token(&r.provider.host).await.ok().flatten().is_some();
        Ok(Some(RepoHosting {
            remote,
            kind: r.provider.kind,
            label: r.provider.kind.label(),
            host: r.provider.host.clone(),
            issue_url: remote::issue_url_template(&r),
            path: r.path,
            owner: r.owner,
            name: r.name,
            web_url: r.web_url,
            api_supported: r.provider.kind.api_supported(),
            connected,
        }))
    }

    pub async fn pull_requests(&self, repo: &str, remote: Option<String>) -> Result<PullRequestList, String> {
        let (_, r) = self.repo_ref(repo, remote).await?;
        let api = self.api(&r.provider).await?;
        match r.provider.kind {
            Kind::Github => github::pull_requests(&api, &r).await,
            _ => {
                let viewer = self.viewer_login(&api).await;
                gitlab::merge_requests(&api, &r, viewer).await
            }
        }
    }

    pub async fn reviewer_suggestions(&self, repo: &str, remote: Option<String>) -> Result<Vec<String>, String> {
        let (_, r) = self.repo_ref(repo, remote).await?;
        let api = self.api(&r.provider).await?;
        match r.provider.kind {
            Kind::Github => github::assignable_users(&api, &r).await,
            _ => gitlab::members(&api, &r).await,
        }
    }

    pub async fn create_pull_request(&self, repo: &str, input: CreatePrInput) -> Result<CreatedPr, String> {
        if input.title.trim().is_empty() {
            return Err("A title is required.".into());
        }
        safe_name(&input.base, "base branch")?;
        safe_name(&input.head, "head branch")?;
        let (base_remote, base) = self.repo_ref(repo, input.base_remote.clone()).await?;
        let head = match input.head_remote.clone().filter(|h| *h != base_remote) {
            Some(h) => self.repo_ref(repo, Some(h)).await?.1,
            None => base.clone(),
        };
        if head.provider.host != base.provider.host {
            return Err("The head and base repositories are on different hosts.".into());
        }
        let api = self.api(&base.provider).await?;
        match base.provider.kind {
            Kind::Github => github::create_pull_request(&api, &base, &head, &input).await,
            _ => gitlab::create_merge_request(&api, &base, &head, &input).await,
        }
    }

    /// Fetch a PR's head and check it out. Same-repository PRs check out their real branch (tracking the remote);
    /// fork PRs go to `pr/<n>` (GitHub) or `mr/<n>` (GitLab) from the provider's read-only PR ref. Never forces:
    /// a local `pr/<n>` with commits of its own makes the fetch fail instead of losing them.
    pub async fn checkout_pull_request(&self, repo: &str, remote: Option<String>, number: u64, head_branch: String, same_repo: bool) -> Result<String, String> {
        let (remote, r) = self.repo_ref(repo, remote).await?;
        checkout_pr(repo, &remote, r.provider.kind, number, &head_branch, same_repo).await
    }

    /// CI status of commits, from the cache when fresh. Final results are kept for the session; pending ones are
    /// refetched when older than `max_age_secs` (at least 30s), commits without checks every 10 minutes. Polling is
    /// best effort: no token, unsupported providers, rate limits and errors just return what is cached.
    pub async fn ci_statuses(&self, repo: &str, remote: Option<String>, shas: Vec<String>, max_age_secs: u64) -> Result<HashMap<String, CiStatus>, String> {
        let Ok((_, r)) = self.repo_ref(repo, remote).await else { return Ok(HashMap::new()) };
        let key = format!("{}|{}", r.provider.api_url, r.path);
        let shas: Vec<String> = shas.into_iter().map(|s| s.to_ascii_lowercase()).filter(|s| is_full_sha(s)).take(MAX_CI_SHAS * 2).collect();
        let max_age = Duration::from_secs(max_age_secs);
        let stale: Vec<String> = {
            let cache = self.ci.lock().unwrap();
            let known = cache.get(&key);
            shas.iter().filter(|s| !known.and_then(|k| k.get(*s)).is_some_and(|e| e.fresh(max_age))).take(MAX_CI_SHAS).cloned().collect()
        };
        if !stale.is_empty() && r.provider.kind.api_supported() {
            if let Ok(api) = self.api(&r.provider).await {
                if api.blocked_for().is_none() {
                    let fetched = match r.provider.kind {
                        Kind::Github => github::ci_statuses(&api, &r, &stale).await,
                        _ => gitlab::ci_statuses(&api, &r, &stale).await,
                    };
                    if let Ok(fetched) = fetched {
                        let mut cache = self.ci.lock().unwrap();
                        if cache.values().map(HashMap::len).sum::<usize>() > MAX_CI_CACHE {
                            cache.clear();
                        }
                        let entries = cache.entry(key.clone()).or_default();
                        for (sha, status) in fetched {
                            entries.insert(sha, CiEntry { status, at: Instant::now() });
                        }
                    }
                }
            }
        }
        let cache = self.ci.lock().unwrap();
        let Some(known) = cache.get(&key) else { return Ok(HashMap::new()) };
        Ok(shas.iter().filter_map(|s| known.get(s).and_then(|e| e.status.clone()).map(|st| (s.clone(), st))).collect())
    }

    // ------------------------------------------------------------- dispatch

    pub async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        let a = Args(args);
        fn v<T: Serialize>(x: T) -> Result<Value, String> {
            serde_json::to_value(x).map_err(|e| e.to_string())
        }
        match method {
            "accounts" => v(self.accounts().await?),
            "saveHost" => {
                self.save_host(a.get(0)?)?;
                v(self.accounts().await?)
            }
            "removeHost" => {
                self.remove_host(&a.get::<String>(0)?).await?;
                v(self.accounts().await?)
            }
            "setToken" => {
                self.set_token(&a.get::<String>(0)?, a.get(1)?).await?;
                v(self.accounts().await?)
            }
            "test" => v(self.test(&a.get::<String>(0)?).await?),
            "repoInfo" => v(self.repo_info(&a.get::<String>(0)?, a.get(1)?).await?),
            "pullRequests" => v(self.pull_requests(&a.get::<String>(0)?, a.get(1)?).await?),
            "reviewerSuggestions" => v(self.reviewer_suggestions(&a.get::<String>(0)?, a.get(1)?).await?),
            "createPullRequest" => v(self.create_pull_request(&a.get::<String>(0)?, a.get(1)?).await?),
            "checkoutPullRequest" => v(self
                .checkout_pull_request(&a.get::<String>(0)?, a.get(1)?, a.get(2)?, a.get::<Option<String>>(3)?.unwrap_or_default(), a.get::<Option<bool>>(4)?.unwrap_or(false))
                .await?),
            "ciStatuses" => v(self.ci_statuses(&a.get::<String>(0)?, a.get(1)?, a.get(2)?, a.get::<Option<u64>>(3)?.unwrap_or(60)).await?),
            _ => Err(format!("Unknown method: {method}")),
        }
    }
}

#[tauri::command]
pub async fn integrations_call(state: tauri::State<'_, Integrations>, method: String, args: Vec<Value>) -> Result<Value, String> {
    state.call(&method, args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrets::MemoryStore;

    fn service(dir: &Path) -> Integrations {
        let s = Integrations::with_store(dir.join("integrations.json"), Arc::new(MemoryStore::default()));
        s.env.set(http::tests::no_proxy()).unwrap();
        s
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[tokio::test]
    async fn tokens_stay_out_of_files_and_status() {
        let dir = tempfile::tempdir().unwrap();
        let s = service(dir.path());
        s.save_host(HostConfig { host: "https://me@GitLab.Corp.io:8443/x".into(), kind: Kind::Gitlab, ..Default::default() }).unwrap();
        s.set_token("gitlab.corp.io", Some(" glpat-SECRET123 ".into())).await.unwrap();
        s.set_token("github.com", Some("ghp_SECRET456".into())).await.unwrap();

        let accounts = s.accounts().await.unwrap();
        let corp = accounts.iter().find(|a| a.host == "gitlab.corp.io").unwrap();
        assert!(corp.has_token && !corp.built_in);
        assert_eq!(corp.api_url, "https://gitlab.corp.io/api/v4");
        assert!(accounts.iter().find(|a| a.host == "github.com").unwrap().has_token);
        assert!(!accounts.iter().find(|a| a.host == "gitlab.com").unwrap().has_token);

        let json = serde_json::to_string(&accounts).unwrap();
        let file = std::fs::read_to_string(dir.path().join("integrations.json")).unwrap();
        for secret in ["SECRET123", "SECRET456"] {
            assert!(!json.contains(secret));
            assert!(!file.contains(secret));
        }
        assert_eq!(s.token("gitlab.corp.io").await.unwrap().as_deref(), Some("glpat-SECRET123"));

        assert!(s.set_token("evil.example.com", Some("x".into())).await.is_err());
        assert!(s.set_token("github.com", Some("two words".into())).await.is_err());
        assert!(s.save_host(HostConfig { host: "github.com".into(), ..Default::default() }).is_err());
        assert!(s.save_host(HostConfig { host: "h.io".into(), api_url: "ftp://h.io".into(), ..Default::default() }).is_err());

        s.remove_host("gitlab.corp.io").await.unwrap();
        assert!(s.secrets.get("gitlab.corp.io").unwrap().is_none());
        assert!(!s.accounts().await.unwrap().iter().any(|a| a.host == "gitlab.corp.io"));
        // the host list survives a restart
        s.save_host(HostConfig { host: "git.corp.io".into(), kind: Kind::Github, ..Default::default() }).unwrap();
        let reloaded = service(dir.path());
        assert_eq!(reloaded.hosts()[0].host, "git.corp.io");
    }

    #[tokio::test]
    async fn resolves_repo_hosting_from_the_preferred_remote() {
        let dir = tempfile::tempdir().unwrap();
        sh(dir.path(), &["init", "-q"]);
        sh(dir.path(), &["remote", "add", "origin", "git@github.com:me/fork.git"]);
        let s = service(dir.path());
        let repo = dir.path().to_str().unwrap();
        let info = s.repo_info(repo, None).await.unwrap().unwrap();
        assert_eq!((info.remote.as_str(), info.path.as_str(), info.kind), ("origin", "me/fork", Kind::Github));
        assert!(!info.connected);
        assert_eq!(info.issue_url, "https://github.com/me/fork/issues/$1");

        sh(dir.path(), &["remote", "add", "upstream", "https://gitlab.com/team/sub/app.git"]);
        let info = s.repo_info(repo, None).await.unwrap().unwrap();
        assert_eq!((info.remote.as_str(), info.path.as_str()), ("upstream", "team/sub/app"));
        assert_eq!(s.repo_info(repo, Some("origin".into())).await.unwrap().unwrap().path, "me/fork");
        assert!(s.repo_info(repo, Some("--upload-pack=x".into())).await.unwrap().is_none());
        // without a token, CI polling is silently empty and PR listing explains what to do
        assert!(s.ci_statuses(repo, None, vec!["a".repeat(40)], 60).await.unwrap().is_empty());
        assert!(s.pull_requests(repo, Some("origin".into())).await.unwrap_err().contains("Preferences > Integrations"));
    }

    #[tokio::test]
    async fn checks_out_fork_pull_requests_from_the_pr_ref() {
        let dir = tempfile::tempdir().unwrap();
        let (server, clone) = (dir.path().join("server"), dir.path().join("clone"));
        std::fs::create_dir_all(&server).unwrap();
        sh(&server, &["init", "-q", "-b", "main"]);
        sh(&server, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
        sh(&server, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "pr work"]);
        sh(&server, &["update-ref", "refs/pull/7/head", "HEAD"]);
        sh(&server, &["reset", "-q", "--hard", "HEAD~1"]);
        sh(dir.path(), &["clone", "-q", server.to_str().unwrap(), "clone"]);

        let repo = clone.to_str().unwrap();
        let branch = checkout_pr(repo, "origin", Kind::Github, 7, "feature", false).await.unwrap();
        assert_eq!(branch, "pr/7");
        assert_eq!(git_out(repo, &["log", "-1", "--format=%s"]).await.unwrap(), "pr work");
        assert_eq!(git_out(repo, &["symbolic-ref", "--short", "HEAD"]).await.unwrap(), "pr/7");
        // again while on it: fast-forwards
        assert_eq!(checkout_pr(repo, "origin", Kind::Github, 7, "", false).await.unwrap(), "pr/7");
        // same-repository PRs check out the real branch, tracking the remote
        sh(&server, &["branch", "topic", "refs/pull/7/head"]);
        assert_eq!(checkout_pr(repo, "origin", Kind::Github, 8, "topic", true).await.unwrap(), "topic");
        assert_eq!(git_out(repo, &["rev-parse", "--abbrev-ref", "topic@{upstream}"]).await.unwrap(), "origin/topic");
        assert!(checkout_pr(repo, "origin", Kind::Github, 8, "-x", true).await.is_err());
        assert!(checkout_pr(repo, "origin", Kind::Bitbucket, 9, "", false).await.is_err());
    }

    #[test]
    fn ci_cache_freshness() {
        let st = |state| Some(CiStatus { state, checks: vec![] });
        let old = Instant::now() - Duration::from_secs(120);
        assert!(CiEntry { status: st(CiState::Success), at: old }.fresh(Duration::from_secs(60)));
        assert!(!CiEntry { status: st(CiState::Pending), at: old }.fresh(Duration::from_secs(60)));
        // pending results are never refetched more often than every 30s
        assert!(CiEntry { status: st(CiState::Pending), at: Instant::now() - Duration::from_secs(10) }.fresh(Duration::ZERO));
        assert!(CiEntry { status: None, at: old }.fresh(Duration::from_secs(60)));
        assert!(!CiEntry { status: None, at: Instant::now() - Duration::from_secs(700) }.fresh(Duration::from_secs(60)));
    }

    #[test]
    fn formats_api_errors_and_rate_limits() {
        let res = |status, body: &str, headers: Vec<(&str, &str)>| Response {
            status,
            headers: headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: body.into(),
        };
        assert_eq!(
            api_error(Kind::Github, &res(401, r#"{"message":"Bad credentials"}"#, vec![])),
            "GitHub API error (HTTP 401): Bad credentials. Check the token in Preferences > Integrations."
        );
        assert_eq!(
            api_error(Kind::Github, &res(422, r#"{"message":"Validation Failed","errors":[{"message":"A pull request already exists for o:x."}]}"#, vec![])),
            "GitHub API error (HTTP 422): Validation Failed: A pull request already exists for o:x."
        );
        assert_eq!(api_error(Kind::Gitlab, &res(400, r#"{"message":{"title":["can't be blank"]}}"#, vec![])), "GitLab API error (HTTP 400): title can't be blank");

        let provider = remote::builtin_provider("github.com").unwrap();
        let limits = Mutex::new(HashMap::new());
        let api = Api { provider: &provider, token: "t".into(), env: &[], limits: &limits };
        api.note_limits(&res(200, "{}", vec![("x-ratelimit-remaining", "10")]));
        assert!(api.blocked_for().is_none());
        let reset = (now_secs() + 600).to_string();
        api.note_limits(&res(200, "{}", vec![("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", &reset)]));
        assert!(api.blocked_for().is_some_and(|s| s > 500));
    }

    #[test]
    fn encodes_and_validates() {
        assert_eq!(enc("group/sub proj"), "group%2Fsub%20proj");
        assert!(is_full_sha(&"ab".repeat(20)));
        assert!(!is_full_sha("abc123"));
        assert!(!is_full_sha(&"zz".repeat(20)));
        assert!(safe_name("-x", "branch").is_err());
        assert!(safe_name("feature/a", "branch").is_ok());
    }
}
