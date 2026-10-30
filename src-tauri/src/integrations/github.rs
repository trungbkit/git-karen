// GitHub (and GitHub Enterprise) through the GraphQL API where it saves requests (PR list, CI of many commits in
// one query), REST elsewhere.
use std::collections::HashMap;

use serde_json::{json, Value};

use super::remote::{github_graphql_url, RepoRef};
use super::{enc, pr_body, Api, CiCheck, CiState, CiStatus, CreatePrInput, CreatedPr, PullRequest, PullRequestList, Viewer};

/// Commits per CI query; GitHub caps a query's node count, and 50 commits × 50 checks stays well under it
const CI_BATCH: usize = 50;

async fn graphql(api: &Api<'_>, query: &str, variables: Value) -> Result<Value, String> {
    let body = json!({ "query": query, "variables": variables });
    let res = api.json("POST", &github_graphql_url(&api.provider.api_url), Some(&body)).await?;
    let errors: Vec<String> = res["errors"].as_array().map(|a| a.iter().filter_map(|e| e["message"].as_str().map(String::from)).collect()).unwrap_or_default();
    if res["data"].is_null() || (!errors.is_empty() && res["data"]["repository"].is_null() && res["data"]["viewer"].is_null()) {
        return Err(format!("GitHub API error: {}", if errors.is_empty() { "empty response".into() } else { errors.join("; ") }));
    }
    Ok(res["data"].clone())
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

pub async fn viewer(api: &Api<'_>) -> Result<Viewer, String> {
    let v = api.json("GET", &api.url("/user"), None).await?;
    let user = v["login"].as_str().ok_or("GitHub did not return a user for this token")?.to_string();
    Ok(Viewer { user, name: v["name"].as_str().filter(|n| !n.is_empty()).map(String::from) })
}

// ------------------------------------------------------------ pull requests

const PR_QUERY: &str = r#"query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title body url isDraft updatedAt headRefName baseRefName isCrossRepository
        author { login }
        headRepository { nameWithOwner }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}"#;

pub fn rollup_state(state: &str) -> Option<CiState> {
    Some(match state {
        "SUCCESS" => CiState::Success,
        "FAILURE" | "ERROR" => CiState::Failure,
        "PENDING" | "EXPECTED" => CiState::Pending,
        _ => return None,
    })
}

pub fn parse_pull_requests(data: &Value) -> PullRequestList {
    let viewer = data["viewer"]["login"].as_str().map(String::from);
    let nodes = data["repository"]["pullRequests"]["nodes"].as_array().cloned().unwrap_or_default();
    let items = nodes
        .iter()
        .filter(|n| n.is_object())
        .map(|n| {
            let author = s(&n["author"]["login"]);
            let reviewers: Vec<String> = n["reviewRequests"]["nodes"]
                .as_array()
                .map(|a| a.iter().filter_map(|r| r["requestedReviewer"]["login"].as_str().or(r["requestedReviewer"]["slug"].as_str()).map(String::from)).collect())
                .unwrap_or_default();
            let review_requested = viewer.as_ref().is_some_and(|v| n["reviewRequests"]["nodes"].as_array().is_some_and(|a| a.iter().any(|r| r["requestedReviewer"]["login"].as_str() == Some(v))));
            PullRequest {
                number: n["number"].as_u64().unwrap_or(0),
                title: s(&n["title"]),
                body: pr_body(&s(&n["body"])),
                url: s(&n["url"]),
                mine: viewer.as_deref() == Some(author.as_str()),
                author,
                draft: n["isDraft"].as_bool().unwrap_or(false),
                head_branch: s(&n["headRefName"]),
                head_repo: n["headRepository"]["nameWithOwner"].as_str().map(String::from),
                same_repo: !n["isCrossRepository"].as_bool().unwrap_or(false),
                base_branch: s(&n["baseRefName"]),
                updated_at: s(&n["updatedAt"]),
                checks: n["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str().and_then(rollup_state),
                reviewers,
                review_requested,
            }
        })
        .collect();
    PullRequestList { viewer, items }
}

pub async fn pull_requests(api: &Api<'_>, r: &RepoRef) -> Result<PullRequestList, String> {
    let data = graphql(api, PR_QUERY, json!({ "owner": r.owner, "name": r.name })).await?;
    if data["repository"].is_null() {
        return Err(format!("GitHub cannot find {} with this token.", r.path));
    }
    Ok(parse_pull_requests(&data))
}

pub async fn assignable_users(api: &Api<'_>, r: &RepoRef) -> Result<Vec<String>, String> {
    let q = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { assignableUsers(first: 100) { nodes { login } } } }";
    let data = graphql(api, q, json!({ "owner": r.owner, "name": r.name })).await?;
    Ok(data["repository"]["assignableUsers"]["nodes"].as_array().map(|a| a.iter().filter_map(|n| n["login"].as_str().map(String::from)).collect()).unwrap_or_default())
}

// ----------------------------------------------------------------------- CI

const CI_FRAGMENT: &str = r#"fragment ci on Commit {
  statusCheckRollup {
    state
    contexts(first: 50) {
      nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl description }
      }
    }
  }
}"#;

/// One query for many commits: an aliased `object(oid:)` per sha. Shas are validated hex, so inlining them is safe.
pub fn ci_query(shas: &[String]) -> String {
    let fields: String = shas.iter().enumerate().map(|(i, sha)| format!("    c{i}: object(oid: \"{sha}\") {{ ...ci }}\n")).collect();
    format!("query($owner: String!, $name: String!) {{\n  repository(owner: $owner, name: $name) {{\n{fields}  }}\n}}\n{CI_FRAGMENT}")
}

fn check_state(node: &Value) -> CiState {
    if node["__typename"] == "StatusContext" {
        return rollup_state(node["state"].as_str().unwrap_or("")).unwrap_or(CiState::Neutral);
    }
    if node["status"].as_str() != Some("COMPLETED") {
        return CiState::Pending;
    }
    match node["conclusion"].as_str().unwrap_or("") {
        "SUCCESS" => CiState::Success,
        "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => CiState::Failure,
        _ => CiState::Neutral,
    }
}

/// A commit object from the CI query: None when the commit is unknown to GitHub or has no checks.
pub fn parse_ci(commit: &Value) -> Option<CiStatus> {
    let rollup = &commit["statusCheckRollup"];
    let state = rollup_state(rollup["state"].as_str()?)?;
    let checks = rollup["contexts"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter(|n| n.is_object())
                .map(|n| {
                    let is_status = n["__typename"] == "StatusContext";
                    CiCheck {
                        name: s(if is_status { &n["context"] } else { &n["name"] }),
                        state: check_state(n),
                        url: (if is_status { &n["targetUrl"] } else { &n["detailsUrl"] }).as_str().filter(|u| !u.is_empty()).map(String::from),
                        description: n["description"].as_str().filter(|d| !d.is_empty()).map(String::from),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Some(CiStatus { state, checks })
}

pub async fn ci_statuses(api: &Api<'_>, r: &RepoRef, shas: &[String]) -> Result<HashMap<String, Option<CiStatus>>, String> {
    let mut out = HashMap::new();
    for batch in shas.chunks(CI_BATCH) {
        let data = graphql(api, &ci_query(batch), json!({ "owner": r.owner, "name": r.name })).await?;
        for (i, sha) in batch.iter().enumerate() {
            out.insert(sha.clone(), parse_ci(&data["repository"][format!("c{i}")]));
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------- create

/// `owner:branch` when the head lives in another repository (a fork).
fn head_spec(base: &RepoRef, head: &RepoRef, branch: &str) -> String {
    if head.path.eq_ignore_ascii_case(&base.path) {
        branch.to_string()
    } else {
        format!("{}:{branch}", head.owner)
    }
}

/// Requested reviewers split into users and team slugs ("org/team" or "@org/team").
pub fn split_reviewers(reviewers: &[String]) -> (Vec<String>, Vec<String>) {
    let mut users = vec![];
    let mut teams = vec![];
    for r in reviewers.iter().map(|r| r.trim().trim_start_matches('@')).filter(|r| !r.is_empty()) {
        match r.split_once('/') {
            Some((_, team)) => teams.push(team.to_string()),
            None => users.push(r.to_string()),
        }
    }
    (users, teams)
}

pub async fn create_pull_request(api: &Api<'_>, base: &RepoRef, head: &RepoRef, input: &CreatePrInput) -> Result<CreatedPr, String> {
    let head_ref = head_spec(base, head, &input.head);
    let repo_url = api.url(&format!("/repos/{}/{}", enc(&base.owner), enc(&base.name)));
    let body = json!({ "title": input.title.trim(), "body": input.body, "head": head_ref, "base": input.base, "draft": input.draft });
    let res = api.call("POST", &format!("{repo_url}/pulls"), Some(&body)).await?;
    if res.status == 422 && res.body.contains("already exists") {
        let url = format!("{repo_url}/pulls?state=open&head={}&base={}", enc(&format!("{}:{}", head.owner, input.head)), enc(&input.base));
        if let Some(pr) = api.json("GET", &url, None).await?.as_array().and_then(|a| a.first().cloned()) {
            return Ok(CreatedPr { number: pr["number"].as_u64().unwrap_or(0), url: s(&pr["html_url"]), existing: true, warning: None });
        }
    }
    if !res.ok() {
        return Err(super::api_error(api.provider.kind, &res));
    }
    let pr = res.json();
    let number = pr["number"].as_u64().ok_or("GitHub did not return the new pull request")?;
    let mut warning = None;
    let (users, teams) = split_reviewers(&input.reviewers);
    if !users.is_empty() || !teams.is_empty() {
        let req = json!({ "reviewers": users, "team_reviewers": teams });
        if let Err(e) = api.json("POST", &format!("{repo_url}/pulls/{number}/requested_reviewers"), Some(&req)).await {
            warning = Some(format!("Created, but reviewers could not be requested: {e}"));
        }
    }
    Ok(CreatedPr { number, url: s(&pr["html_url"]), existing: false, warning })
}

#[cfg(test)]
mod tests {
    use super::super::http::tests::{no_proxy, serve};
    use super::super::remote::{self, Provider};
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn parses_pull_requests_for_the_viewer() {
        let data = json!({
            "viewer": { "login": "me" },
            "repository": { "pullRequests": { "nodes": [
                { "number": 12, "title": "Add x", "url": "https://github.com/o/r/pull/12", "isDraft": true, "updatedAt": "2026-10-01T10:00:00Z",
                  "headRefName": "feat/x", "baseRefName": "main", "isCrossRepository": false, "author": { "login": "me" },
                  "headRepository": { "nameWithOwner": "o/r" }, "reviewRequests": { "nodes": [] },
                  "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE" } } }] } },
                { "number": 13, "title": "Fix y", "url": "u", "isDraft": false, "updatedAt": "2026-10-02T10:00:00Z",
                  "headRefName": "main", "baseRefName": "main", "isCrossRepository": true, "author": { "login": "them" },
                  "headRepository": { "nameWithOwner": "them/r" },
                  "reviewRequests": { "nodes": [{ "requestedReviewer": { "__typename": "User", "login": "me" } }, { "requestedReviewer": { "__typename": "Team", "slug": "core" } }] },
                  "commits": { "nodes": [{ "commit": { "statusCheckRollup": null } }] } },
                null
            ] } }
        });
        let list = parse_pull_requests(&data);
        assert_eq!(list.viewer.as_deref(), Some("me"));
        assert_eq!(list.items.len(), 2);
        let (a, b) = (&list.items[0], &list.items[1]);
        assert!(a.mine && a.draft && a.same_repo && !a.review_requested);
        assert_eq!(a.checks, Some(CiState::Failure));
        assert!(!b.mine && b.review_requested && !b.same_repo);
        assert_eq!(b.reviewers, vec!["me", "core"]);
        assert_eq!(b.head_repo.as_deref(), Some("them/r"));
        assert_eq!(b.checks, None);
    }

    #[test]
    fn parses_check_rollups() {
        let commit = json!({ "statusCheckRollup": { "state": "PENDING", "contexts": { "nodes": [
            { "__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://ci/1" },
            { "__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": null, "detailsUrl": "" },
            { "__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED" },
            { "__typename": "StatusContext", "context": "ci/jenkins", "state": "ERROR", "targetUrl": "https://j/2", "description": "boom" }
        ] } } });
        let st = parse_ci(&commit).unwrap();
        assert_eq!(st.state, CiState::Pending);
        let states: Vec<CiState> = st.checks.iter().map(|c| c.state).collect();
        assert_eq!(states, vec![CiState::Success, CiState::Pending, CiState::Neutral, CiState::Failure]);
        assert_eq!(st.checks[0].url.as_deref(), Some("https://ci/1"));
        assert_eq!(st.checks[1].url, None);
        assert_eq!(st.checks[3].name, "ci/jenkins");
        assert_eq!(st.checks[3].description.as_deref(), Some("boom"));
        assert_eq!(parse_ci(&json!({ "statusCheckRollup": null })), None);
        assert_eq!(parse_ci(&Value::Null), None);
    }

    #[test]
    fn builds_queries_and_reviewer_lists() {
        let q = ci_query(&["a".repeat(40), "b".repeat(40)]);
        assert!(q.contains(&format!("c1: object(oid: \"{}\")", "b".repeat(40))));
        assert!(q.contains("fragment ci on Commit"));
        let (users, teams) = split_reviewers(&["@alice".into(), " bob ".into(), "acme/core".into(), "".into()]);
        assert_eq!(users, vec!["alice", "bob"]);
        assert_eq!(teams, vec!["core"]);
    }

    fn provider(url: &str) -> Provider {
        Provider { kind: remote::Kind::Github, host: "github.com".into(), api_url: url.into(), web_url: "https://github.com".into(), configured: false }
    }

    #[tokio::test]
    async fn creates_a_fork_pull_request_and_requests_reviewers() {
        let (url, seen) = serve(vec![
            ("201 Created", "", r#"{"number":5,"html_url":"https://github.com/o/r/pull/5"}"#.into()),
            ("422 Unprocessable Entity", "", r#"{"message":"Reviews may only be requested from collaborators."}"#.into()),
        ]);
        let p = provider(&url);
        let limits = Mutex::new(HashMap::new());
        let env = no_proxy();
        let api = Api { provider: &p, token: "tok".into(), env: &env, limits: &limits };
        let base = remote::resolve("git@github.com:o/r.git", &[]).unwrap();
        let head = remote::resolve("git@github.com:me/r.git", &[]).unwrap();
        let input = CreatePrInput { base: "main".into(), head: "feat".into(), title: " T ".into(), body: "B".into(), draft: true, reviewers: vec!["alice".into()], ..Default::default() };
        let pr = create_pull_request(&api, &base, &head, &input).await.unwrap();
        assert_eq!((pr.number, pr.url.as_str(), pr.existing), (5, "https://github.com/o/r/pull/5", false));
        assert!(pr.warning.unwrap().contains("collaborators"));
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs[0].starts_with("POST /repos/o/r/pulls "));
        assert!(reqs[0].contains(r#""head":"me:feat""#) && reqs[0].contains(r#""draft":true"#) && reqs[0].contains(r#""title":"T""#));
        assert!(reqs[0].contains("Authorization: Bearer tok"));
        assert!(reqs[1].starts_with("POST /repos/o/r/pulls/5/requested_reviewers "));
    }

    #[tokio::test]
    async fn returns_the_existing_pull_request() {
        let (url, seen) = serve(vec![
            ("422 Unprocessable Entity", "", r#"{"message":"Validation Failed","errors":[{"message":"A pull request already exists for o:feat."}]}"#.into()),
            ("200 OK", "", r#"[{"number":3,"html_url":"https://github.com/o/r/pull/3"}]"#.into()),
        ]);
        let p = provider(&url);
        let limits = Mutex::new(HashMap::new());
        let env = no_proxy();
        let api = Api { provider: &p, token: "tok".into(), env: &env, limits: &limits };
        let base = remote::resolve("git@github.com:o/r.git", &[]).unwrap();
        let input = CreatePrInput { base: "main".into(), head: "feat".into(), title: "T".into(), ..Default::default() };
        let pr = create_pull_request(&api, &base, &base, &input).await.unwrap();
        assert!(pr.existing);
        assert_eq!(pr.number, 3);
        assert!(seen.lock().unwrap()[1].starts_with("GET /repos/o/r/pulls?state=open&head=o%3Afeat&base=main "));
    }

    #[tokio::test]
    async fn fetches_ci_for_many_commits_in_one_query() {
        let (sha_a, sha_b) = ("a".repeat(40), "b".repeat(40));
        let body = json!({ "data": { "repository": {
            "c0": { "statusCheckRollup": { "state": "SUCCESS", "contexts": { "nodes": [] } } },
            "c1": null
        } } })
        .to_string();
        let (url, seen) = serve(vec![("200 OK", "X-RateLimit-Remaining: 4999\r\n", body)]);
        let p = provider(&url);
        let limits = Mutex::new(HashMap::new());
        let env = no_proxy();
        let api = Api { provider: &p, token: "tok".into(), env: &env, limits: &limits };
        let r = remote::resolve("git@github.com:o/r.git", &[]).unwrap();
        let res = ci_statuses(&api, &r, &[sha_a.clone(), sha_b.clone()]).await.unwrap();
        assert_eq!(res[&sha_a].as_ref().unwrap().state, CiState::Success);
        assert_eq!(res[&sha_b], None);
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(seen.lock().unwrap()[0].starts_with("POST /graphql "));
    }
}
