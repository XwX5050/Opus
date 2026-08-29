//! Installed-font enumeration for the settings dialog
//! (src/app/SettingsDialog.tsx).
//!
//! Neither WKWebView nor WebView2 has `queryLocalFonts` (a Chromium-only
//! API), so the native side lists font family names — via Core Text on
//! macOS, via the `CurrentVersion\Fonts` registry keys on Windows — and the
//! dialog offers them in a searchable `<datalist>` when the user picks a
//! custom font.

#[cfg(target_os = "macos")]
use objc2_core_foundation::{CFArray, CFRetained, CFString};

/// Enumerates every installed font family name via Core Text, in Core
/// Text's registration order. The dialog sorts them for display.
#[cfg(target_os = "macos")]
fn font_family_names() -> Vec<String> {
    let families = unsafe { objc2_core_text::CTFontManagerCopyAvailableFontFamilyNames() };
    // SAFETY: Core Text documents the returned array as containing the
    // available font family names, i.e. `CFString` objects, so reinterpreting
    // the opaque array as `CFArray<CFString>` is sound.
    let families = unsafe { CFRetained::cast_unchecked::<CFArray<CFString>>(families) };
    families.iter().map(|family| family.to_string()).collect()
}

/// Enumerates every installed font family name from the registry: the
/// per-machine key lists system fonts, the per-user key lists fonts
/// installed without administrator rights. A missing or unreadable key is
/// skipped so enumeration still works in restricted environments.
#[cfg(target_os = "windows")]
fn font_family_names() -> Vec<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const FONTS_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";
    let mut names = Vec::new();
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let Ok(key) = RegKey::predef(root).open_subkey(FONTS_KEY) else {
            continue;
        };
        for (name, _) in key.enum_values().filter_map(|entry| entry.ok()) {
            names.push(strip_font_type_suffix(&name));
        }
    }
    names.retain(|name| !name.is_empty());
    names.sort();
    names.dedup();
    names
}

/// Registry value names carry a trailing type suffix (" (TrueType)",
/// " (OpenType)", " (VGA res)", …); the dialog wants bare family names.
#[cfg(target_os = "windows")]
fn strip_font_type_suffix(name: &str) -> String {
    match name.rfind(" (") {
        Some(index) if name.ends_with(')') => name[..index].trim_end().to_string(),
        _ => name.trim().to_string(),
    }
}

/// Returns the family names of every font installed on the system.
///
/// Runs on the async runtime instead of the main thread: enumerating every
/// installed font takes tens of milliseconds and must not stall window and
/// event handling while the settings dialog opens. The enumeration itself is
/// a plain read of the system font database and is safe off the main thread.
#[tauri::command]
pub async fn list_installed_fonts() -> Result<Vec<String>, String> {
    Ok(font_family_names())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_installed_font_family_names() {
        let names = font_family_names();
        assert!(!names.is_empty(), "the OS always ships system fonts");
        assert!(names.iter().all(|name| !name.is_empty()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strips_registry_type_suffixes() {
        assert_eq!(strip_font_type_suffix("Arial (TrueType)"), "Arial");
        assert_eq!(strip_font_type_suffix("Segoe UI (OpenType)"), "Segoe UI");
        assert_eq!(
            strip_font_type_suffix("Courier 10,12,15 (VGA res)"),
            "Courier 10,12,15"
        );
        // No suffix: the name passes through untouched.
        assert_eq!(strip_font_type_suffix("Marlett"), "Marlett");
    }
}
