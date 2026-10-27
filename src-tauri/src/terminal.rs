// Built-in terminal sessions backed by portable-pty. Each pty belongs to one webview (owner label);
// output is batched per pty and flushed every few ms so a chatty process cannot flood IPC.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

const FLUSH: Duration = Duration::from_millis(5);
const MAX_BATCH: usize = 256 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TermEvent {
    Data { data: String },
    Exit { code: i32 },
}

pub type Sink = Box<dyn Fn(TermEvent) + Send + 'static>;

struct Session {
    owner: String,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

enum Msg {
    Data(Vec<u8>),
    Exit(i32),
}

pub fn default_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        let comspec = std::env::var("COMSPEC").unwrap_or_default();
        let ps = comspec.to_lowercase().contains("powershell") || comspec.to_lowercase().contains("pwsh");
        return (if ps { comspec } else { "powershell.exe".into() }, vec![]);
    }
    let fallback = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" };
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| fallback.into());
    (shell, vec!["-l".into()])
}

/// Decode as much of `pending` as forms complete UTF-8, keeping a trailing partial sequence for the next read.
fn decode_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + n);
                    }
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PtyManager {
    pub fn create(self: &Arc<Self>, owner: &str, id: &str, cwd: &str, cols: u16, rows: u16, sink: Sink) -> Result<(), String> {
        if self.sessions.lock().unwrap().contains_key(id) {
            return Err(format!("Terminal {id} already exists"));
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows: rows.max(1), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let (file, args) = default_shell();
        let mut cmd = CommandBuilder::new(file);
        cmd.args(args);
        let home = std::env::home_dir().unwrap_or_default();
        cmd.cwd(if cwd.is_empty() { home.as_path() } else { std::path::Path::new(cwd) });
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Karen");
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();

        let (tx, rx) = mpsc::channel::<Msg>();
        let data_tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if data_tx.send(Msg::Data(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            let _ = tx.send(Msg::Exit(code));
        });

        let manager: Weak<PtyManager> = Arc::downgrade(self);
        let sid = id.to_string();
        std::thread::spawn(move || {
            let mut pending = Vec::new();
            let flush = |pending: &mut Vec<u8>| {
                let text = decode_utf8(pending);
                if !text.is_empty() {
                    sink(TermEvent::Data { data: text });
                }
            };
            let mut exit_code = None;
            while exit_code.is_none() {
                match rx.recv() {
                    Ok(Msg::Data(b)) => {
                        pending.extend(b);
                        let deadline = Instant::now() + FLUSH;
                        while pending.len() < MAX_BATCH {
                            let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
                            match rx.recv_timeout(left) {
                                Ok(Msg::Data(b)) => pending.extend(b),
                                Ok(Msg::Exit(c)) => {
                                    exit_code = Some(c);
                                    break;
                                }
                                Err(_) => break,
                            }
                        }
                        flush(&mut pending);
                    }
                    Ok(Msg::Exit(c)) => exit_code = Some(c),
                    Err(_) => exit_code = Some(-1),
                }
            }
            // output written just before exit may still be in flight from the reader
            loop {
                match rx.recv_timeout(Duration::from_millis(30)) {
                    Ok(Msg::Data(b)) => pending.extend(b),
                    Ok(Msg::Exit(_)) => {}
                    Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
                }
            }
            flush(&mut pending);
            if let Some(m) = manager.upgrade() {
                m.sessions.lock().unwrap().remove(&sid);
            }
            sink(TermEvent::Exit { code: exit_code.unwrap_or(-1) });
        });

        let session = Session { owner: owner.into(), master: pair.master, writer: Arc::new(Mutex::new(writer)), killer };
        self.sessions.lock().unwrap().insert(id.into(), session);
        Ok(())
    }

    pub fn write(&self, owner: &str, id: &str, data: &str) {
        let writer = match self.sessions.lock().unwrap().get(id) {
            Some(s) if s.owner == owner => s.writer.clone(),
            _ => return,
        };
        let mut w = writer.lock().unwrap();
        let _ = w.write_all(data.as_bytes()).and_then(|_| w.flush());
    }

    pub fn resize(&self, owner: &str, id: &str, cols: u16, rows: u16) {
        if let Some(s) = self.sessions.lock().unwrap().get(id).filter(|s| s.owner == owner) {
            // the pty may have exited between the renderer's resize and this call
            let _ = s.master.resize(PtySize { rows: rows.max(1), cols: cols.max(2), pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn kill(&self, owner: &str, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.get(id).is_some_and(|s| s.owner == owner) {
            if let Some(mut s) = sessions.remove(id) {
                let _ = s.killer.kill();
            }
        }
    }

    pub fn kill_owner(&self, owner: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        let ids: Vec<String> = sessions.iter().filter(|(_, s)| s.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in ids {
            if let Some(mut s) = sessions.remove(&id) {
                let _ = s.killer.kill();
            }
        }
    }

    pub fn kill_all(&self) {
        for (_, mut s) in self.sessions.lock().unwrap().drain() {
            let _ = s.killer.kill();
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect() -> (Sink, mpsc::Receiver<TermEvent>) {
        let (tx, rx) = mpsc::channel();
        (Box::new(move |e| drop(tx.send(e))), rx)
    }

    fn wait_for(rx: &mpsc::Receiver<TermEvent>, pred: impl Fn(&str) -> bool) -> (String, Option<i32>) {
        let mut out = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(TermEvent::Data { data }) => {
                    out.push_str(&data);
                    if pred(&out) {
                        return (out, None);
                    }
                }
                Ok(TermEvent::Exit { code }) => return (out, Some(code)),
                Err(_) => break,
            }
        }
        (out, None)
    }

    #[test]
    fn decodes_split_utf8() {
        let bytes = "héllo".as_bytes();
        let mut pending = bytes[..2].to_vec();
        assert_eq!(decode_utf8(&mut pending), "h");
        pending.extend_from_slice(&bytes[2..]);
        assert_eq!(decode_utf8(&mut pending), "éllo");
        let mut bad = vec![b'a', 0xff, b'b'];
        assert_eq!(decode_utf8(&mut bad), "a\u{FFFD}b");
    }

    #[test]
    #[cfg(unix)]
    fn runs_a_shell_and_reports_exit() {
        let m = Arc::new(PtyManager::default());
        let (sink, rx) = collect();
        let dir = tempfile::tempdir().unwrap();
        m.create("w1", "t1", &dir.path().to_string_lossy(), 80, 24, sink).unwrap();
        assert_eq!(m.len(), 1);
        m.write("other", "t1", "echo nope\r"); // wrong owner is ignored
        m.write("w1", "t1", "echo kc-$((40+2))\r");
        let (out, _) = wait_for(&rx, |o| o.contains("kc-42"));
        assert!(out.contains("kc-42"), "output was: {out:?}");
        m.resize("w1", "t1", 100, 30);
        m.write("w1", "t1", "exit 3\r");
        let (_, code) = wait_for(&rx, |_| false);
        assert_eq!(code, Some(3));
        assert_eq!(m.len(), 0);
    }

    #[test]
    #[cfg(unix)]
    fn kill_owner_only_kills_that_owners_sessions() {
        let m = Arc::new(PtyManager::default());
        let (s1, _r1) = collect();
        let (s2, _r2) = collect();
        m.create("a", "1", "", 80, 24, s1).unwrap();
        m.create("b", "2", "", 80, 24, s2).unwrap();
        m.kill_owner("a");
        assert_eq!(m.len(), 1);
        m.kill_all();
        assert_eq!(m.len(), 0);
    }
}
