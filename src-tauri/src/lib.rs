// Tauri shell: wires the git service, AI providers, app state, terminals and menu to the renderer.
// The renderer reaches the backend only through the commands below (see src/renderer/src/platform/bridge.ts).
mod ai;
mod app_state;
mod editor;
mod git;
mod integrations;
mod launch;
mod menu;
mod terminal;
#[cfg(target_os = "macos")]
mod traffic_lights;
mod types;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use ai::AiStore;
use app_state::AppStateStore;
use git::service::{Args, GitService, Hooks};
use terminal::{PtyManager, TermEvent};
use types::ProgressEvent;

const EVT_REPO_CHANGED: &str = "evt:repoChanged";
const EVT_PROGRESS: &str = "evt:progress";

pub struct Backend {
    git: Arc<GitService>,
    store: Mutex<AppStateStore>,
    ai: Mutex<AiStore>,
    ptys: Arc<PtyManager>,
    pub zoom: Mutex<f64>,
    window_seq: AtomicUsize,
}

struct EmitHooks(AppHandle);

impl Hooks for EmitHooks {
    fn progress(&self, e: ProgressEvent) {
        let _ = self.0.emit(EVT_PROGRESS, e);
    }
    fn repo_changed(&self, repo: &str) {
        let _ = self.0.emit(EVT_REPO_CHANGED, repo);
    }
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_call(backend: State<'_, Backend>, method: String, args: Vec<Value>) -> Result<Value, String> {
    backend.git.call(&method, args).await
}

#[tauri::command]
async fn app_call(
    app: AppHandle,
    window: WebviewWindow,
    backend: State<'_, Backend>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    let a = Args(args);
    let store = || backend.store.lock().unwrap();
    match method.as_str() {
        "getState" => to_value(store().get()),
        "setOpenTabs" => to_value(store().set_open_tabs(a.get(0)?, a.get(1)?)?),
        "addRecent" => to_value(store().add_recent(&a.get::<String>(0)?)?),
        "toggleFavorite" => to_value(store().toggle_favorite(&a.get::<String>(0)?)?),
        "removeRecent" => to_value(store().remove_recent(&a.get::<String>(0)?)?),
        "setPreferences" => to_value(store().set_preferences(a.get(0)?)?),
        "setWorkspaces" => to_value(store().set_workspaces(a.get(0)?)?),
        "takeOpenRequests" => to_value(app.state::<launch::Pending>().take()),
        "discoverRepos" => {
            let dirs: Vec<String> = a.get(0)?;
            let home = app.path().home_dir().ok();
            let found = tokio::task::spawn_blocking(move || app_state::discover_repos(&dirs, home.as_deref()))
                .await
                .map_err(|e| e.to_string())?;
            to_value(found)
        }
        "cliStatus" => to_value(launch::cli_status(&app)),
        "installCli" => to_value(launch::install_cli(&app)?),
        "pickDirectory" => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut dialog = app.dialog().file().set_can_create_directories(true).set_parent(&window);
            if let Some(title) = a.get::<Option<String>>(0)? {
                dialog = dialog.set_title(title);
            }
            dialog.pick_folder(move |p| drop(tx.send(p)));
            let picked = rx.await.ok().flatten().and_then(|p| p.into_path().ok());
            to_value(picked.map(|p| p.to_string_lossy().into_owned()))
        }
        "openExternal" => {
            let url: String = a.get(0)?;
            let lower = url.to_ascii_lowercase();
            if !lower.starts_with("http://") && !lower.starts_with("https://") {
                return Err("Only http(s) URLs can be opened".into());
            }
            app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "showInFolder" => {
            app.opener().reveal_item_in_dir(a.get::<String>(0)?).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "openInEditor" => {
            let editor = store().preference_str("externalEditor").unwrap_or_else(|| "code".into());
            let (repo, file) = (a.get::<String>(0)?, a.get::<Option<String>>(1)?);
            match (file, a.get::<Option<u32>>(2)?) {
                (Some(file), Some(line)) => {
                    let template = store().preference_str("editorLineArgs").unwrap_or_default();
                    editor::open_at_line(&editor, &template, &repo, &file, line)?
                }
                (file, _) => app_state::open_in_editor(&editor, &repo, file.as_deref())?,
            }
            Ok(Value::Null)
        }
        "openTerminal" => {
            let terminal = store().preference_str("externalTerminal").unwrap_or_else(|| "Terminal".into());
            app_state::open_terminal(&terminal, &a.get::<String>(0)?)?;
            Ok(Value::Null)
        }
        _ => Err(format!("Unknown method: {method}")),
    }
}

#[tauri::command]
async fn ai_call(backend: State<'_, Backend>, method: String, args: Vec<Value>) -> Result<Value, String> {
    let a = Args(args);
    // the lock is never held across an await: requests can take as long as the provider's timeout
    let snapshot = || backend.ai.lock().unwrap().snapshot();
    match method.as_str() {
        "status" => to_value(snapshot().status().await),
        "update" => {
            backend.ai.lock().unwrap().update(a.get(0)?, a.get(1)?)?;
            to_value(snapshot().status().await)
        }
        "verify" => to_value(snapshot().verify(&a.get::<String>(0)?, a.get(1)?).await?),
        "complete" => {
            let resolved = snapshot().resolve().await?;
            to_value(ai::complete(&resolved, &a.get::<String>(0)?, a.get(1)?).await?)
        }
        _ => Err(format!("Unknown method: {method}")),
    }
}

fn dim(v: f64) -> u16 {
    v.clamp(1.0, u16::MAX as f64) as u16
}

#[tauri::command]
async fn term_create(
    webview: tauri::Webview,
    backend: State<'_, Backend>,
    id: String,
    cwd: String,
    cols: f64,
    rows: f64,
    on_event: Channel<TermEvent>,
) -> Result<(), String> {
    let sink = Box::new(move |e: TermEvent| drop(on_event.send(e)));
    backend.ptys.create(webview.label(), &id, &cwd, dim(cols), dim(rows), sink)
}

#[tauri::command]
async fn term_write(webview: tauri::Webview, backend: State<'_, Backend>, id: String, data: String) -> Result<(), String> {
    backend.ptys.write(webview.label(), &id, &data);
    Ok(())
}

#[tauri::command]
async fn term_resize(
    webview: tauri::Webview,
    backend: State<'_, Backend>,
    id: String,
    cols: f64,
    rows: f64,
) -> Result<(), String> {
    backend.ptys.resize(webview.label(), &id, dim(cols), dim(rows));
    Ok(())
}

#[tauri::command]
async fn term_kill(webview: tauri::Webview, backend: State<'_, Backend>, id: String) -> Result<(), String> {
    backend.ptys.kill(webview.label(), &id);
    Ok(())
}

/// Node-style platform name, as the renderer expects (`darwin`, `win32`, `linux`).
fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let n = app.state::<Backend>().window_seq.fetch_add(1, Ordering::SeqCst);
    let label = if n == 0 { "main".to_string() } else { format!("main-{n}") };
    let dev_origin = app.config().build.dev_url.as_ref().map(|u| u.origin());
    let handle = app.clone();
    let drop_label = label.clone();
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("Karen")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .background_color(tauri::window::Color(0x16, 0x18, 0x1d, 0xff))
        // the native file-drop handler would swallow the HTML5 drag-and-drop the graph and tabs rely on
        .disable_drag_drop_handler()
        .initialization_script(format!("window.__KC_PLATFORM__ = {:?};", platform()))
        // links never navigate the app window; http(s) ones open in the system browser
        .on_navigation(move |url| {
            // with the native drop handler off, a file or folder dropped on the page navigates to it: open it instead
            if url.scheme() == "file" {
                if let Ok(path) = url.to_file_path() {
                    handle.state::<launch::Pending>().push([launch::OpenRequest { path: path.to_string_lossy().into_owned(), source: "drop" }]);
                    let _ = handle.emit_to(drop_label.as_str(), launch::EVT_OPEN_REQUESTS, ());
                }
                return false;
            }
            let internal = url.scheme() == "tauri"
                || url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions) && Some(url.origin()) == dev_origin);
            if !internal && matches!(url.scheme(), "http" | "https") {
                let _ = handle.opener().open_url(url.as_str(), None::<&str>);
            }
            internal
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    traffic_lights::install(&window);
    Ok(window)
}

/// State file location. KAREN_USER_DATA=/some/dir runs an isolated profile (tests, multiple instances).
fn state_file(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("KAREN_USER_DATA") {
        return PathBuf::from(dir).join("state.json");
    }
    let file = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("state.json");
    // carry over recents, tabs, preferences and settings from builds made before the rename to Karen (the Tauri
    // identifier, then the Electron userData folders named after the app)
    if !file.exists() {
        if let Ok(data) = app.path().data_dir() {
            let old = ["com.krakencraft.app", "Kraken Craft", "git-kraken-craft"].iter().map(|d| data.join(d)).find(|d| d.join("state.json").exists());
            if let Some(old) = old {
                let _ = std::fs::create_dir_all(file.parent().unwrap());
                for name in ["state.json", "ai.json", "integrations.json"] {
                    if old.join(name).exists() {
                        let _ = std::fs::copy(old.join(name), file.with_file_name(name));
                    }
                }
            }
        }
    }
    file
}

/// GUI apps on macOS start with a minimal PATH; make Homebrew-installed git, git-lfs and editors reachable.
fn extend_path() {
    if cfg!(target_os = "macos") {
        let current = std::env::var("PATH").unwrap_or_default();
        let parts: Vec<&str> = current.split(':').filter(|p| !p.is_empty()).collect();
        let extra = ["/opt/homebrew/bin", "/usr/local/bin"].into_iter().filter(|p| !parts.contains(p));
        let joined: Vec<&str> = extra.chain(parts.iter().copied()).collect();
        std::env::set_var("PATH", joined.join(":"));
    }
}

pub fn run() {
    extend_path();
    // the queue exists before any plugin: a second instance may hand over its arguments while the app is starting
    let mut builder = tauri::Builder::default().manage(launch::Pending::default());
    // registered first so a second instance exits before it builds anything. An isolated profile (KAREN_USER_DATA) is
    // meant to run next to the normal app, and so is a dev build (`tauri dev`), unless KC_SINGLE_INSTANCE is set.
    let single = std::env::var_os("KAREN_USER_DATA").is_none()
        && (!cfg!(debug_assertions) || std::env::var_os("KC_SINGLE_INSTANCE").is_some());
    if single {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            launch::deliver(app, launch::requests_from_args(&args, Path::new(&cwd)), create_window)
        }));
    }
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Backend {
                git: Arc::new(GitService::new(Arc::new(EmitHooks(handle.clone())))),
                store: Mutex::new(AppStateStore::new(state_file(&handle))),
                ai: Mutex::new(AiStore::new(state_file(&handle).with_file_name("ai.json"))),
                ptys: Arc::new(PtyManager::default()),
                zoom: Mutex::new(1.0),
                window_seq: AtomicUsize::new(0),
            });
            app.manage(integrations::Integrations::new(state_file(&handle).with_file_name("integrations.json")));
            app.set_menu(menu::build(&handle)?)?;
            // paths on the command line (`karen path` with no instance running); the first page takes them
            let cwd = std::env::current_dir().unwrap_or_default();
            app.state::<launch::Pending>().push(launch::requests_from_args(&std::env::args().collect::<Vec<_>>(), &cwd));
            // on macOS the OS hands links (and files opened from Finder or the Dock) to the running app;
            // Windows and Linux start a second instance with the link as its argument instead
            let opener = handle.clone();
            app.deep_link().on_open_url(move |e| {
                launch::deliver(&opener, e.urls().iter().filter_map(launch::request_from_url).collect(), create_window)
            });
            // installers register the scheme; this covers unpackaged builds (AppImage, a copied .exe)
            #[cfg(any(windows, target_os = "linux"))]
            if !cfg!(debug_assertions) {
                let _ = app.deep_link().register_all();
            }
            launch::refresh_cli_script(&handle);
            create_window(&handle)?;
            Ok(())
        })
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .on_page_load(|webview, payload| {
            let app = webview.app_handle();
            match payload.event() {
                // ptys die with their page (a reload would orphan them)
                PageLoadEvent::Started => app.state::<Backend>().ptys.kill_owner(webview.label()),
                PageLoadEvent::Finished if std::env::var_os("KC_DEV_OPEN_TERMINAL").is_some() => {
                    let (app, label) = (app.clone(), webview.label().to_string());
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        let _ = app.emit_to(label.as_str(), menu::EVT_COMMAND, "view:toggleTerminal");
                    });
                }
                PageLoadEvent::Finished => {}
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.app_handle().state::<Backend>().ptys.kill_owner(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![git_call, app_call, ai_call, integrations::integrations_call, term_create, term_write, term_resize, term_kill])
        .build(tauri::generate_context!())
        .expect("error while building Karen");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { code, api, .. } => {
            app.state::<Backend>().git.unwatch_all();
            // macOS apps stay alive with no windows; the Dock icon reopens one
            if code.is_none() && cfg!(target_os = "macos") {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => {
            if app.webview_windows().is_empty() {
                let _ = create_window(app);
            }
        }
        RunEvent::Exit => app.state::<Backend>().ptys.kill_all(),
        _ => {}
    });
}
