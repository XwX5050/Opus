//! Installed-font enumeration for the settings dialog
//! (src/app/SettingsDialog.tsx).
//!
//! WKWebView has no `queryLocalFonts` (a Chromium-only API), so the native
//! side lists font family names via Core Text and the dialog offers them in
//! a searchable `<datalist>` when the user picks a custom font.

use objc2_core_foundation::{CFArray, CFRetained, CFString};

/// Enumerates every installed font family name via Core Text, in Core
/// Text's registration order. The dialog sorts them for display.
fn font_family_names() -> Vec<String> {
    let families = unsafe { objc2_core_text::CTFontManagerCopyAvailableFontFamilyNames() };
    // SAFETY: Core Text documents the returned array as containing the
    // available font family names, i.e. `CFString` objects, so reinterpreting
    // the opaque array as `CFArray<CFString>` is sound.
    let families = unsafe { CFRetained::cast_unchecked::<CFArray<CFString>>(families) };
    families.iter().map(|family| family.to_string()).collect()
}

/// Returns the family names of every font installed on the system.
///
/// Runs on the async runtime instead of the main thread: enumerating every
/// installed font takes tens of milliseconds and must not stall window and
/// event handling while the settings dialog opens. The enumeration itself is
/// a plain read of the system font database and is safe off the main thread.
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn list_installed_fonts() -> Result<Vec<String>, String> {
    Ok(font_family_names())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_installed_font_family_names() {
        let names = font_family_names();
        assert!(!names.is_empty(), "macOS always ships system fonts");
        assert!(names.iter().all(|name| !name.is_empty()));
    }
}
