// AskPass: git and ssh ask the user for a username, password, key passphrase or host key confirmation in a dialog.
//
// The Karen executable doubles as the askpass program. Remote git commands run with GIT_ASKPASS and SSH_ASKPASS set
// to it, plus the address of a local channel and a token valid for that one command. Run that way (`askpass_main`,
// checked at the very top of main(), before Tauri and its single-instance plugin), it connects to the running app,
// sends the prompt, prints the answer and exits. The app shows the prompt in the window and replies.
//
// The channel is a Unix socket in a folder only the user can open (macOS, Linux) or a named pipe that refuses remote
// clients (Windows). Requests without a live token are refused. Answers are never logged or kept: they pass through
// a oneshot channel straight to the waiting connection.
use std::collections::HashMap;
use std::future::Future;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

/// Address of the app's channel (socket path or pipe name), set on remote git commands
pub const ENV_ADDR: &str = "KAREN_ASKPASS_ADDR";
/// The command's token, set on remote git commands
pub const ENV_TOKEN: &str = "KAREN_ASKPASS_TOKEN";

const MAX_REQUEST: u64 = 64 * 1024;
/// A prompt nobody answers is cancelled after this long (git then fails instead of waiting forever).
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// A client must send its request this soon after connecting.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Deserialize, Debug)]
struct Request {
    token: String,
    prompt: String,
    /// SSH_ASKPASS_PROMPT: "confirm" (yes/no through the exit code) or "none" (a notice) from ssh
    #[serde(default)]
    ssh_prompt: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct Response {
    /// None: cancelled, timed out or refused
    answer: Option<String>,
}

/// A question for the user, as the renderer receives it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskPassPrompt {
    pub id: u64,
    /// The repository (or a clone's destination)
    pub repo: String,
    /// The git operation asking, e.g. "fetch", "push", "clone"
    pub operation: String,
    /// Exactly what git or ssh asked
    pub prompt: String,
    pub ssh_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskPassEvent {
    Prompt(AskPassPrompt),
    /// The prompt was answered (maybe in another window), cancelled or abandoned: close its dialog
    Done(u64),
}

type Emit = Box<dyn Fn(AskPassEvent) + Send + Sync>;

struct SessionInfo {
    repo: String,
    operation: String,
}

struct Pending {
    token: String,
    reply: oneshot::Sender<Option<String>>,
}

struct Inner {
    addr: String,
    exe: PathBuf,
    /// The system ssh honours SSH_ASKPASS_REQUIRE=force (OpenSSH 8.4+)
    ssh_askpass: bool,
    sessions: Mutex<HashMap<String, SessionInfo>>,
    pending: Mutex<HashMap<u64, Pending>>,
    next: AtomicU64,
    emit: Emit,
    /// Owner-only folder holding the socket; removed with the server
    #[cfg(unix)]
    _dir: tempfile::TempDir,
}

pub struct AskPass {
    inner: Arc<Inner>,
}

/// The askpass environment of one git command. Dropping it revokes the token and cancels its open prompts.
pub struct Session {
    inner: Arc<Inner>,
    token: String,
}

impl Session {
    pub fn env(&self) -> Vec<(String, String)> {
        let exe = self.inner.exe.to_string_lossy().into_owned();
        let mut env = vec![
            ("GIT_ASKPASS".to_string(), exe.clone()),
            (ENV_ADDR.to_string(), self.inner.addr.clone()),
            (ENV_TOKEN.to_string(), self.token.clone()),
        ];
        if self.inner.ssh_askpass {
            env.push(("SSH_ASKPASS".into(), exe));
            env.push(("SSH_ASKPASS_REQUIRE".into(), "force".into()));
        }
        env
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.inner.sessions.lock().unwrap().remove(&self.token);
        let abandoned: Vec<(u64, Pending)> = {
            let mut pending = self.inner.pending.lock().unwrap();
            let ids: Vec<u64> = pending.iter().filter(|(_, p)| p.token == self.token).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| pending.remove(&id).map(|p| (id, p))).collect()
        };
        for (id, p) in abandoned {
            let _ = p.reply.send(None);
            (self.inner.emit)(AskPassEvent::Done(id));
        }
    }
}

fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

static OPENSSH_VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)").unwrap());

/// Whether `ssh -V` output names an OpenSSH that supports SSH_ASKPASS_REQUIRE (8.4 and later).
pub fn ssh_supports_askpass_require(version: &str) -> bool {
    OPENSSH_VERSION.captures(version).is_some_and(|c| {
        let (major, minor): (u32, u32) = (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0));
        (major, minor) >= (8, 4)
    })
}

fn system_ssh_supports_askpass() -> bool {
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-V").stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    // `ssh -V` prints its version on stderr
    cmd.output().is_ok_and(|o| ssh_supports_askpass_require(&String::from_utf8_lossy(&o.stderr)))
}

impl AskPass {
    /// Create the channel. The returned future serves it and must be spawned on a tokio runtime. Older ssh
    /// versions keep their previous behaviour (no SSH_ASKPASS); git's own prompts still come to the app.
    pub fn start(exe: PathBuf, emit: Emit) -> io::Result<(Arc<AskPass>, impl Future<Output = ()> + Send + 'static)> {
        Self::start_with(exe, system_ssh_supports_askpass(), emit)
    }

    fn start_with(exe: PathBuf, ssh_askpass: bool, emit: Emit) -> io::Result<(Arc<AskPass>, impl Future<Output = ()> + Send + 'static)> {
        #[cfg(unix)]
        let (inner, listener) = {
            // created with mode 0700 (not changed afterwards): only this user can reach the socket
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::Builder::new().prefix("karen-askpass-").permissions(std::fs::Permissions::from_mode(0o700)).tempdir()?;
            let path = dir.path().join("s");
            let listener = std::os::unix::net::UnixListener::bind(&path)?;
            listener.set_nonblocking(true)?;
            let inner = Inner::new(path.to_string_lossy().into_owned(), exe, ssh_askpass, emit, dir);
            (inner, listener)
        };
        #[cfg(windows)]
        let inner = Inner::new(format!(r"\\.\pipe\karen-askpass-{}", random_token()?), exe, ssh_askpass, emit);
        let inner = Arc::new(inner);
        let server = {
            let inner = inner.clone();
            async move {
                #[cfg(unix)]
                serve_unix(inner, listener).await;
                #[cfg(windows)]
                serve_pipe(inner).await;
            }
        };
        Ok((Arc::new(AskPass { inner }), server))
    }

    /// A token for one git command run for `repo` (`operation`: what it does, shown in the dialog).
    pub fn session(&self, repo: &str, operation: &str) -> Option<Session> {
        let token = random_token().ok()?;
        let info = SessionInfo { repo: repo.to_string(), operation: operation.to_string() };
        self.inner.sessions.lock().unwrap().insert(token.clone(), info);
        Some(Session { inner: self.inner.clone(), token })
    }

    /// The user's reply to prompt `id`; None cancels it. False when the prompt is gone (answered elsewhere).
    pub fn answer(&self, id: u64, answer: Option<String>) -> bool {
        let Some(p) = self.inner.pending.lock().unwrap().remove(&id) else { return false };
        let _ = p.reply.send(answer);
        (self.inner.emit)(AskPassEvent::Done(id));
        true
    }
}

impl Inner {
    fn new(addr: String, exe: PathBuf, ssh_askpass: bool, emit: Emit, #[cfg(unix)] dir: tempfile::TempDir) -> Self {
        Inner {
            addr,
            exe,
            ssh_askpass,
            sessions: Mutex::default(),
            pending: Mutex::default(),
            next: AtomicU64::new(1),
            emit,
            #[cfg(unix)]
            _dir: dir,
        }
    }

    /// Show the request to the user and wait for the reply. None for an unknown token, a cancel or a timeout.
    async fn ask(&self, req: Request) -> Option<String> {
        let (repo, operation) = {
            let sessions = self.sessions.lock().unwrap();
            let s = sessions.get(&req.token)?;
            (s.repo.clone(), s.operation.clone())
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, Pending { token: req.token, reply: tx });
        (self.emit)(AskPassEvent::Prompt(AskPassPrompt { id, repo, operation, prompt: req.prompt, ssh_prompt: req.ssh_prompt }));
        match tokio::time::timeout(ANSWER_TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer,
            // timed out (or the sender vanished): withdraw the dialog
            _ => {
                if self.pending.lock().unwrap().remove(&id).is_some() {
                    (self.emit)(AskPassEvent::Done(id));
                }
                None
            }
        }
    }
}

/// One connection: a JSON request line in, a JSON response line out.
async fn serve_connection<S: AsyncRead + AsyncWrite + Unpin>(inner: Arc<Inner>, stream: S) -> io::Result<()> {
    let (read, mut write) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(read.take(MAX_REQUEST));
    let mut line = String::new();
    let read = tokio::time::timeout(REQUEST_TIMEOUT, reader.read_line(&mut line)).await;
    let answer = match read {
        Ok(Ok(_)) => match serde_json::from_str::<Request>(&line) {
            Ok(req) => inner.ask(req).await,
            Err(_) => None,
        },
        _ => None,
    };
    let mut out = serde_json::to_vec(&Response { answer }).map_err(io::Error::other)?;
    out.push(b'\n');
    write.write_all(&out).await?;
    write.shutdown().await
}

#[cfg(unix)]
async fn serve_unix(inner: Arc<Inner>, listener: std::os::unix::net::UnixListener) {
    let Ok(listener) = tokio::net::UnixListener::from_std(listener) else { return };
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(serve_connection(inner.clone(), stream));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

#[cfg(windows)]
async fn serve_pipe(inner: Arc<Inner>) {
    use tokio::net::windows::named_pipe::ServerOptions;
    let create = |first: bool| ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true).create(&inner.addr);
    let Ok(mut server) = create(true) else { return };
    loop {
        if server.connect().await.is_err() {
            match create(false) {
                Ok(s) => server = s,
                Err(_) => return,
            }
            continue;
        }
        // a fresh instance takes the next client while this one is served
        let next = match create(false) {
            Ok(s) => s,
            Err(_) => return,
        };
        let connected = std::mem::replace(&mut server, next);
        tokio::spawn(serve_connection(inner.clone(), connected));
    }
}

// ------------------------------------------------------------------ client side (the askpass program)

#[cfg(unix)]
fn connect(addr: &str) -> io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(addr)
}

#[cfg(windows)]
fn connect(addr: &str) -> io::Result<std::fs::File> {
    // all instances can be busy for a moment while the server creates the next one
    let mut last = None;
    for _ in 0..40 {
        match std::fs::OpenOptions::new().read(true).write(true).open(addr) {
            Ok(f) => return Ok(f),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(last.unwrap_or_else(|| io::Error::other("askpass pipe unavailable")))
}

fn request(addr: &str, req: &Request) -> io::Result<Option<String>> {
    let mut stream = connect(addr)?;
    let mut line = serde_json::to_vec(req).map_err(io::Error::other)?;
    line.push(b'\n');
    stream.write_all(&line)?;
    stream.flush()?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply)?;
    Ok(serde_json::from_str::<Response>(&reply).map_err(io::Error::other)?.answer)
}

/// When this process was started as the askpass program (by git or ssh, with the app's variables set), ask the
/// running app and return the exit code; None otherwise, and the app starts normally.
pub fn askpass_main() -> Option<i32> {
    let addr = std::env::var(ENV_ADDR).ok().filter(|s| !s.is_empty())?;
    let token = std::env::var(ENV_TOKEN).ok().filter(|s| !s.is_empty())?;
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let ssh_prompt = std::env::var("SSH_ASKPASS_PROMPT").ok().filter(|s| !s.is_empty());
    match request(&addr, &Request { token, prompt, ssh_prompt }) {
        Ok(Some(answer)) => {
            let mut out = io::stdout().lock();
            // git and ssh read up to the newline
            let ok = writeln!(out, "{answer}").and_then(|()| out.flush());
            Some(if ok.is_ok() { 0 } else { 1 })
        }
        // cancelled, refused or the app is gone: git and ssh stop with an authentication error
        _ => Some(1),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn server() -> (Arc<AskPass>, tokio::sync::mpsc::UnboundedReceiver<AskPassEvent>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (askpass, serve) = AskPass::start_with(PathBuf::from("/usr/bin/false"), true, Box::new(move |e| drop(tx.send(e)))).unwrap();
        tokio::spawn(serve);
        (askpass, rx)
    }

    async fn ask(addr: &str, token: &str, prompt: &str) -> io::Result<Option<String>> {
        let (addr, req) = (addr.to_string(), Request { token: token.into(), prompt: prompt.into(), ssh_prompt: None });
        tokio::task::spawn_blocking(move || request(&addr, &req)).await.unwrap()
    }

    fn env_of(session: &Session, key: &str) -> String {
        session.env().into_iter().find(|(k, _)| k == key).map(|(_, v)| v).unwrap_or_default()
    }

    #[tokio::test]
    async fn answers_a_prompt_with_a_valid_token() {
        let (askpass, mut events) = server();
        let session = askpass.session("/repo", "fetch").unwrap();
        let (addr, token) = (env_of(&session, ENV_ADDR), env_of(&session, ENV_TOKEN));
        let asking = tokio::spawn(async move { ask(&addr, &token, "Password for 'https://host': ").await });
        let Some(AskPassEvent::Prompt(p)) = events.recv().await else { panic!("no prompt") };
        assert_eq!((p.repo.as_str(), p.operation.as_str(), p.prompt.as_str()), ("/repo", "fetch", "Password for 'https://host': "));
        assert!(askpass.answer(p.id, Some("s3cret".into())));
        assert_eq!(asking.await.unwrap().unwrap().as_deref(), Some("s3cret"));
        assert_eq!(events.recv().await, Some(AskPassEvent::Done(p.id)));
        assert!(!askpass.answer(p.id, Some("again".into())), "a prompt is answered once");
        drop(session);
    }

    #[tokio::test]
    async fn refuses_a_wrong_or_revoked_token() {
        let (askpass, mut events) = server();
        let session = askpass.session("/repo", "push").unwrap();
        let (addr, token) = (env_of(&session, ENV_ADDR), env_of(&session, ENV_TOKEN));
        assert_eq!(ask(&addr, "not-the-token", "Password: ").await.unwrap(), None);
        drop(session);
        assert_eq!(ask(&addr, &token, "Password: ").await.unwrap(), None, "the token died with its command");
        assert!(events.try_recv().is_err(), "nothing reached the user");
    }

    #[tokio::test]
    async fn cancelling_or_ending_the_command_answers_none() {
        let (askpass, mut events) = server();
        let session = askpass.session("/repo", "clone").unwrap();
        let (addr, token) = (env_of(&session, ENV_ADDR), env_of(&session, ENV_TOKEN));
        let (a, t) = (addr.clone(), token.clone());
        let asking = tokio::spawn(async move { ask(&a, &t, "Username for 'https://host': ").await });
        let Some(AskPassEvent::Prompt(p)) = events.recv().await else { panic!("no prompt") };
        assert!(askpass.answer(p.id, None));
        assert_eq!(asking.await.unwrap().unwrap(), None);
        assert_eq!(events.recv().await, Some(AskPassEvent::Done(p.id)));

        // the git command ends (or is cancelled) while its prompt is open
        let asking = tokio::spawn(async move { ask(&addr, &token, "Password: ").await });
        let Some(AskPassEvent::Prompt(p)) = events.recv().await else { panic!("no prompt") };
        drop(session);
        assert_eq!(asking.await.unwrap().unwrap(), None);
        assert_eq!(events.recv().await, Some(AskPassEvent::Done(p.id)));
    }

    #[tokio::test]
    async fn session_environment() {
        let (askpass, _events) = server();
        let session = askpass.session("/repo", "fetch").unwrap();
        assert_eq!(env_of(&session, "GIT_ASKPASS"), "/usr/bin/false");
        assert_eq!(env_of(&session, "SSH_ASKPASS_REQUIRE"), "force");
        assert_eq!(env_of(&session, ENV_TOKEN).len(), 64);
        let other = askpass.session("/repo", "fetch").unwrap();
        assert_ne!(env_of(&session, ENV_TOKEN), env_of(&other, ENV_TOKEN), "one token per command");
        let addr = env_of(&session, ENV_ADDR);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(std::path::Path::new(&addr).parent().unwrap()).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "only the user can reach the socket");
    }

    #[test]
    fn detects_ssh_askpass_require_support() {
        assert!(ssh_supports_askpass_require("OpenSSH_10.5p1, LibreSSL 3.3.6"));
        assert!(ssh_supports_askpass_require("OpenSSH_8.4p1 Debian-5, OpenSSL 1.1.1"));
        assert!(ssh_supports_askpass_require("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2"));
        assert!(!ssh_supports_askpass_require("OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f"));
        assert!(!ssh_supports_askpass_require("OpenSSH_7.4p1"));
        assert!(!ssh_supports_askpass_require("ssh: command not found"));
    }
}
