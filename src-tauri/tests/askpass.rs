// End to end: real git and ssh run the real Karen binary as their askpass program, which asks the app's channel.
#![cfg(unix)]
use std::path::PathBuf;
use std::process::Stdio;

use karen_lib::askpass::{AskPass, AskPassEvent, Session};
use tokio::io::AsyncWriteExt;

/// A channel served on this runtime that answers every prompt with `reply(prompt)`.
fn answering(reply: fn(&str) -> Option<String>) -> (std::sync::Arc<AskPass>, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_karen"));
    let (askpass, serve) = AskPass::start(exe, Box::new(move |e| drop(tx.send(e)))).unwrap();
    tokio::spawn(serve);
    let (seen_tx, seen_rx) = tokio::sync::mpsc::unbounded_channel();
    let answerer = askpass.clone();
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            if let AskPassEvent::Prompt(p) = e {
                let _ = seen_tx.send(p.prompt.clone());
                answerer.answer(p.id, reply(&p.prompt));
            }
        }
    });
    (askpass, seen_rx)
}

/// `git credential fill` for a host without a helper: git asks for the username and the password.
async fn credential_fill(session: &Session, home: &std::path::Path) -> std::process::Output {
    let mut child = tokio::process::Command::new("git")
        .args(["-c", "credential.helper=", "credential", "fill"])
        .envs(session.env())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", home.join("gitconfig"))
        .env("HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"protocol=https\nhost=git.example.com\n\n").await.unwrap();
    drop(stdin);
    child.wait_with_output().await.unwrap()
}

#[tokio::test]
async fn git_asks_for_username_and_password_in_the_app() {
    let home = tempfile::tempdir().unwrap();
    let (askpass, mut seen) = answering(|prompt| Some(if prompt.starts_with("Username") { "alice".into() } else { "s3cret".into() }));
    let session = askpass.session("/repo", "fetch").unwrap();
    let out = credential_fill(&session, home.path()).await;
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(stdout.contains("username=alice\n") && stdout.contains("password=s3cret\n"), "{stdout}");
    assert_eq!(seen.recv().await.unwrap(), "Username for 'https://git.example.com': ");
    assert_eq!(seen.recv().await.unwrap(), "Password for 'https://alice@git.example.com': ");
}

#[tokio::test]
async fn cancelling_the_prompt_stops_git() {
    let home = tempfile::tempdir().unwrap();
    let (askpass, mut seen) = answering(|_| None);
    let session = askpass.session("/repo", "push").unwrap();
    let out = credential_fill(&session, home.path()).await;
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("could not read Username"));
    assert!(seen.recv().await.unwrap().starts_with("Username"));
}

#[tokio::test]
async fn ssh_asks_for_a_key_passphrase_in_the_app() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("id_test");
    let made = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "pass phrase", "-f"]).arg(&key).status();
    if !made.is_ok_and(|s| s.success()) {
        eprintln!("ssh-keygen unavailable; skipped");
        return;
    }
    let (askpass, mut seen) = answering(|_| Some("pass phrase".into()));
    let session = askpass.session("/repo", "fetch").unwrap();
    if !session.env().iter().any(|(k, _)| k == "SSH_ASKPASS") {
        eprintln!("ssh older than 8.4; skipped");
        return;
    }
    // ssh-keygen reads passphrases the way ssh does: through SSH_ASKPASS when SSH_ASKPASS_REQUIRE=force
    let out = tokio::process::Command::new("ssh-keygen")
        .args(["-y", "-f"])
        .arg(&key)
        .envs(session.env())
        .stdin(Stdio::null())
        .output()
        .await
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("ssh-ed25519 "));
    assert!(seen.recv().await.unwrap().contains("passphrase"));
}
