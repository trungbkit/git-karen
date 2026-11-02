// App updates from GitHub releases (tauri-plugin-updater, endpoint and public key in tauri.conf.json).
// One status for the whole app, broadcast to every window as `evt:update`. An update found by a check is downloaded
// in the background; it is installed, and the app restarted, only when the user asks.
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::Backend;

pub const EVT_UPDATE: &str = "evt:update";
/// Preference (renderer `Preferences.autoUpdate`) turning the periodic check and background download on; on when unset
const PREF_AUTO: &str = "autoUpdate";
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(15);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    UpToDate,
    /// Found, not downloaded (yet, or the download failed: see `error`)
    Available,
    Downloading,
    /// Downloaded and verified; installed on restart
    Ready,
    Installing,
    /// The check failed
    Error,
}

#[derive(Clone, Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: Phase,
    pub current_version: String,
    /// The release found by the last check
    pub version: Option<String>,
    pub notes: Option<String>,
    /// RFC 3339
    pub date: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    /// Unix milliseconds of the last check that reached the server
    pub checked_at: Option<u64>,
    /// False in development builds: they check but never download or install
    pub can_install: bool,
}

#[derive(Default)]
struct Inner {
    status: UpdateStatus,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

pub struct Updates {
    inner: Mutex<Inner>,
    /// One check, download or install at a time
    op: tokio::sync::Mutex<()>,
}

impl Updates {
    pub fn new(current_version: String) -> Self {
        let status = UpdateStatus { current_version, can_install: !cfg!(debug_assertions), ..Default::default() };
        Updates { inner: Mutex::new(Inner { status, ..Default::default() }), op: tokio::sync::Mutex::new(()) }
    }

    pub fn status(&self) -> UpdateStatus {
        self.inner.lock().unwrap().status.clone()
    }
}

fn updates(app: &AppHandle) -> &Updates {
    app.state::<Updates>().inner()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Change the status and tell every window.
fn update_status(app: &AppHandle, f: impl FnOnce(&mut Inner)) -> UpdateStatus {
    let status = {
        let mut inner = updates(app).inner.lock().unwrap();
        f(&mut inner);
        inner.status.clone()
    };
    let _ = app.emit(EVT_UPDATE, &status);
    status
}

/// Ask the release endpoint for a newer version; with `download`, fetch it in the background when one is found.
/// Once an update is downloaded there is nothing more to check until the app restarts into it.
pub async fn check(app: &AppHandle, download: bool) -> UpdateStatus {
    let _op = updates(app).op.lock().await;
    let current = updates(app).status();
    if current.phase == Phase::Ready {
        return current;
    }
    update_status(app, |i| {
        i.status.phase = Phase::Checking;
        i.status.error = None;
    });
    let cleanup = app.clone();
    let found = async {
        app.updater_builder()
            // Windows installers quit the app themselves: stop its terminals first
            .on_before_exit(move || cleanup.state::<Backend>().ptys.kill_all())
            .build()?
            .check()
            .await
    }
    .await;

    let status = update_status(app, |i| match found {
        Err(e) => {
            i.status.phase = Phase::Error;
            i.status.error = Some(e.to_string());
        }
        Ok(None) => {
            i.update = None;
            i.bytes = None;
            i.status.phase = Phase::UpToDate;
            i.status.checked_at = Some(now_ms());
            i.status.version = None;
            i.status.notes = None;
            i.status.date = None;
        }
        Ok(Some(update)) => {
            i.status.checked_at = Some(now_ms());
            i.status.phase = Phase::Available;
            i.status.version = Some(update.version.clone());
            i.status.notes = update.body.clone().filter(|b| !b.trim().is_empty());
            i.status.date = update.raw_json.get("pub_date").and_then(|d| d.as_str()).map(String::from);
            i.status.downloaded = 0;
            i.status.total = None;
            i.bytes = None;
            i.update = Some(update);
        }
    });
    if download && status.phase == Phase::Available && status.can_install {
        return download_locked(app).await;
    }
    status
}

/// Download the update the last check found.
pub async fn download(app: &AppHandle) -> UpdateStatus {
    let _op = updates(app).op.lock().await;
    download_locked(app).await
}

async fn download_locked(app: &AppHandle) -> UpdateStatus {
    let update = {
        let inner = updates(app).inner.lock().unwrap();
        if !inner.status.can_install || inner.bytes.is_some() {
            return inner.status.clone();
        }
        inner.update.clone()
    };
    let Some(update) = update else { return updates(app).status() };
    update_status(app, |i| {
        i.status.phase = Phase::Downloading;
        i.status.downloaded = 0;
        i.status.total = None;
        i.status.error = None;
    });

    let mut last = Instant::now();
    let progress = |chunk: usize, total: Option<u64>| {
        let emit = last.elapsed() >= PROGRESS_EVERY;
        let mut inner = updates(app).inner.lock().unwrap();
        inner.status.downloaded += chunk as u64;
        inner.status.total = total;
        if emit {
            last = Instant::now();
            let _ = app.emit(EVT_UPDATE, &inner.status);
        }
    };
    let result = update.download(progress, || {}).await;

    update_status(app, |i| match result {
        Ok(bytes) => {
            i.status.phase = Phase::Ready;
            i.status.downloaded = bytes.len() as u64;
            i.bytes = Some(bytes);
        }
        Err(e) => {
            i.status.phase = Phase::Available;
            i.status.error = Some(format!("Download failed: {e}"));
        }
    })
}

/// Install the downloaded update and restart into it. On Windows the installer takes over and quits the app.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let _op = updates(app).op.lock().await;
    let (update, bytes) = {
        let mut inner = updates(app).inner.lock().unwrap();
        match (inner.update.clone(), inner.bytes.take()) {
            (Some(update), Some(bytes)) => (update, bytes),
            (_, bytes) => {
                inner.bytes = bytes;
                return Err("No update has been downloaded yet".into());
            }
        }
    };
    update_status(app, |i| i.status.phase = Phase::Installing);
    let result = tokio::task::spawn_blocking(move || {
        let result = update.install(&bytes).map_err(|e| e.to_string());
        (result, bytes)
    })
    .await
    .map_err(|e| e.to_string())?;
    match result {
        (Ok(()), _) => {
            app.request_restart();
            Ok(())
        }
        (Err(e), bytes) => {
            update_status(app, |i| {
                i.bytes = Some(bytes);
                i.status.phase = Phase::Ready;
                i.status.error = Some(format!("Install failed: {e}"));
            });
            Err(e)
        }
    }
}

fn auto_enabled(app: &AppHandle) -> bool {
    app.state::<Backend>().store.lock().unwrap().preference_bool(PREF_AUTO).unwrap_or(true)
}

/// Check shortly after launch and every few hours while `autoUpdate` is on. Development builds only check by hand.
pub fn spawn_background_checks(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            if auto_enabled(&app) {
                check(&app, true).await;
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}
