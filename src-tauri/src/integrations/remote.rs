// Remote URL parsing and hosting provider detection. Pure functions: no network, no git, no keychain.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Github,
    Gitlab,
    Bitbucket,
    Azure,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Github => "GitHub",
            Kind::Gitlab => "GitLab",
            Kind::Bitbucket => "Bitbucket",
            Kind::Azure => "Azure DevOps",
        }
    }

    /// Whether the app talks to this provider's API (the others only get web links).
    pub fn api_supported(self) -> bool {
        matches!(self, Kind::Github | Kind::Gitlab)
    }
}

/// A self-hosted (or aliased) host the user configured. Empty URLs mean the default derived from the host.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HostConfig {
    pub host: String,
    pub kind: Kind,
    pub api_url: String,
    pub web_url: String,
}

/// The parts of a remote URL the hosting layer needs.
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteUrl {
    /// Lower-cased host name, without user or port
    pub host: String,
    /// Port when the URL is http(s) on a non-default port (part of the web address)
    pub port: Option<u16>,
    pub scheme: String,
    /// Repository path without leading/trailing slashes and without ".git"
    pub path: String,
}

/// A hosting provider resolved for a host: where its API and web UI live.
#[derive(Clone, Debug, PartialEq)]
pub struct Provider {
    pub kind: Kind,
    /// Key the token is stored under (the configured host, or the canonical public host)
    pub host: String,
    pub api_url: String,
    pub web_url: String,
    /// Configured by the user, or a built-in public host
    pub configured: bool,
}

/// A repository on a provider.
#[derive(Clone, Debug, PartialEq)]
pub struct RepoRef {
    pub provider: Provider,
    /// Full path: "owner/repo", "group/sub/repo" (GitLab), "org/project/repo" (Azure)
    pub path: String,
    pub owner: String,
    pub name: String,
    pub web_url: String,
}

fn trim_path(p: &str) -> String {
    let p = p.trim().trim_matches('/');
    let p = p.strip_suffix(".git").unwrap_or(p);
    p.trim_end_matches('/').to_string()
}

/// Parse a git remote URL: https://, http://, ssh://, git:// and scp-like `user@host:path`. Local paths → None.
pub fn parse_remote_url(url: &str) -> Option<RemoteUrl> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if !matches!(scheme.as_str(), "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git") {
            return None;
        }
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host_port = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
        let (host, port) = match host_port.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h, p.parse::<u16>().ok()),
            _ => (host_port, None),
        };
        let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
        if host.is_empty() {
            return None;
        }
        let web_port = match (scheme.as_str(), port) {
            ("https", Some(443)) | ("http", Some(80)) => None,
            ("https" | "http", p) => p,
            _ => None,
        };
        let path = trim_path(path);
        return (!path.is_empty()).then_some(RemoteUrl { host, port: web_port, scheme, path });
    }
    // scp-like syntax: [user@]host:path (no slash before the colon)
    let colon = url.find(':')?;
    if url[..colon].contains('/') {
        return None;
    }
    let authority = &url[..colon];
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority).to_ascii_lowercase();
    // "C:\repo" is a Windows path, not a host
    if host.len() <= 1 {
        return None;
    }
    let path = trim_path(&url[colon + 1..]);
    (!path.is_empty()).then_some(RemoteUrl { host, port: None, scheme: "ssh".into(), path })
}

fn origin(scheme: &str, host: &str, port: Option<u16>) -> String {
    let scheme = if scheme == "http" { "http" } else { "https" };
    match port {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    }
}

/// Default API base for a provider kind on a web origin.
pub fn default_api_url(kind: Kind, web_url: &str) -> String {
    let web = web_url.trim_end_matches('/');
    match kind {
        Kind::Github if web == "https://github.com" => "https://api.github.com".into(),
        Kind::Github => format!("{web}/api/v3"),
        Kind::Gitlab => format!("{web}/api/v4"),
        Kind::Bitbucket if web == "https://bitbucket.org" => "https://api.bitbucket.org/2.0".into(),
        Kind::Bitbucket => format!("{web}/rest/api/1.0"),
        Kind::Azure => "https://dev.azure.com".into(),
    }
}

/// GitHub's GraphQL endpoint for a REST base (api.github.com/graphql, or <host>/api/graphql on Enterprise).
pub fn github_graphql_url(api_url: &str) -> String {
    let api = api_url.trim_end_matches('/');
    match api.strip_suffix("/api/v3") {
        Some(base) => format!("{base}/api/graphql"),
        None => format!("{api}/graphql"),
    }
}

/// The provider for a configured host entry.
pub fn configured_provider(cfg: &HostConfig) -> Provider {
    let host = cfg.host.trim().to_ascii_lowercase();
    let web_url = if cfg.web_url.trim().is_empty() { format!("https://{host}") } else { cfg.web_url.trim().trim_end_matches('/').to_string() };
    let api_url = if cfg.api_url.trim().is_empty() { default_api_url(cfg.kind, &web_url) } else { cfg.api_url.trim().trim_end_matches('/').to_string() };
    Provider { kind: cfg.kind, host, api_url, web_url, configured: true }
}

/// The built-in public hosts, by canonical host name.
pub fn builtin_provider(host: &str) -> Option<Provider> {
    let (kind, canonical) = match host {
        "github.com" | "www.github.com" | "ssh.github.com" => (Kind::Github, "github.com"),
        "gitlab.com" | "www.gitlab.com" | "altssh.gitlab.com" => (Kind::Gitlab, "gitlab.com"),
        "bitbucket.org" | "www.bitbucket.org" | "altssh.bitbucket.org" => (Kind::Bitbucket, "bitbucket.org"),
        "dev.azure.com" | "ssh.dev.azure.com" | "vs-ssh.visualstudio.com" => (Kind::Azure, "dev.azure.com"),
        h if h.ends_with(".visualstudio.com") => (Kind::Azure, "dev.azure.com"),
        _ => return None,
    };
    let web_url = format!("https://{canonical}");
    Some(Provider { kind, host: canonical.into(), api_url: default_api_url(kind, &web_url), web_url, configured: false })
}

/// Provider for a parsed remote: configured hosts first, then the public hosts, then a guess from the host name
/// ("gitlab.example.com" → GitLab, "github.example.com" → GitHub Enterprise) so web links still work.
pub fn detect(remote: &RemoteUrl, hosts: &[HostConfig]) -> Option<Provider> {
    if let Some(cfg) = hosts.iter().find(|h| h.host.trim().eq_ignore_ascii_case(&remote.host)) {
        return Some(configured_provider(cfg));
    }
    if let Some(p) = builtin_provider(&remote.host) {
        return Some(p);
    }
    let first = remote.host.split('.').next().unwrap_or("");
    let kind = if first.contains("gitlab") {
        Kind::Gitlab
    } else if first.contains("github") {
        Kind::Github
    } else {
        return None;
    };
    let web_url = origin(&remote.scheme, &remote.host, remote.port);
    Some(Provider { kind, host: remote.host.clone(), api_url: default_api_url(kind, &web_url), web_url, configured: false })
}

/// Resolve a remote URL to a repository on a provider.
pub fn resolve(url: &str, hosts: &[HostConfig]) -> Option<RepoRef> {
    let remote = parse_remote_url(url)?;
    let provider = detect(&remote, hosts)?;
    let mut path = remote.path.clone();
    // a self-hosted instance under a sub-path (https://example.com/gitlab) has that prefix in its https remotes
    if remote.scheme.starts_with("http") {
        if let Some(prefix) = provider.web_url.split_once("://").and_then(|(_, r)| r.split_once('/')).map(|(_, p)| p.trim_matches('/')) {
            if !prefix.is_empty() {
                if let Some(rest) = path.strip_prefix(prefix).and_then(|r| r.strip_prefix('/')) {
                    path = rest.to_string();
                }
            }
        }
    }
    if provider.kind == Kind::Azure {
        return resolve_azure(&remote, provider, &path);
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    // GitHub and Bitbucket repos are always owner/name; GitLab allows nested groups
    let ok = match provider.kind {
        Kind::Gitlab => segments.len() >= 2,
        _ => segments.len() == 2,
    };
    if !ok {
        return None;
    }
    let path = segments.join("/");
    let (owner, name) = path.rsplit_once('/').map(|(o, n)| (o.to_string(), n.to_string()))?;
    let web_url = format!("{}/{path}", provider.web_url);
    Some(RepoRef { provider, path, owner, name, web_url })
}

/// Azure DevOps: https://dev.azure.com/org/project/_git/repo, git@ssh.dev.azure.com:v3/org/project/repo,
/// https://org.visualstudio.com/[DefaultCollection/]project/_git/repo.
fn resolve_azure(remote: &RemoteUrl, provider: Provider, path: &str) -> Option<RepoRef> {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let (org, project, repo) = if let Some(org) = remote.host.strip_suffix(".visualstudio.com").filter(|o| *o != "vs-ssh") {
        let segs: Vec<&str> = segs.iter().copied().filter(|s| !s.eq_ignore_ascii_case("DefaultCollection")).collect();
        match segs.as_slice() {
            [project, "_git", repo] => (org.to_string(), project.to_string(), repo.to_string()),
            _ => return None,
        }
    } else {
        match segs.as_slice() {
            ["v3", org, project, repo] => (org.to_string(), project.to_string(), repo.to_string()),
            [org, project, "_git", repo] => (org.to_string(), project.to_string(), repo.to_string()),
            _ => return None,
        }
    };
    let web_url = format!("https://dev.azure.com/{org}/{project}/_git/{repo}");
    Some(RepoRef { provider, path: format!("{org}/{project}/{repo}"), owner: format!("{org}/{project}"), name: repo, web_url })
}

/// URL of issue `$1` (the placeholder the renderer substitutes) on the provider.
pub fn issue_url_template(r: &RepoRef) -> String {
    match r.provider.kind {
        Kind::Github | Kind::Bitbucket => format!("{}/issues/$1", r.web_url),
        Kind::Gitlab => format!("{}/-/issues/$1", r.web_url),
        Kind::Azure => format!("https://dev.azure.com/{}/_workitems/edit/$1", r.owner),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(url: &str) -> RemoteUrl {
        parse_remote_url(url).unwrap_or_else(|| panic!("should parse {url}"))
    }

    #[test]
    fn parses_remote_url_forms() {
        let r = p("git@github.com:owner/repo.git");
        assert_eq!((r.host.as_str(), r.path.as_str(), r.scheme.as_str()), ("github.com", "owner/repo", "ssh"));
        assert_eq!(p("https://github.com/owner/repo").path, "owner/repo");
        assert_eq!(p("https://user:secret@GitHub.com/owner/repo.git/").host, "github.com");
        assert_eq!(p("ssh://git@github.com:22/owner/repo.git").path, "owner/repo");
        assert_eq!(p("ssh://git@github.com:22/owner/repo.git").port, None);
        assert_eq!(p("https://git.example.com:8443/team/app.git").port, Some(8443));
        assert_eq!(p("https://git.example.com:443/team/app.git").port, None);
        assert_eq!(p("git://example.org/a/b.git").path, "a/b");
        assert_eq!(p("gitlab.com:group/sub/repo.git").path, "group/sub/repo");
        assert_eq!(parse_remote_url("/srv/git/repo.git"), None);
        assert_eq!(parse_remote_url("../other"), None);
        assert_eq!(parse_remote_url("file:///srv/repo.git"), None);
        assert_eq!(parse_remote_url("C:\\repos\\x"), None);
        assert_eq!(parse_remote_url(""), None);
        assert_eq!(parse_remote_url("https://github.com/"), None);
    }

    #[test]
    fn detects_public_providers() {
        let gh = resolve("git@github.com:octo/hello.git", &[]).unwrap();
        assert_eq!(gh.provider.kind, Kind::Github);
        assert_eq!(gh.provider.api_url, "https://api.github.com");
        assert_eq!((gh.owner.as_str(), gh.name.as_str()), ("octo", "hello"));
        assert_eq!(gh.web_url, "https://github.com/octo/hello");
        assert_eq!(resolve("ssh://git@ssh.github.com:443/octo/hello.git", &[]).unwrap().provider.host, "github.com");

        let gl = resolve("https://gitlab.com/group/sub/proj.git", &[]).unwrap();
        assert_eq!(gl.provider.kind, Kind::Gitlab);
        assert_eq!(gl.provider.api_url, "https://gitlab.com/api/v4");
        assert_eq!((gl.path.as_str(), gl.owner.as_str(), gl.name.as_str()), ("group/sub/proj", "group/sub", "proj"));

        let bb = resolve("git@bitbucket.org:team/app.git", &[]).unwrap();
        assert_eq!(bb.provider.kind, Kind::Bitbucket);
        assert!(!bb.provider.kind.api_supported());

        // GitHub paths are exactly owner/name
        assert_eq!(resolve("https://github.com/a/b/c", &[]), None);
        assert_eq!(resolve("https://example.com/a/b.git", &[]), None);
    }

    #[test]
    fn detects_azure_devops() {
        for url in [
            "https://org@dev.azure.com/org/Proj/_git/repo",
            "git@ssh.dev.azure.com:v3/org/Proj/repo",
            "https://org.visualstudio.com/Proj/_git/repo",
            "https://org.visualstudio.com/DefaultCollection/Proj/_git/repo",
        ] {
            let r = resolve(url, &[]).unwrap_or_else(|| panic!("{url}"));
            assert_eq!(r.provider.kind, Kind::Azure);
            assert_eq!(r.path, "org/Proj/repo", "{url}");
            assert_eq!(r.web_url, "https://dev.azure.com/org/Proj/_git/repo");
            assert_eq!(issue_url_template(&r), "https://dev.azure.com/org/Proj/_workitems/edit/$1");
        }
    }

    #[test]
    fn configured_hosts_win_and_derive_urls() {
        let hosts = vec![
            HostConfig { host: "git.corp.io".into(), kind: Kind::Github, ..Default::default() },
            HostConfig { host: "code.example.com".into(), kind: Kind::Gitlab, api_url: String::new(), web_url: "https://code.example.com/gitlab/".into() },
            // an SSH alias (Host github-work in ~/.ssh/config) for the public GitHub
            HostConfig { host: "github-work".into(), kind: Kind::Github, api_url: "https://api.github.com".into(), web_url: "https://github.com".into() },
        ];
        let ghe = resolve("git@git.corp.io:team/app.git", &hosts).unwrap();
        assert_eq!(ghe.provider.api_url, "https://git.corp.io/api/v3");
        assert_eq!(github_graphql_url(&ghe.provider.api_url), "https://git.corp.io/api/graphql");
        assert_eq!(github_graphql_url("https://api.github.com"), "https://api.github.com/graphql");
        assert!(ghe.provider.configured);

        let gl = resolve("https://code.example.com/gitlab/team/app.git", &hosts).unwrap();
        assert_eq!(gl.path, "team/app");
        assert_eq!(gl.provider.api_url, "https://code.example.com/gitlab/api/v4");
        assert_eq!(gl.web_url, "https://code.example.com/gitlab/team/app");
        assert_eq!(resolve("git@code.example.com:team/app.git", &hosts).unwrap().path, "team/app");

        let alias = resolve("git@github-work:me/dots.git", &hosts).unwrap();
        assert_eq!(alias.provider.host, "github-work");
        assert_eq!(alias.web_url, "https://github.com/me/dots");
    }

    #[test]
    fn guesses_self_hosted_providers_by_name() {
        let gl = resolve("https://gitlab.acme.dev:8443/a/b.git", &[]).unwrap();
        assert_eq!(gl.provider.kind, Kind::Gitlab);
        assert_eq!(gl.web_url, "https://gitlab.acme.dev:8443/a/b");
        assert!(!gl.provider.configured);
        assert_eq!(resolve("git@github.acme.dev:a/b.git", &[]).unwrap().provider.api_url, "https://github.acme.dev/api/v3");
        assert_eq!(issue_url_template(&gl), "https://gitlab.acme.dev:8443/a/b/-/issues/$1");
    }
}
