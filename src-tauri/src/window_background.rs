//! Native window background sync (src/theme/useTheme.ts).
//!
//! During live window resizes the webview repaints a step behind the drag,
//! so white flashes along the resized edge. On macOS two layers need the
//! canvas color:
//!
//! - the native NSWindow background (white by default) — `set_background_color`;
//! - the WKWebView's under-page background (`underPageBackgroundColor`, white
//!   by default) — the surface AppKit paints into newly exposed regions while
//!   the webview lags behind the drag. wry only sets it under its
//!   `transparent` feature, so an opaque app must set it explicitly.
//!
//! On Windows only the cross-platform `set_background_color` exists; WebView2
//! has no separate under-page layer to paint.
//!
//! The frontend reports the resolved canvas color (`--canvas` in
//! src/theme/tokens.css) whenever the theme changes; `lib.rs` also seeds the
//! initial background with the dark default canvas before the first frame.
//!
//! Linux has no equivalent: the window is undecorated and carries no native
//! menu bar (see lib.rs), so there is no native chrome left to theme and the
//! module is not compiled there.

use tauri::window::Color;

/// The app's default (dark) canvas color, matching `--canvas` in
/// src/theme/tokens.css for the initial theme before the session loads.
pub const DEFAULT_CANVAS: &str = "#0b0b0e";

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

/// Paints the window's native background with the given opaque color. On
/// macOS the WKWebView under-page background is painted too: that layer is
/// what flashes during live resizes, because AppKit paints it into newly
/// exposed regions before the webview reflows and repaints. Windows has no
/// such under-page layer, so `set_background_color` is all there is to do.
pub(crate) fn apply_background(window: &tauri::WebviewWindow, color: Color) -> Result<(), String> {
    window
        .set_background_color(Some(color))
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    window
        .with_webview(move |webview| {
            // SAFETY: `inner()` returns this webview's live WKWebView, and
            // `with_webview` runs the closure on the main thread, where the
            // webview is guaranteed to be alive.
            let view = unsafe { &*webview.inner().cast::<objc2_web_kit::WKWebView>() };
            let ns_color = objc2_app_kit::NSColor::colorWithSRGBRed_green_blue_alpha(
                f64::from(color.0) / 255.0,
                f64::from(color.1) / 255.0,
                f64::from(color.2) / 255.0,
                f64::from(color.3) / 255.0,
            );
            // SAFETY: `setUnderPageBackgroundColor:` is a plain property setter.
            unsafe {
                view.setUnderPageBackgroundColor(Some(&ns_color));
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Sets the calling window's native background (and on macOS its WKWebView
/// under-page background) to the given opaque hex color.
#[tauri::command]
pub fn set_window_background(window: tauri::WebviewWindow, color: String) -> Result<(), String> {
    apply_background(&window, parse_hex_color(&color)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_hex_colors() {
        assert_eq!(
            parse_hex_color("#0b0b0e"),
            Ok(Color(0x0b, 0x0b, 0x0e, 0xff))
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
            Ok(Color(0x0b, 0x0b, 0x0e, 0xff))
        );
    }
}
