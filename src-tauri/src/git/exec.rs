// Runs the system `git` binary. Every call gets a non-interactive, locale-stable environment.
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

pub type LineSink = Arc<dyn Fn(&str) + Send + Sync>;

/// The error of a command stopped through its `CancelToken`. The renderer shows no error for it.
pub const CANCELLED: &str = "Cancelled";

/// After asking git to stop (SIGTERM, so it removes its lock files), how long before it is killed outright.
const TERMINATE_GRACE: Duration = Duration::from_secs(3);
/// How often a cancellable or timed command checks its token and its idle time.
const WATCH_INTERVAL: Duration = Duration::from_millis(100);

/// Shared flag that stops the commands holding it (and the ones started with it later).
#[derive(Clone, Default, Debug)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    /// Resolves once cancelled.
    pub async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(WATCH_INTERVAL).await;
        }
    }
}

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
    /// Stop the command when it prints nothing (stdout or stderr) for this long. Meant for background network
    /// commands with `--progress`: a fetch may legitimately take long, but not stay silent.
    pub idle_timeout: Option<Duration>,
    /// Stop the command when this token is cancelled; it then fails with `CANCELLED`
    pub cancel: Option<CancelToken>,
    /// Credential prompts of git and ssh go to the app (askpass.rs); the token lives as long as these options
    pub askpass: Option<Arc<crate::askpass::Session>>,
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
    pub fn idle_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.idle_timeout = timeout;
        self
    }
    pub fn cancel(mut self, token: &CancelToken) -> Self {
        self.cancel = Some(token.clone());
        self
    }
}

/// Why a command was stopped before it finished.
enum Stop {
    Cancelled,
    TimedOut(Duration),
}

/// Ask git and the helpers it started (ssh, a credential helper, a transport) to stop the way Ctrl+C would, so git
/// removes its lock files and temporary packs. `force` kills them outright.
fn terminate(child: &mut Child, force: bool) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // a watched command leads its own process group (see `process_group` below): signal the whole group
        // SAFETY: kill(2) on a process group we created and whose leader has not been waited for yet
        unsafe {
            libc::kill(-(pid as libc::pid_t), if force { libc::SIGKILL } else { libc::SIGTERM });
        }
        return;
    }
    let _ = (child.start_kill(), force);
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
    if !opts.read_only {
        // hooks see the PATH a terminal would give them; set first so the variables below still win
        cmd.envs(crate::shell_env::hook_env().await);
    }
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
    if let Some(session) = &opts.askpass {
        cmd.envs(session.env());
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let watched = opts.cancel.is_some() || opts.idle_timeout.is_some();
    // a stoppable command gets its own process group, so stopping it reaches ssh and other helpers too (they would
    // otherwise keep running and hold git's output pipes open)
    #[cfg(unix)]
    if watched {
        cmd.process_group(0);
    }

    if opts.cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
        return Err(CANCELLED.into());
    }
    let mut child = cmd.spawn().map_err(|e| format!("Failed to run git: {e}"))?;
    let started = Instant::now();
    // milliseconds after `started` of the last output, for the idle timeout
    let last_output = AtomicU64::new(0);
    let touch = || last_output.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
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
        let mut chunk = vec![0u8; 8192]; // on the heap: this future is awaited deep inside IPC calls
        loop {
            match stdout.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    touch();
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
        }
        buf
    };
    let read_err = async {
        let mut all = Vec::new();
        let mut chunk = vec![0u8; 8192]; // on the heap: this future is awaited deep inside IPC calls
        let mut splitter = LineSplitter { pending: String::new() };
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    touch();
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
    let mut io = Box::pin(async { tokio::join!(write_input, read_out, read_err) });
    let mut stop: Option<(Stop, Instant)> = None;
    let (out, err) = loop {
        tokio::select! {
            ((), out, err) = &mut io => break (out, err),
            _ = tokio::time::sleep(WATCH_INTERVAL), if watched => match &stop {
                // stopped and exited: a helper that escaped the signal may still hold the pipes; stop reading them
                Some(_) if matches!(child.try_wait(), Ok(Some(_))) => break (Vec::new(), Vec::new()),
                None => {
                    let idle = started.elapsed().saturating_sub(Duration::from_millis(last_output.load(Ordering::Relaxed)));
                    let reason = if opts.cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
                        Some(Stop::Cancelled)
                    } else {
                        opts.idle_timeout.filter(|t| idle >= *t).map(Stop::TimedOut)
                    };
                    if let Some(reason) = reason {
                        terminate(&mut child, false);
                        stop = Some((reason, Instant::now()));
                    }
                }
                Some((_, since)) if since.elapsed() >= TERMINATE_GRACE => terminate(&mut child, true),
                Some(_) => {}
            },
        }
    };
    let status = child.wait().await.map_err(|e| format!("Failed to run git: {e}"))?;
    match stop {
        Some((Stop::Cancelled, _)) => return Err(CANCELLED.into()),
        Some((Stop::TimedOut(t), _)) => {
            let cmd = args.first().map(String::as_str).unwrap_or("");
            return Err(format!("git {cmd} timed out: no response for {} seconds", t.as_secs()));
        }
        None => {}
    }

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
