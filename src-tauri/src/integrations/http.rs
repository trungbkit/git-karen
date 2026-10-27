// HTTP for the hosting APIs through the system curl, like the AI client (src/ai.rs): no TLS stack is compiled
// in, and HTTPS_PROXY / NO_PROXY work. Request headers (with the token) go through curl's stdin config, never the
// command line, and are never part of an error message.
use std::process::Stdio;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    /// Headers of the final response, names lower-cased
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

pub struct Request<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: Vec<(String, String)>,
    pub body: Option<&'a Value>,
}

/// Quote a value for a curl config file.
fn curl_quote(v: &str) -> String {
    let clean: String = v.chars().filter(|c| *c != '\r' && *c != '\n').collect();
    format!("\"{}\"", clean.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host)
}

/// Headers of the last response in a curl --dump-header file (redirects and proxy CONNECTs add earlier blocks).
pub fn parse_headers(dump: &str) -> Vec<(String, String)> {
    let normalized = dump.replace("\r\n", "\n");
    let block = normalized.split("\n\n").filter(|b| b.trim_start().starts_with("HTTP/")).last().unwrap_or("");
    block
        .lines()
        .skip(1)
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect()
}

fn network_error(code: i32, stderr: &str, host: &str, timeout: u32) -> String {
    match code {
        5 => format!("Cannot resolve the proxy for {host}. Check HTTPS_PROXY."),
        6 => format!("Cannot resolve {host}. Check your connection, VPN or DNS."),
        7 => format!("Could not connect to {host}."),
        28 => format!("The request to {host} timed out after {timeout}s."),
        60 | 77 => format!("TLS certificate problem talking to {host}: {}", stderr.trim()),
        _ => format!("Request to {host} failed (curl exit {code}): {}", stderr.trim()),
    }
}

pub async fn send(req: Request<'_>, timeout: u32, env: &[(String, String)]) -> Result<Response, String> {
    let dir = tempfile::Builder::new().prefix("karen-hosting-").tempdir().map_err(|e| e.to_string())?;
    let header_file = dir.path().join("headers");
    let mut config = format!("url = {}\nrequest = {}\n", curl_quote(req.url), curl_quote(req.method));
    for (k, v) in &req.headers {
        config.push_str(&format!("header = {}\n", curl_quote(&format!("{k}: {v}"))));
    }
    if let Some(body) = req.body {
        let body_file = dir.path().join("body.json");
        tokio::fs::write(&body_file, body.to_string()).await.map_err(|e| e.to_string())?;
        config.push_str("header = \"Content-Type: application/json\"\n");
        config.push_str(&format!("data-binary = {}\n", curl_quote(&format!("@{}", body_file.to_string_lossy()))));
    }
    config.push_str(&format!("dump-header = {}\n", curl_quote(&header_file.to_string_lossy())));

    let timeout = timeout.max(1);
    let mut cmd = Command::new("curl");
    cmd.args(["--silent", "--show-error", "--compressed", "--config", "-", "--write-out", "\n%{http_code}"])
        .args(["--max-time", &timeout.to_string(), "--connect-timeout", &timeout.min(15).to_string()])
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("Hosting integrations need curl on PATH: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(config.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    let code = out.status.code().unwrap_or(-1);
    if code != 0 {
        return Err(network_error(code, &String::from_utf8_lossy(&out.stderr), host_of(req.url), timeout));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (body, status) = stdout.rsplit_once('\n').unwrap_or(("", &stdout));
    let headers = parse_headers(&tokio::fs::read_to_string(&header_file).await.unwrap_or_default());
    Ok(Response { status: status.trim().parse().unwrap_or(0), headers, body: body.to_string() })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// An HTTP server answering one connection per (status line, extra headers, body), in order. Returns its URL and
    /// the raw requests it received.
    pub fn serve(responses: Vec<(&'static str, &'static str, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (stream, (status, headers, body)) in listener.incoming().zip(responses) {
                let mut stream = stream.unwrap();
                let mut raw = Vec::new();
                let mut buf = [0u8; 65536];
                // read the head, then as many body bytes as Content-Length says
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw).to_string();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .filter_map(|l| l.split_once(':'))
                            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if rest.len() >= len {
                            break;
                        }
                    }
                }
                log.lock().unwrap().push(String::from_utf8_lossy(&raw).to_string());
                let response = format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (url, seen)
    }

    pub fn no_proxy() -> Vec<(String, String)> {
        vec![("NO_PROXY".into(), "*".into()), ("no_proxy".into(), "*".into())]
    }

    #[test]
    fn parses_the_last_header_block() {
        let dump = "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 304\r\nETag: \"abc\"\r\nX-RateLimit-Remaining: 0\r\n\r\n";
        let h = parse_headers(dump);
        assert_eq!(h, vec![("etag".to_string(), "\"abc\"".to_string()), ("x-ratelimit-remaining".to_string(), "0".to_string())]);
        assert_eq!(host_of("https://user@api.github.com/graphql"), "api.github.com");
        assert_eq!(curl_quote("a\"b\nc"), "\"a\\\"bc\"");
    }

    #[tokio::test]
    async fn sends_method_headers_and_body_through_curl() {
        let (url, seen) = serve(vec![("201 Created", "X-Thing: 1\r\n", r#"{"ok":true}"#.into())]);
        let body = serde_json::json!({ "title": "x" });
        let res = send(
            Request { method: "POST", url: &format!("{url}/repos/o/r/pulls"), headers: vec![("Authorization".into(), "Bearer t0k3n".into())], body: Some(&body) },
            10,
            &no_proxy(),
        )
        .await
        .unwrap();
        assert_eq!(res.status, 201);
        assert!(res.ok());
        assert_eq!(res.json()["ok"], true);
        assert_eq!(res.header("x-thing"), Some("1"));
        let raw = seen.lock().unwrap()[0].clone();
        assert!(raw.starts_with("POST /repos/o/r/pulls"));
        assert!(raw.contains("Authorization: Bearer t0k3n"));
        assert!(raw.ends_with(r#"{"title":"x"}"#));
    }
}
