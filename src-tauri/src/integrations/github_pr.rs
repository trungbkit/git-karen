// Working on a GitHub pull request from the app: its details (description, conversation, checks, merge state),
// comments, reviews, merging, and the logs of its GitHub Actions jobs. Same client as github.rs, so it works with a
// keychain token and with the GitHub CLI's token alike.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::github::{graphql, parse_ci, s};
use super::http::{self, Request};
use super::remote::RepoRef;
use super::{enc, Api, CiStatus};

/// Longest job log returned; longer logs keep their end, where failures are
pub const MAX_LOG_CHARS: usize = 3_000_000;
const LOG_TIMEOUT_SECS: u32 = 60;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    /// "comment", or a review: "approved", "changes_requested", "commented", "dismissed"
    pub kind: String,
    pub author: String,
    pub body: String,
    /// ISO 8601
    pub created_at: String,
    pub url: String,
    /// Comments on lines of code a review carries
    pub code_comments: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    /// "open", "closed" or "merged"
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub head_branch: String,
    pub head_sha: String,
    pub same_repo: bool,
    pub base_branch: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    /// "mergeable", "conflicting" or "unknown" (GitHub is still computing it)
    pub mergeable: String,
    /// GitHub's merge state, lower-cased: clean, blocked, behind, dirty, unstable, has_hooks, draft, unknown
    pub merge_state: String,
    /// "approved", "changes_requested", "review_required", or None when no review is required
    pub review_decision: Option<String>,
    /// Merge methods the repository allows: "merge", "squash", "rebase"
    pub merge_methods: Vec<String>,
    pub default_merge_method: String,
    /// The repository deletes head branches after merging by itself
    pub delete_branch_on_merge: bool,
    pub viewer: Option<String>,
    pub checks: Option<CiStatus>,
    /// Comments and reviews, oldest first
    pub timeline: Vec<TimelineItem>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MergeInput {
    /// "merge", "squash" or "rebase"
    pub method: String,
    pub title: Option<String>,
    pub message: Option<String>,
    /// Merge only if the head is still this commit
    pub sha: Option<String>,
    /// Delete the head branch afterwards (same-repository pull requests only)
    pub delete_branch: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub sha: Option<String>,
    pub branch_deleted: bool,
    /// Merged, but deleting the branch failed
    pub warning: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ReviewInput {
    /// "approve", "request_changes" or "comment"
    pub event: String,
    pub body: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobStep {
    pub number: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobLog {
    pub job_id: u64,
    pub run_id: Option<u64>,
    pub name: String,
    pub workflow: Option<String>,
    /// queued, in_progress, completed, …
    pub status: String,
    pub conclusion: Option<String>,
    pub url: String,
    pub steps: Vec<JobStep>,
    /// Empty while the job hasn't finished (GitHub only serves logs of finished jobs)
    pub log: String,
    /// Only the end of a longer log is in `log`
    pub truncated: bool,
}

fn opt(v: &Value) -> Option<String> {
    v.as_str().filter(|x| !x.is_empty()).map(String::from)
}

/// The GitHub Actions job a check's details URL points to: `…/actions/runs/<run>/job/<job>`.
pub fn actions_job_id(url: &str) -> Option<u64> {
    let (_, rest) = url.split_once("/actions/runs/")?;
    let (_, job) = rest.split_once("/job/")?;
    job.split(['/', '?', '#']).next()?.parse().ok()
}

fn repo_url(api: &Api<'_>, r: &RepoRef) -> String {
    api.url(&format!("/repos/{}/{}", enc(&r.owner), enc(&r.name)))
}

// ------------------------------------------------------------------ detail

const DETAIL_QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
    pullRequest(number: $number) {
      number title body url state isDraft mergeable mergeStateStatus reviewDecision
      additions deletions changedFiles headRefName headRefOid baseRefName isCrossRepository
      author { login }
      comments(last: 100) { nodes { author { login } body createdAt url } }
      reviews(last: 100) { nodes { author { login } state body submittedAt url comments { totalCount } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl description }
      } } } } } }
    }
  }
}"#;

fn lower(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_ascii_lowercase()
}

pub fn parse_detail(data: &Value) -> Option<PullRequestDetail> {
    let repo = &data["repository"];
    let pr = &repo["pullRequest"];
    if !pr.is_object() {
        return None;
    }
    let mut timeline: Vec<TimelineItem> = pr["comments"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c.is_object())
        .map(|c| TimelineItem {
            kind: "comment".into(),
            author: s(&c["author"]["login"]),
            body: s(&c["body"]),
            created_at: s(&c["createdAt"]),
            url: s(&c["url"]),
            code_comments: 0,
        })
        .collect();
    timeline.extend(
        pr["reviews"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            // the viewer's unsubmitted review is a draft only they can see
            .filter(|r| r.is_object() && r["state"] != "PENDING")
            .map(|r| TimelineItem {
                kind: lower(&r["state"]),
                author: s(&r["author"]["login"]),
                body: s(&r["body"]),
                created_at: s(&r["submittedAt"]),
                url: s(&r["url"]),
                code_comments: r["comments"]["totalCount"].as_u64().unwrap_or(0),
            }),
    );
    // ISO 8601 in UTC sorts as text
    timeline.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let merge_methods = [("merge", "mergeCommitAllowed"), ("squash", "squashMergeAllowed"), ("rebase", "rebaseMergeAllowed")]
        .into_iter()
        .filter(|(_, field)| repo[*field].as_bool().unwrap_or(true))
        .map(|(m, _)| m.to_string())
        .collect::<Vec<_>>();
    let default = lower(&repo["viewerDefaultMergeMethod"]);
    let default_merge_method = if merge_methods.contains(&default) { default } else { merge_methods.first().cloned().unwrap_or_else(|| "merge".into()) };
    Some(PullRequestDetail {
        number: pr["number"].as_u64().unwrap_or(0),
        title: s(&pr["title"]),
        body: s(&pr["body"]),
        url: s(&pr["url"]),
        state: lower(&pr["state"]),
        draft: pr["isDraft"].as_bool().unwrap_or(false),
        author: s(&pr["author"]["login"]),
        head_branch: s(&pr["headRefName"]),
        head_sha: s(&pr["headRefOid"]),
        same_repo: !pr["isCrossRepository"].as_bool().unwrap_or(false),
        base_branch: s(&pr["baseRefName"]),
        additions: pr["additions"].as_u64().unwrap_or(0),
        deletions: pr["deletions"].as_u64().unwrap_or(0),
        changed_files: pr["changedFiles"].as_u64().unwrap_or(0),
        mergeable: lower(&pr["mergeable"]),
        merge_state: lower(&pr["mergeStateStatus"]),
        review_decision: opt(&pr["reviewDecision"]).map(|d| d.to_ascii_lowercase()),
        merge_methods,
        default_merge_method,
        delete_branch_on_merge: repo["deleteBranchOnMerge"].as_bool().unwrap_or(false),
        viewer: opt(&data["viewer"]["login"]),
        checks: parse_ci(&pr["commits"]["nodes"][0]["commit"]),
        timeline,
    })
}

pub async fn pull_request(api: &Api<'_>, r: &RepoRef, number: u64) -> Result<PullRequestDetail, String> {
    let data = graphql(api, DETAIL_QUERY, json!({ "owner": r.owner, "name": r.name, "number": number })).await?;
    if data["repository"].is_null() {
        return Err(format!("GitHub cannot find {} with this token.", r.path));
    }
    parse_detail(&data).ok_or_else(|| format!("Pull request #{number} was not found in {}.", r.path))
}

// --------------------------------------------------------------- actions

pub async fn comment(api: &Api<'_>, r: &RepoRef, number: u64, body: &str) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("Write a comment first.".into());
    }
    api.json("POST", &format!("{}/issues/{number}/comments", repo_url(api, r)), Some(&json!({ "body": body }))).await.map(|_| ())
}

pub async fn review(api: &Api<'_>, r: &RepoRef, number: u64, input: &ReviewInput) -> Result<(), String> {
    let event = match input.event.as_str() {
        "approve" => "APPROVE",
        "request_changes" => "REQUEST_CHANGES",
        "comment" => "COMMENT",
        e => return Err(format!("Unknown review: {e}")),
    };
    if event != "APPROVE" && input.body.trim().is_empty() {
        return Err("Say what should change: GitHub needs a comment with this review.".into());
    }
    let mut body = json!({ "event": event });
    if !input.body.trim().is_empty() {
        body["body"] = json!(input.body);
    }
    api.json("POST", &format!("{}/pulls/{number}/reviews", repo_url(api, r)), Some(&body)).await.map(|_| ())
}

/// Encode a branch name for a refs URL: each segment, keeping the slashes.
fn enc_ref(branch: &str) -> String {
    branch.split('/').map(enc).collect::<Vec<_>>().join("/")
}

pub async fn merge(api: &Api<'_>, r: &RepoRef, number: u64, input: &MergeInput) -> Result<MergeResult, String> {
    if !matches!(input.method.as_str(), "merge" | "squash" | "rebase") {
        return Err(format!("Unknown merge method: {}", input.method));
    }
    let base = repo_url(api, r);
    // read the head from GitHub, not the caller: only a branch of this repository is ever deleted
    let pr = api.json("GET", &format!("{base}/pulls/{number}"), None).await?;
    let mut body = json!({ "merge_method": input.method });
    if let Some(t) = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        body["commit_title"] = json!(t);
    }
    if let Some(m) = input.message.as_deref().filter(|m| !m.trim().is_empty()) {
        body["commit_message"] = json!(m);
    }
    if let Some(sha) = input.sha.as_deref().filter(|s| !s.is_empty()) {
        body["sha"] = json!(sha);
    }
    let merged = api.json("PUT", &format!("{base}/pulls/{number}/merge"), Some(&body)).await?;
    let mut result = MergeResult { sha: opt(&merged["sha"]), branch_deleted: false, warning: None };
    if input.delete_branch {
        let head_repo = s(&pr["head"]["repo"]["full_name"]);
        let head = s(&pr["head"]["ref"]);
        let default_branch = s(&pr["base"]["repo"]["default_branch"]);
        if !head_repo.eq_ignore_ascii_case(&r.path) {
            result.warning = Some("Merged. The branch is in a fork, so it was left alone.".into());
        } else if head.is_empty() || head == default_branch {
            result.warning = Some(format!("Merged. {head} is the default branch, so it was kept."));
        } else {
            let res = api.call("DELETE", &format!("{base}/git/refs/heads/{}", enc_ref(&head)), None).await?;
            // 422/404: already gone (the repository deletes merged branches itself)
            if res.ok() || res.status == 422 || res.status == 404 {
                result.branch_deleted = true;
            } else {
                result.warning = Some(format!("Merged, but {head} could not be deleted: {}", super::api_error(api.provider.kind, &res)));
            }
        }
    }
    Ok(result)
}

// -------------------------------------------------------------------- logs

/// The end of a log longer than `max` characters, from the start of a line.
pub fn tail(log: &str, max: usize) -> (String, bool) {
    let count = log.chars().count();
    if count <= max {
        return (log.to_string(), false);
    }
    let start = log.char_indices().nth(count - max).map(|(i, _)| i).unwrap_or(0);
    let rest = &log[start..];
    let rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or(rest);
    (rest.to_string(), true)
}

pub fn parse_job(v: &Value) -> JobLog {
    JobLog {
        job_id: v["id"].as_u64().unwrap_or(0),
        run_id: v["run_id"].as_u64(),
        name: s(&v["name"]),
        workflow: opt(&v["workflow_name"]),
        status: s(&v["status"]),
        conclusion: opt(&v["conclusion"]),
        url: s(&v["html_url"]),
        steps: v["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|st| JobStep { number: st["number"].as_u64().unwrap_or(0), name: s(&st["name"]), status: s(&st["status"]), conclusion: opt(&st["conclusion"]) })
            .collect(),
        log: String::new(),
        truncated: false,
    }
}

/// A GitHub Actions job and its log. GitHub answers the log request with a redirect to a short-lived download URL,
/// which is fetched without the token.
pub async fn job_log(api: &Api<'_>, r: &RepoRef, job_id: u64) -> Result<JobLog, String> {
    let base = repo_url(api, r);
    let mut job = parse_job(&api.json("GET", &format!("{base}/actions/jobs/{job_id}"), None).await?);
    if job.status != "completed" {
        return Ok(job);
    }
    let res = api.call("GET", &format!("{base}/actions/jobs/{job_id}/logs"), None).await?;
    let text = if (300..400).contains(&res.status) {
        let location = res.header("location").ok_or("GitHub did not say where the log is.")?.to_string();
        let headers = vec![("User-Agent".to_string(), "Karen".to_string())];
        let log = http::send(Request { method: "GET", url: &location, headers, body: None }, LOG_TIMEOUT_SECS, api.env).await?;
        if !log.ok() {
            return Err(format!("Could not download the log (HTTP {}).", log.status));
        }
        log.body
    } else if res.ok() {
        res.body
    } else if res.status == 410 || res.status == 404 {
        return Err("GitHub no longer has this log (logs expire), or the token can't read Actions.".into());
    } else {
        return Err(super::api_error(api.provider.kind, &res));
    };
    (job.log, job.truncated) = tail(&text, MAX_LOG_CHARS);
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::super::http::tests::{no_proxy, serve};
    use super::super::remote::{self, Provider};
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn provider(url: &str) -> Provider {
        Provider { kind: remote::Kind::Github, host: "github.com".into(), api_url: url.into(), web_url: "https://github.com".into(), configured: false }
    }

    #[test]
    fn finds_actions_jobs_in_check_urls() {
        assert_eq!(actions_job_id("https://github.com/o/r/actions/runs/123/job/456"), Some(456));
        assert_eq!(actions_job_id("https://ghe.corp.io/o/r/actions/runs/1/job/9?pr=3"), Some(9));
        assert_eq!(actions_job_id("https://github.com/o/r/runs/456"), None);
        assert_eq!(actions_job_id("https://ci.example.com/job/7"), None);
    }

    #[test]
    fn keeps_the_end_of_long_logs() {
        assert_eq!(tail("short", 10), ("short".to_string(), false));
        let (t, cut) = tail("first line\nsecond line\nthird", 12);
        assert!(cut);
        assert_eq!(t, "third");
        assert_eq!(enc_ref("feat/a b"), "feat/a%20b");
    }

    #[test]
    fn parses_pull_request_details() {
        let data = json!({
            "viewer": { "login": "me" },
            "repository": {
                "mergeCommitAllowed": false, "squashMergeAllowed": true, "rebaseMergeAllowed": true, "deleteBranchOnMerge": true,
                "viewerDefaultMergeMethod": "MERGE",
                "pullRequest": {
                    "number": 7, "title": "T", "body": "B", "url": "u", "state": "OPEN", "isDraft": false,
                    "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED", "reviewDecision": "REVIEW_REQUIRED",
                    "additions": 3, "deletions": 1, "changedFiles": 2, "headRefName": "feat", "headRefOid": "abc", "baseRefName": "main",
                    "isCrossRepository": false, "author": { "login": "them" },
                    "comments": { "nodes": [{ "author": { "login": "a" }, "body": "later", "createdAt": "2026-10-02T00:00:00Z", "url": "c1" }] },
                    "reviews": { "nodes": [
                        { "author": { "login": "b" }, "state": "CHANGES_REQUESTED", "body": "fix", "submittedAt": "2026-10-01T00:00:00Z", "url": "r1", "comments": { "totalCount": 2 } },
                        { "author": { "login": "me" }, "state": "PENDING", "body": "", "submittedAt": null, "url": "r2", "comments": { "totalCount": 0 } }
                    ] }
                }
            }
        });
        let mut data = data;
        let check = json!({ "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://github.com/o/r/actions/runs/1/job/42" });
        let rollup = json!({ "state": "FAILURE", "contexts": { "nodes": [check] } });
        data["repository"]["pullRequest"]["commits"] = json!({ "nodes": [{ "commit": { "statusCheckRollup": rollup } }] });
        let d = parse_detail(&data).unwrap();
        assert_eq!((d.state.as_str(), d.mergeable.as_str(), d.merge_state.as_str()), ("open", "mergeable", "blocked"));
        assert_eq!(d.review_decision.as_deref(), Some("review_required"));
        assert_eq!(d.merge_methods, vec!["squash", "rebase"]);
        assert_eq!(d.default_merge_method, "squash", "a disallowed default falls back to an allowed method");
        assert!(d.delete_branch_on_merge && d.same_repo);
        assert_eq!(d.timeline.iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(), ["changes_requested", "comment"]);
        assert_eq!(d.timeline[0].code_comments, 2);
        let checks = d.checks.unwrap();
        assert_eq!(checks.checks[0].job_id, Some(42));
        assert!(parse_detail(&json!({ "repository": { "pullRequest": null } })).is_none());
    }

    #[tokio::test]
    async fn merges_and_deletes_only_a_branch_of_this_repository() {
        let pr = |repo: &str| json!({ "head": { "ref": "feat/x", "repo": { "full_name": repo } }, "base": { "repo": { "default_branch": "main" } } }).to_string();
        let (url, seen) = serve(vec![
            ("200 OK", "", pr("o/r")),
            ("200 OK", "", r#"{"sha":"m1","merged":true}"#.into()),
            ("204 No Content", "", String::new()),
            ("200 OK", "", pr("fork/r")),
            ("200 OK", "", r#"{"sha":"m2","merged":true}"#.into()),
        ]);
        let p = provider(&url);
        let (limits, env) = (Mutex::new(HashMap::new()), no_proxy());
        let api = Api { provider: &p, token: "tok".into(), env: &env, limits: &limits };
        let r = remote::resolve("git@github.com:o/r.git", &[]).unwrap();
        let input = MergeInput { method: "squash".into(), title: Some(" T (#7) ".into()), sha: Some("abc".into()), delete_branch: true, ..Default::default() };
        let res = merge(&api, &r, 7, &input).await.unwrap();
        assert_eq!((res.sha.as_deref(), res.branch_deleted, res.warning.as_deref()), (Some("m1"), true, None));
        let res = merge(&api, &r, 8, &input).await.unwrap();
        assert!(!res.branch_deleted && res.warning.unwrap().contains("fork"));
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs[1].starts_with("PUT /repos/o/r/pulls/7/merge "));
        assert!(reqs[1].contains(r#""merge_method":"squash""#) && reqs[1].contains(r#""commit_title":"T (#7)""#) && reqs[1].contains(r#""sha":"abc""#));
        assert!(reqs[2].starts_with("DELETE /repos/o/r/git/refs/heads/feat/x "));
        assert_eq!(reqs.len(), 5, "nothing is deleted for a fork");
        assert!(merge(&api, &r, 9, &MergeInput { method: "yolo".into(), ..Default::default() }).await.is_err());
    }

    #[tokio::test]
    async fn comments_and_reviews() {
        let (url, seen) = serve(vec![("201 Created", "", "{}".into()), ("200 OK", "", "{}".into())]);
        let p = provider(&url);
        let (limits, env) = (Mutex::new(HashMap::new()), no_proxy());
        let api = Api { provider: &p, token: "tok".into(), env: &env, limits: &limits };
        let r = remote::resolve("git@github.com:o/r.git", &[]).unwrap();
        assert!(comment(&api, &r, 7, "  ").await.is_err());
        comment(&api, &r, 7, "LGTM").await.unwrap();
        assert!(review(&api, &r, 7, &ReviewInput { event: "request_changes".into(), body: "".into() }).await.is_err());
        review(&api, &r, 7, &ReviewInput { event: "approve".into(), body: "".into() }).await.unwrap();
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs[0].starts_with("POST /repos/o/r/issues/7/comments ") && reqs[0].ends_with(r#"{"body":"LGTM"}"#));
        assert!(reqs[1].starts_with("POST /repos/o/r/pulls/7/reviews ") && reqs[1].ends_with(r#"{"event":"APPROVE"}"#));
    }

    #[tokio::test]
    async fn follows_the_log_redirect_without_the_token() {
        let (logs, logs_seen) = serve(vec![("200 OK", "", "2026-10-01T00:00:00.0Z ##[error]boom\n".into())]);
        let job = json!({ "id": 42, "run_id": 1, "name": "test", "workflow_name": "CI", "status": "completed", "conclusion": "failure",
            "html_url": "https://github.com/o/r/actions/runs/1/job/42", "steps": [{ "number": 1, "name": "Run tests", "status": "completed", "conclusion": "failure" }] })
        .to_string();
        let location: &'static str = Box::leak(format!("Location: {logs}/blob?sig=x\r\n").into_boxed_str());
        let (url, seen) = serve(vec![("200 OK", "", job), ("302 Found", location, String::new())]);
        let p = provider(&url);
        let (limits, env) = (Mutex::new(HashMap::new()), no_proxy());
        let api = Api { provider: &p, token: "tok".into(), env: &env, limits: &limits };
        let r = remote::resolve("git@github.com:o/r.git", &[]).unwrap();
        let log = job_log(&api, &r, 42).await.unwrap();
        assert_eq!((log.name.as_str(), log.workflow.as_deref(), log.conclusion.as_deref()), ("test", Some("CI"), Some("failure")));
        assert_eq!(log.steps[0].name, "Run tests");
        assert!(log.log.contains("##[error]boom") && !log.truncated);
        assert!(seen.lock().unwrap()[1].starts_with("GET /repos/o/r/actions/jobs/42/logs "));
        let download = logs_seen.lock().unwrap()[0].clone();
        assert!(download.starts_with("GET /blob?sig=x ") && !download.contains("tok"));
    }
}
