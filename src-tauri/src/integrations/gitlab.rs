// GitLab (gitlab.com and self-managed) through the REST API v4.
use std::collections::HashMap;

use serde_json::{json, Value};

use super::remote::RepoRef;
use super::{enc, Api, CiCheck, CiState, CiStatus, CreatePrInput, CreatedPr, PullRequest, PullRequestList, Viewer};

/// GitLab has no batch endpoint for commit statuses; at most this many commits are asked about per call (the rest
/// come with the next poll), one request at a time to stay gentle with the instance.
const CI_PER_CALL: usize = 30;

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn project(r: &RepoRef) -> String {
    format!("/projects/{}", enc(&r.path))
}

pub async fn viewer(api: &Api<'_>) -> Result<Viewer, String> {
    let v = api.json("GET", &api.url("/user"), None).await?;
    let user = v["username"].as_str().ok_or("GitLab did not return a user for this token")?.to_string();
    Ok(Viewer { user, name: v["name"].as_str().filter(|n| !n.is_empty()).map(String::from) })
}

pub fn parse_merge_requests(list: &Value, viewer: Option<String>, r: &RepoRef) -> PullRequestList {
    let items = list
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|m| m.is_object())
                .map(|m| {
                    let author = s(&m["author"]["username"]);
                    let reviewers: Vec<String> = m["reviewers"].as_array().map(|a| a.iter().filter_map(|u| u["username"].as_str().map(String::from)).collect()).unwrap_or_default();
                    let same_repo = m["source_project_id"] == m["target_project_id"];
                    PullRequest {
                        number: m["iid"].as_u64().unwrap_or(0),
                        title: s(&m["title"]),
                        url: s(&m["web_url"]),
                        mine: viewer.as_deref() == Some(author.as_str()),
                        review_requested: viewer.as_ref().is_some_and(|v| reviewers.contains(v)),
                        author,
                        draft: m["draft"].as_bool().or(m["work_in_progress"].as_bool()).unwrap_or(false),
                        head_branch: s(&m["source_branch"]),
                        head_repo: same_repo.then(|| r.path.clone()),
                        same_repo,
                        base_branch: s(&m["target_branch"]),
                        updated_at: s(&m["updated_at"]),
                        // the list endpoint carries no pipeline; per-MR lookups would cost a request each
                        checks: None,
                        reviewers,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    PullRequestList { viewer, items }
}

pub async fn merge_requests(api: &Api<'_>, r: &RepoRef, viewer: Option<String>) -> Result<PullRequestList, String> {
    let url = api.url(&format!("{}/merge_requests?state=opened&per_page=50&order_by=updated_at&sort=desc", project(r)));
    let list = api.json("GET", &url, None).await?;
    Ok(parse_merge_requests(&list, viewer, r))
}

pub async fn members(api: &Api<'_>, r: &RepoRef) -> Result<Vec<String>, String> {
    let list = api.json("GET", &api.url(&format!("{}/members/all?per_page=100", project(r))), None).await?;
    Ok(list.as_array().map(|a| a.iter().filter(|m| m["state"].as_str() != Some("blocked")).filter_map(|m| m["username"].as_str().map(String::from)).collect()).unwrap_or_default())
}

// ----------------------------------------------------------------------- CI

fn job_state(status: &str, allow_failure: bool) -> CiState {
    match status {
        "success" => CiState::Success,
        "failed" if allow_failure => CiState::Neutral,
        "failed" => CiState::Failure,
        "created" | "waiting_for_resource" | "preparing" | "pending" | "running" | "scheduled" => CiState::Pending,
        _ => CiState::Neutral,
    }
}

/// The latest statuses of a commit (one per job) folded into one state: any failure wins, then anything running.
pub fn parse_statuses(list: &Value) -> Option<CiStatus> {
    let checks: Vec<CiCheck> = list
        .as_array()?
        .iter()
        .map(|j| CiCheck {
            name: s(&j["name"]),
            state: job_state(j["status"].as_str().unwrap_or(""), j["allow_failure"].as_bool().unwrap_or(false)),
            url: j["target_url"].as_str().filter(|u| !u.is_empty()).map(String::from),
            description: j["description"].as_str().filter(|d| !d.is_empty()).map(String::from),
        })
        .collect();
    if checks.is_empty() {
        return None;
    }
    let has = |st| checks.iter().any(|c| c.state == st);
    let state = if has(CiState::Failure) {
        CiState::Failure
    } else if has(CiState::Pending) {
        CiState::Pending
    } else if has(CiState::Success) {
        CiState::Success
    } else {
        CiState::Neutral
    };
    Some(CiStatus { state, checks })
}

pub async fn ci_statuses(api: &Api<'_>, r: &RepoRef, shas: &[String]) -> Result<HashMap<String, Option<CiStatus>>, String> {
    let mut out = HashMap::new();
    for sha in shas.iter().take(CI_PER_CALL) {
        let res = api.call("GET", &api.url(&format!("{}/repository/commits/{sha}/statuses?per_page=100", project(r))), None).await?;
        if res.status == 404 {
            // not pushed (or not visible to this token)
            out.insert(sha.clone(), None);
        } else if res.ok() {
            out.insert(sha.clone(), parse_statuses(&res.json()));
        } else {
            return Err(super::api_error(api.provider.kind, &res));
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------- create

fn draft_title(title: &str, draft: bool) -> String {
    let t = title.trim();
    let lower = t.to_ascii_lowercase();
    if draft && !lower.starts_with("draft:") && !lower.starts_with("[draft]") {
        format!("Draft: {t}")
    } else {
        t.to_string()
    }
}

pub async fn create_merge_request(api: &Api<'_>, base: &RepoRef, head: &RepoRef, input: &CreatePrInput) -> Result<CreatedPr, String> {
    let mut warnings = vec![];
    let mut body = json!({
        "source_branch": input.head,
        "target_branch": input.base,
        "title": draft_title(&input.title, input.draft),
        "description": input.body,
    });
    if !head.path.eq_ignore_ascii_case(&base.path) {
        let target = api.json("GET", &api.url(&project(base)), None).await?;
        body["target_project_id"] = target["id"].clone();
    }
    let mut reviewer_ids = vec![];
    for name in input.reviewers.iter().map(|r| r.trim().trim_start_matches('@')).filter(|r| !r.is_empty()) {
        let found = api.json("GET", &api.url(&format!("/users?username={}", enc(name))), None).await?;
        match found[0]["id"].as_u64() {
            Some(id) => reviewer_ids.push(id),
            None => warnings.push(format!("no GitLab user {name}")),
        }
    }
    if !reviewer_ids.is_empty() {
        body["reviewer_ids"] = json!(reviewer_ids);
    }
    let res = api.call("POST", &api.url(&format!("{}/merge_requests", project(head))), Some(&body)).await?;
    if res.status == 409 {
        let url = api.url(&format!("{}/merge_requests?state=opened&source_branch={}&target_branch={}", project(base), enc(&input.head), enc(&input.base)));
        if let Some(mr) = api.json("GET", &url, None).await?.as_array().and_then(|a| a.first().cloned()) {
            return Ok(CreatedPr { number: mr["iid"].as_u64().unwrap_or(0), url: s(&mr["web_url"]), existing: true, warning: None });
        }
    }
    if !res.ok() {
        return Err(super::api_error(api.provider.kind, &res));
    }
    let mr = res.json();
    let number = mr["iid"].as_u64().ok_or("GitLab did not return the new merge request")?;
    let warning = (!warnings.is_empty()).then(|| format!("Created, but reviewers were skipped: {}", warnings.join(", ")));
    Ok(CreatedPr { number, url: s(&mr["web_url"]), existing: false, warning })
}

#[cfg(test)]
mod tests {
    use super::super::http::tests::{no_proxy, serve};
    use super::super::remote::{self, Kind, Provider};
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn parses_merge_requests() {
        let r = remote::resolve("https://gitlab.com/g/sub/app.git", &[]).unwrap();
        let list = json!([
            { "iid": 4, "title": "Draft: A", "web_url": "w4", "draft": true, "author": { "username": "me" }, "source_branch": "a", "target_branch": "main",
              "source_project_id": 1, "target_project_id": 1, "reviewers": [], "updated_at": "2026-10-01T00:00:00Z" },
            { "iid": 5, "title": "B", "web_url": "w5", "work_in_progress": false, "author": { "username": "x" }, "source_branch": "b", "target_branch": "main",
              "source_project_id": 2, "target_project_id": 1, "reviewers": [{ "username": "me" }], "updated_at": "2026-10-02T00:00:00Z" }
        ]);
        let prs = parse_merge_requests(&list, Some("me".into()), &r);
        let (a, b) = (&prs.items[0], &prs.items[1]);
        assert!(a.mine && a.draft && a.same_repo && !a.review_requested);
        assert_eq!(a.head_repo.as_deref(), Some("g/sub/app"));
        assert!(!b.mine && !b.draft && !b.same_repo && b.review_requested);
        assert_eq!((b.number, b.head_branch.as_str()), (5, "b"));
    }

    #[test]
    fn folds_job_statuses() {
        let st = |jobs: Value| parse_statuses(&jobs).map(|s| s.state);
        assert_eq!(st(json!([])), None);
        assert_eq!(st(json!([{ "name": "a", "status": "success" }, { "name": "b", "status": "skipped" }])), Some(CiState::Success));
        assert_eq!(st(json!([{ "name": "a", "status": "running" }, { "name": "b", "status": "success" }])), Some(CiState::Pending));
        assert_eq!(st(json!([{ "name": "a", "status": "running" }, { "name": "b", "status": "failed" }])), Some(CiState::Failure));
        assert_eq!(st(json!([{ "name": "a", "status": "failed", "allow_failure": true }, { "name": "b", "status": "success" }])), Some(CiState::Success));
        let full = parse_statuses(&json!([{ "name": "test", "status": "failed", "target_url": "https://gl/j/1", "description": "" }])).unwrap();
        assert_eq!(full.checks[0].url.as_deref(), Some("https://gl/j/1"));
        assert_eq!(full.checks[0].description, None);
        assert_eq!(draft_title(" T ", true), "Draft: T");
        assert_eq!(draft_title("Draft: T", true), "Draft: T");
        assert_eq!(draft_title("T", false), "T");
    }

    #[tokio::test]
    async fn creates_a_merge_request_from_a_fork() {
        let (url, seen) = serve(vec![
            ("200 OK", "", r#"{"id":42}"#.into()),
            ("200 OK", "", r#"[{"id":7,"username":"alice"}]"#.into()),
            ("201 Created", "", r#"{"iid":9,"web_url":"https://gitlab.com/g/app/-/merge_requests/9"}"#.into()),
        ]);
        let p = Provider { kind: Kind::Gitlab, host: "gitlab.com".into(), api_url: url, web_url: "https://gitlab.com".into(), configured: false };
        let limits = Mutex::new(HashMap::new());
        let env = no_proxy();
        let api = Api { provider: &p, token: "glpat".into(), env: &env, limits: &limits };
        let base = remote::resolve("https://gitlab.com/g/app.git", &[]).unwrap();
        let head = remote::resolve("https://gitlab.com/me/app.git", &[]).unwrap();
        let input = CreatePrInput { base: "main".into(), head: "feat".into(), title: "T".into(), draft: true, reviewers: vec!["@alice".into()], ..Default::default() };
        let mr = create_merge_request(&api, &base, &head, &input).await.unwrap();
        assert_eq!((mr.number, mr.existing, mr.warning.clone()), (9, false, None));
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs[0].starts_with("GET /projects/g%2Fapp "));
        assert!(reqs[1].starts_with("GET /users?username=alice "));
        assert!(reqs[2].starts_with("POST /projects/me%2Fapp/merge_requests "));
        assert!(reqs[2].contains(r#""target_project_id":42"#) && reqs[2].contains(r#""reviewer_ids":[7]"#) && reqs[2].contains(r#""title":"Draft: T""#));
    }
}
