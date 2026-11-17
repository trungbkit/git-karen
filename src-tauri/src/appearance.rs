//! Window appearance the renderer cannot handle alone: the native window background (shown before the page paints
//! and while resizing), and OS settings WKWebView does not expose to pages: the macOS accent colour and the
//! Reduce transparency / Increase contrast accessibility options.

use serde::Serialize;

/// Background of a window opened before any theme was applied (the dark theme's `--bg-app`).
pub const DEFAULT_BACKGROUND: (u8, u8, u8) = (0x16, 0x18, 0x1d);

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppearance {
    /// The system accent colour as `#rrggbb`; None where the OS has none
    pub accent_color: Option<String>,
    pub reduce_transparency: bool,
    pub increase_contrast: bool,
}

/// `#rgb` / `#rrggbb` (any case, `#` optional) as RGB.
pub fn parse_hex(color: &str) -> Option<(u8, u8, u8)> {
    let hex = color.trim().trim_start_matches('#');
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |s: &str| u8::from_str_radix(s, 16).ok();
    match hex.len() {
        3 => {
            let d: Vec<String> = hex.chars().map(|c| format!("{c}{c}")).collect();
            Some((channel(&d[0])?, channel(&d[1])?, channel(&d[2])?))
        }
        6 => Some((channel(&hex[0..2])?, channel(&hex[2..4])?, channel(&hex[4..6])?)),
        _ => None,
    }
}

/// `#rrggbb` from 0..1 channel values (clamped).
fn to_hex(r: f64, g: f64, b: f64) -> String {
    let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", c(r), c(g), c(b))
}

/// The current settings. AppKit objects are read on the main thread.
#[cfg(target_os = "macos")]
pub fn read_system() -> SystemAppearance {
    use objc2_app_kit::{NSColor, NSColorSpace, NSWorkspace};
    let accent_color = NSColor::controlAccentColor()
        .colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())
        .map(|c| to_hex(c.redComponent(), c.greenComponent(), c.blueComponent()));
    let workspace = NSWorkspace::sharedWorkspace();
    SystemAppearance {
        accent_color,
        reduce_transparency: workspace.accessibilityDisplayShouldReduceTransparency(),
        increase_contrast: workspace.accessibilityDisplayShouldIncreaseContrast(),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read_system() -> SystemAppearance {
    SystemAppearance::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_short_and_long_hex() {
        assert_eq!(parse_hex("#16181d"), Some((0x16, 0x18, 0x1d)));
        assert_eq!(parse_hex("F3F4F7"), Some((0xf3, 0xf4, 0xf7)));
        assert_eq!(parse_hex(" #abc "), Some((0xaa, 0xbb, 0xcc)));
        assert_eq!(parse_hex("#12345"), None);
        assert_eq!(parse_hex("#gg0000"), None);
        assert_eq!(parse_hex("rgb(0 0 0)"), None);
        assert_eq!(parse_hex("#ééé"), None);
    }

    #[test]
    fn formats_channels_as_hex() {
        assert_eq!(to_hex(0.0, 0.5, 1.0), "#0080ff");
        assert_eq!(to_hex(-1.0, 2.0, 0.0627), "#00ff10");
    }
}
