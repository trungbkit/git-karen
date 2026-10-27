// Opening a file at a line in the external editor. Editors take the line in different ways, so the arguments
// come from a template: the one in Preferences, or a known one for the editor's command.
use std::path::Path;

use crate::app_state::{launch, looks_like_mac_app, open_in_editor};

/// Arguments for well-known editors, by command name. `{file}` and `{line}` are filled in.
fn known_template(editor: &str) -> Option<&'static str> {
    let name = Path::new(editor.trim()).file_name()?.to_str()?.to_ascii_lowercase();
    let name = name.trim_end_matches(".exe").trim_end_matches(".cmd").trim_end_matches(".bat");
    Some(match name {
        "code" | "code-insiders" | "codium" | "vscodium" | "cursor" | "windsurf" | "positron" => "-g {file}:{line}",
        "subl" | "sublime_text" | "zed" | "atom" | "hx" | "helix" => "{file}:{line}",
        "idea" | "idea64" | "webstorm" | "pycharm" | "phpstorm" | "goland" | "clion" | "rider" | "rubymine" | "rustrover"
        | "studio" | "fleet" => "--line {line} {file}",
        "mate" => "-l {line} {file}",
        "vim" | "nvim" | "vi" | "gvim" | "mvim" | "emacs" | "emacsclient" | "nano" | "micro" | "kak" => "+{line} {file}",
        _ => return None,
    })
}

/// The editor's arguments to open `file` at `line`: from `template` when set, else from the editor's command.
/// None when the editor is unknown and there is no template (the file is then opened without a line).
pub fn line_args(editor: &str, template: &str, file: &str, line: u32) -> Option<Vec<String>> {
    let template = Some(template.trim()).filter(|t| !t.is_empty()).or_else(|| known_template(editor))?;
    let line = line.max(1).to_string();
    // split before filling in, so a path with spaces stays one argument
    let mut args: Vec<String> = template.split_whitespace().map(|a| a.replace("{line}", &line).replace("{file}", file)).collect();
    if !template.contains("{file}") {
        args.push(file.to_string());
    }
    Some(args)
}

/// Open `file` of `repo` at `line` with the editor command, falling back to opening it without the line.
pub fn open_at_line(editor: &str, template: &str, repo: &str, file: &str, line: u32) -> Result<(), String> {
    let cmd = editor.trim();
    let target = Path::new(repo).join(file).to_string_lossy().into_owned();
    // macOS application names are opened with `open -a`, which cannot pass a line
    let args = if cmd.is_empty() || (cfg!(target_os = "macos") && looks_like_mac_app(cmd)) { None } else { line_args(cmd, template, &target, line) };
    match args {
        Some(args) => {
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            launch(cmd, &refs, Some(repo)).or_else(|_| open_in_editor(editor, repo, Some(file)))
        }
        None => open_in_editor(editor, repo, Some(file)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(editor: &str, template: &str) -> Option<Vec<String>> {
        line_args(editor, template, "/r/my file.rs", 42)
    }

    #[test]
    fn known_editors_take_the_line_their_way() {
        assert_eq!(args("code", "").unwrap(), ["-g", "/r/my file.rs:42"]);
        assert_eq!(args("/usr/local/bin/cursor", "").unwrap(), ["-g", "/r/my file.rs:42"]);
        assert_eq!(args("subl", "").unwrap(), ["/r/my file.rs:42"]);
        assert_eq!(args("idea", "").unwrap(), ["--line", "42", "/r/my file.rs"]);
        assert_eq!(args("nvim", "").unwrap(), ["+42", "/r/my file.rs"]);
        assert_eq!(args("mate", "").unwrap(), ["-l", "42", "/r/my file.rs"]);
        assert_eq!(args("someeditor", ""), None);
    }

    #[test]
    fn a_template_overrides_and_keeps_paths_whole() {
        assert_eq!(args("someeditor", "--goto {file}:{line}").unwrap(), ["--goto", "/r/my file.rs:42"]);
        assert_eq!(args("code", "  --reuse-window -g {file}:{line} ").unwrap(), ["--reuse-window", "-g", "/r/my file.rs:42"]);
        // without {file} the path goes last
        assert_eq!(args("ed", "+{line}").unwrap(), ["+42", "/r/my file.rs"]);
        assert_eq!(line_args("code", "", "/f", 0).unwrap(), ["-g", "/f:1"]);
    }
}
