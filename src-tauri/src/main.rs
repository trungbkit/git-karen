// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // started by git or ssh as their askpass program: ask the running app and exit, before any GUI code runs
    if let Some(code) = karen_lib::askpass_main() {
        std::process::exit(code);
    }
    karen_lib::run()
}
