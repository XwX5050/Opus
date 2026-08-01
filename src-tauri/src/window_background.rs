//! Native window background sync (src/theme/useTheme.ts).
//!
//! During live window resizes the WKWebView repaints a step behind the drag,
//! so the native NSWindow background (white by default) flashes along the
//! resized edge. The frontend reports the resolved canvas color (`--canvas`
//! in src/theme/tokens.css) whenever the theme changes, and this command
//! paints the native window layer to match. `lib.rs` also seeds the initial
//! background with the dark default canvas before the first frame.

use tauri::window::Color;

/// The app's default (dark) canvas color, matching `--canvas` in
/// src/theme/tokens.css for the initial theme before the session loads.
pub const DEFAULT_CANVAS: &str = "#1e1f24";

/// Parses a `#rrggbb` hex color string into an opaque RGBA [`Color`].
///
/// Malformed input (missing `#`, wrong length, non-hex digits) returns an
/// `Err` so callers can surface an invoke error instead of panicking.
pub fn parse_hex_color(input: &str) -> Result<Color, String> {
    let hex = input
        .strip_prefix('#')
        .ok_or_else(|| format!("invalid hex color: {input:?}"))?;
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("invalid hex color: {input:?}"));
    }
    let rgb = u32::from_str_radix(hex, 16).map_err(|_| format!("invalid hex color: {input:?}"))?;
    Ok(Color(
        ((rgb >> 16) & 0xff) as u8,
        ((rgb >> 8) & 0xff) as u8,
        (rgb & 0xff) as u8,
        255,
    ))
}

/// Sets the calling window's native background to the given opaque hex color.
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn set_window_background(window: tauri::WebviewWindow, color: String) -> Result<(), String> {
    window
        .set_background_color(Some(parse_hex_color(&color)?))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_hex_colors() {
        assert_eq!(
            parse_hex_color("#1e1f24"),
            Ok(Color(0x1e, 0x1f, 0x24, 0xff))
        );
        assert_eq!(
            parse_hex_color("#ffffff"),
            Ok(Color(0xff, 0xff, 0xff, 0xff))
        );
        assert_eq!(parse_hex_color("#000000"), Ok(Color(0, 0, 0, 0xff)));
        assert_eq!(
            parse_hex_color("#ABCDEF"),
            Ok(Color(0xab, 0xcd, 0xef, 0xff))
        );
    }

    #[test]
    fn rejects_malformed_input() {
        for bad in [
            "", "#", "1e1f24", "#12345", "#1234567", "#gggggg", "#1e1f2g", "#12 345", "#12345\n",
            " #1e1f24", "#1e1f24 ",
        ] {
            assert!(parse_hex_color(bad).is_err(), "expected Err for {bad:?}");
        }
    }

    #[test]
    fn default_canvas_parses() {
        assert_eq!(
            parse_hex_color(DEFAULT_CANVAS),
            Ok(Color(0x1e, 0x1f, 0x24, 0xff))
        );
    }
}
