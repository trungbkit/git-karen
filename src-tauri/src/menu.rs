// Native application menu. Items whose id is a command id (src/shared/commands.ts) are forwarded to the
// focused window as an `evt:command` event; the `kc:` ids are handled here.
use tauri::menu::{AboutMetadata, Menu, MenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::Backend;

pub const EVT_COMMAND: &str = "evt:command";

fn item(app: &AppHandle, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, true, accel)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let mac = cfg!(target_os = "macos");
    let i = |id: &str, label: &str, accel: &str| item(app, id, label, (!accel.is_empty()).then_some(accel));
    let prefs = i("app:preferences", "Preferences…", "CmdOrCtrl+Comma")?;

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&i("tab:new", "New Tab", "CmdOrCtrl+T")?)
        .item(&i("tab:reopen", "Reopen Closed Tab", "CmdOrCtrl+Shift+T")?)
        .separator()
        .item(&i("repo:open", "Open Repository…", "CmdOrCtrl+O")?)
        .item(&i("repo:clone", "Clone Repository…", "CmdOrCtrl+N")?)
        .item(&i("repo:init", "Init Repository…", "CmdOrCtrl+I")?)
        .item(&i("view:workspace", "Workspaces", "")?)
        .separator()
        .item(&i("repo:openInEditor", "Open in External Editor", "CmdOrCtrl+Shift+E")?)
        .item(&i("repo:openTerminal", "Open in Terminal", "Alt+T")?)
        .item(&i("repo:showInFolder", if mac { "Reveal in Finder" } else { "Show in File Manager" }, "CmdOrCtrl+Alt+O")?)
        .separator()
        .item(&i("tab:close", "Close Tab", "CmdOrCtrl+W")?);
    if !mac {
        file = file.separator().item(&prefs).quit();
    }

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&i("view:searchCommits", "Search Commits", "CmdOrCtrl+F")?)
        .build()?;

    let repository = SubmenuBuilder::new(app, "Repository")
        .item(&i("repo:fetch", "Fetch All", "CmdOrCtrl+L")?)
        .item(&i("repo:pull", "Pull", "CmdOrCtrl+Shift+L")?)
        .item(&i("repo:pullRebase", "Pull (Rebase)", "")?)
        .item(&i("repo:push", "Push", "CmdOrCtrl+Shift+K")?)
        .separator()
        .item(&i("repo:createBranch", "Create Branch", "CmdOrCtrl+B")?)
        .item(&i("view:switchBranch", "Switch Branch…", "CmdOrCtrl+Shift+B")?)
        .item(&i("repo:stash", "Stash", "CmdOrCtrl+Alt+S")?)
        .item(&i("repo:popStash", "Pop Stash", "CmdOrCtrl+Alt+P")?)
        .separator()
        .item(&i("repo:undo", "Undo Last Destructive Action", "")?)
        .item(&i("view:reflog", "Recovery (Reflog)", "")?)
        .item(&i("view:compareWithDefault", "Compare with Default Branch", "")?)
        .separator()
        .item(&i("repo:stageAll", "Stage All Changes", "CmdOrCtrl+Shift+S")?)
        .item(&i("repo:unstageAll", "Unstage All Changes", "CmdOrCtrl+Shift+U")?)
        .item(&i("workDir:focusChangedFiles", "Focus Changed Files", "CmdOrCtrl+Shift+F")?)
        .item(&i("workDir:focusCommitMessage", "Focus Commit Message", "CmdOrCtrl+Shift+M")?)
        .item(&i("workDir:generateCommitMessage", "Write Commit Message with AI", "")?)
        .item(&i("repo:smartCommit", "Smart Commit and Pull Request…", "")?)
        .item(&i("repo:splitCommit", "Split Changes into Commits…", "")?)
        .item(&i("repo:createPullRequest", "Create Pull Request…", "")?)
        .separator()
        .item(&i("app:refresh", "Refresh", "CmdOrCtrl+R")?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&i("view:toggleFuzzyFinder", "Command Palette", "CmdOrCtrl+P")?)
        .item(&i("view:toggleFuzzyFinderOpenRepo", "Quick Open Repository", "CmdOrCtrl+Shift+O")?)
        .item(&i("view:toggleFuzzyFinderHistory", "File History", "CmdOrCtrl+Shift+H")?)
        .separator()
        .item(&i("view:toggleLeftPanel", "Toggle Left Panel", "CmdOrCtrl+J")?)
        .item(&i("view:toggleDetailPanel", "Toggle Detail Panel", "CmdOrCtrl+K")?)
        .item(&i("view:toggleTerminal", "Toggle Terminal", "Ctrl+Backquote")?)
        .item(&i("view:newTerminal", "New Terminal", "Ctrl+Shift+Backquote")?)
        .item(&i("view:toggleKeyBindings", "Keyboard Shortcuts", "CmdOrCtrl+Slash")?)
        .separator()
        .item(&i("kc:zoomIn", "Zoom In", "CmdOrCtrl+Equal")?)
        .item(&i("kc:zoomOut", "Zoom Out", "CmdOrCtrl+Minus")?)
        .item(&i("kc:zoomReset", "Actual Size", "CmdOrCtrl+0")?)
        .separator()
        .fullscreen()
        .separator()
        .item(&i("kc:reload", "Reload", "CmdOrCtrl+Shift+R")?)
        .item(&i("kc:devtools", "Toggle Developer Tools", if mac { "Alt+Cmd+I" } else { "Ctrl+Shift+I" })?)
        .build()?;

    let mut window = SubmenuBuilder::new(app, "Window")
        .item(&i("tab:next", "Next Tab", "Ctrl+Tab")?)
        .item(&i("tab:prev", "Previous Tab", "Ctrl+Shift+Tab")?)
        .separator()
        .minimize()
        .maximize();
    window = if mac { window.separator().bring_all_to_front() } else { window.close_window() };
    let window = window.build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&MenuItem::with_id(app, "view:toggleKeyBindings:help", "Keyboard Shortcuts", true, None::<&str>)?)
        .item(&i("kc:gitDocs", "Git Documentation", "")?)
        .build()?;

    let mut top: Vec<Submenu<Wry>> = Vec::new();
    if mac {
        let name = app.package_info().name.clone();
        top.push(
            SubmenuBuilder::new(app, &name)
                .about(Some(AboutMetadata { name: Some(name.clone()), ..Default::default() }))
                .separator()
                .item(&prefs)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?,
        );
    }
    top.extend([file.build()?, edit, repository, view, window, help]);
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = top.iter().map(|s| s as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    Menu::with_items(app, &refs)
}

fn focused_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    windows.values().find(|w| w.is_focused().unwrap_or(false)).or_else(|| windows.values().next()).cloned()
}

pub fn handle_event(app: &AppHandle, id: &str) {
    let Some(win) = focused_window(app) else { return };
    match id {
        "kc:zoomIn" | "kc:zoomOut" | "kc:zoomReset" => {
            let backend = app.state::<Backend>();
            let mut zoom = backend.zoom.lock().unwrap();
            *zoom = match id {
                "kc:zoomIn" => (*zoom * 1.1).min(3.0),
                "kc:zoomOut" => (*zoom / 1.1).max(0.5),
                _ => 1.0,
            };
            let _ = win.set_zoom(*zoom);
        }
        "kc:reload" => drop(win.reload()),
        "kc:devtools" => {
            #[cfg(debug_assertions)]
            if win.is_devtools_open() {
                win.close_devtools()
            } else {
                win.open_devtools()
            }
        }
        "kc:gitDocs" => drop(app.opener().open_url("https://git-scm.com/doc", None::<&str>)),
        _ => {
            let command = id.strip_suffix(":help").unwrap_or(id);
            let _ = app.emit_to(win.label(), EVT_COMMAND, command);
        }
    }
}
