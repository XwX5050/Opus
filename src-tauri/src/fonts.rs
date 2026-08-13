//! Installed-font enumeration for the settings dialog
//! (src/app/SettingsDialog.tsx).
//!
//! WKWebView has no `queryLocalFonts` (a Chromium-only API), so the native
//! side lists font family names via Core Text and the dialog offers them in
//! a searchable `<datalist>` when the user picks a custom font.

use objc2_core_foundation::{CFArray, CFRetained, CFString};

/// Returns the family names of every font installed on the system, in Core
/// Text's registration order. The dialog sorts them for display.
///
/// This is a plain read of the system font database and is safe to run off
/// the main thread.
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn list_installed_fonts() -> Result<Vec<String>, String> {
    let families = unsafe { objc2_core_text::CTFontManagerCopyAvailableFontFamilyNames() };
    // SAFETY: Core Text documents the returned array as containing the
    // available font family names, i.e. `CFString` objects, so reinterpreting
    // the opaque array as `CFArray<CFString>` is sound.
    let families = unsafe { CFRetained::cast_unchecked::<CFArray<CFString>>(families) };
    Ok(families.iter().map(|family| family.to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_installed_font_family_names() {
        let names = list_installed_fonts().expect("font enumeration succeeds");
        assert!(!names.is_empty(), "macOS always ships system fonts");
        assert!(names.iter().all(|name| !name.is_empty()));
    }
}
