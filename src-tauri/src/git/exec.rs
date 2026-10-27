// Runs the system `git` binary. Every call gets a non-interactive, locale-stable environment.
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

pub type LineSink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default, Clone)]
pub struct Opts {
    /// Extra environment variables
    pub env: Vec<(String, String)>,
    /// Data written to stdin
    pub input: Option<Vec<u8>>,
    /// Exit codes treated as success (default [0])
    pub ok_codes: Option<Vec<i32>>,
    /// Called for every stderr line (progress output)
    pub on_stderr_line: Option<LineSink>,
    /// Mark as a read-only command (sets GIT_OPTIONAL_LOCKS=0)
    pub read_only: bool,
}

impl Opts {
    pub fn read() -> Self {
        Opts { read_only: true, ..Default::default() }
    }
    pub fn ok(mut self, codes: &[i32]) -> Self {
        self.ok_codes = Some(codes.to_vec());
        self
    }
    pub fn env(mut self, key: &str, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
    pub fn progress(mut self, sink: LineSink) -> Self {
        self.on_stderr_line = Some(sink);
        self
    }
}

#[derive(Debug, Clone)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

pub fn git_bin() -> String {
    std::env::var("KAREN_GIT_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "git".into())
}

/// Splits a stream of stderr chunks on \r and \n, calling `sink` with every non-empty trimmed line.
struct LineSplitter {
    pending: String,
}

impl LineSplitter {
    fn push(&mut self, chunk: &str, sink: &LineSink) {
        self.pending.push_str(chunk);
        while let Some(i) = self.pending.find(['\r', '\n']) {
            let line: String = self.pending.drain(..=i).collect();
            let t = line.trim();
            if !t.is_empty() {
                sink(t);
            }
        }
    }
    fn finish(&mut self, sink: &LineSink) {
        let t = self.pending.trim();
        if !t.is_empty() {
            sink(t);
        }
        self.pending.clear();
    }
}

pub async fn git(cwd: &Path, args: &[String], opts: Opts) -> Result<Output, String> {
    let raw = git_bytes(cwd, args, opts).await?;
    Ok(Output { stdout: String::from_utf8_lossy(&raw.stdout).into_owned(), stderr: raw.stderr, code: raw.code })
}

#[derive(Debug, Clone)]
pub struct RawOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

/// Like `git`, with stdout as raw bytes (blob contents such as images).
pub async fn git_bytes(cwd: &Path, args: &[String], opts: Opts) -> Result<RawOutput, String> {
    let mut cmd = Command::new(git_bin());
    cmd.args(args)
        .current_dir(cwd)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        // never pop interactive editors from inside the app
        .env("GIT_EDITOR", "true")
        .stdin(if opts.input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if opts.read_only {
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("Failed to run git: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stdin = child.stdin.take();

    let write_input = async {
        if let (Some(mut sink), Some(data)) = (stdin, opts.input.as_ref()) {
            // a git command may exit without reading all of stdin; that is not an error here
            let _ = sink.write_all(data).await;
            let _ = sink.shutdown().await;
        }
    };
    let read_out = async {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    };
    let read_err = async {
        let mut all = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut splitter = LineSplitter { pending: String::new() };
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    all.extend_from_slice(&chunk[..n]);
                    if let Some(sink) = &opts.on_stderr_line {
                        splitter.push(&String::from_utf8_lossy(&chunk[..n]), sink);
                    }
                }
            }
        }
        if let Some(sink) = &opts.on_stderr_line {
            splitter.finish(sink);
        }
        all
    };
    let ((), out, err) = tokio::join!(write_input, read_out, read_err);
    let status = child.wait().await.map_err(|e| format!("Failed to run git: {e}"))?;

    let stderr = String::from_utf8_lossy(&err).into_owned();
    let code = status.code().unwrap_or(-1);
    let ok_codes = opts.ok_codes.as_deref().unwrap_or(&[0]);
    if ok_codes.contains(&code) {
        return Ok(RawOutput { stdout: out, stderr, code });
    }
    let stdout = String::from_utf8_lossy(&out);
    let raw = if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("git {} exited with code {code}", args.first().map(String::as_str).unwrap_or(""))
    };
    Err(raw.lines().filter(|l| !l.starts_with("hint:")).collect::<Vec<_>>().join("\n"))
}
