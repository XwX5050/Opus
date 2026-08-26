//! Linux session environment normalization, applied before any GTK/WebKit
//! initialization so the app runs natively on Wayland with software rendering.
//!
//! Two environment variables matter and both are read by GTK/WKWebView inside
//! the Tauri builder (GTK reads `GDK_BACKEND` at `gtk_init`, WKWebView reads
//! `WEBKIT_DISABLE_DMABUF_RENDERER` when it creates its backend), so this
//! module must run at the very top of `run()`, ahead of `tauri::Builder`.
//!
//! - **AppImage `GDK_BACKEND=x11` hook.** The linuxdeploy GTK hook shipped in
//!   Tauri's generated AppImage appends `export GDK_BACKEND=x11` to
//!   `apprun-hooks/linuxdeploy-plugin-gtk.sh`, unconditionally forcing X11. On
//!   a Wayland session (e.g. niri) that routes the app through XWayland, where
//!   pointer grabs during drags break: motion/up events are lost mid-drag, so
//!   the sidebar resize freeze-locks and the app becomes unusable. Overriding
//!   the hook with `GDK_BACKEND=wayland,x11` lets GTK open a real Wayland
//!   connection (falling back to X11 only if Wayland is unavailable — e.g. a
//!   stripped AppImage with no Wayland backend), which restores the native grab
//!   path and fixes the freeze.
//! - **NVIDIA/GBM blank webview.** `WEBKIT_DISABLE_DMABUF_RENDERER=1` forces
//!   WebKitGTK onto its software renderer; the DMA-BUF path on NVIDIA/GBM is
//!   broken and produces fully blank webview windows (a text editor has no
//!   need of the hardware path).

/// Returns the `GDK_BACKEND` value to set, or `None` to leave it untouched.
///
/// - `force_x11` (`OPUS_FORCE_X11`) disables all `GDK_BACKEND` changes.
/// - A user-provided custom backend (anything other than unset or `x11`) is
///   respected unchanged.
/// - Otherwise, on a Wayland session (`WAYLAND_DISPLAY` set), a `GDK_BACKEND`
///   of unset or `x11` (the AppImage hook's value) is upgraded to the
///   `wayland,x11` fallback string.
pub fn decide_gdk_backend(
    current: Option<&str>,
    wayland_display: Option<&str>,
    force_x11: bool,
) -> Option<&'static str> {
    if force_x11 {
        return None;
    }
    let is_wayland_session = wayland_display.is_some();
    let is_forced_x11 = current == Some("x11");
    let is_unset = current.is_none();
    if is_wayland_session && (is_unset || is_forced_x11) {
        Some("wayland,x11")
    } else {
        None
    }
}

/// Returns the value to set for `WEBKIT_DISABLE_DMABUF_RENDERER`, or `None` to
/// leave it untouched. We only default it to `1` when it is unset so a user who
/// explicitly sets a value (e.g. `0` to re-enable the DMA-BUF path) is honored.
fn decide_dmabuf(current: Option<&str>) -> Option<&'static str> {
    if current.is_none() {
        Some("1")
    } else {
        None
    }
}

/// Applies the Linux session environment defaults. No-op on non-Linux targets.
#[cfg(target_os = "linux")]
pub fn apply() {
    let force_x11 = std::env::var_os("OPUS_FORCE_X11").is_some();
    let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
    let wayland_display = wayland_display.as_deref().map(|s| s.to_str().unwrap_or(""));
    if let Some(backend) = decide_gdk_backend(
        std::env::var("GDK_BACKEND").ok().as_deref(),
        wayland_display,
        force_x11,
    ) {
        // SAFETY: `apply()` is a one-shot at process start, before any threads
        // that call `env` are spawned, so the mutation is not concurrently
        // observable.
        unsafe { std::env::set_var("GDK_BACKEND", backend) };
    }
    if let Some(value) = decide_dmabuf(
        std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .ok()
            .as_deref(),
    ) {
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", value) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_op_on_x11_session() {
        // X11 session with no GDK_BACKEND: nothing to change.
        assert_eq!(decide_gdk_backend(None, None, false), None);
    }

    #[test]
    fn no_op_when_off_wayland_but_gdk_backend_is_x11() {
        // An explicit `x11` on a non-Wayland session is a deliberate choice.
        assert_eq!(decide_gdk_backend(Some("x11"), None, false), None);
    }

    #[test]
    fn upgrade_unset_gdk_backend_under_wayland() {
        assert_eq!(
            decide_gdk_backend(None, Some("wayland-1"), false),
            Some("wayland,x11")
        );
    }

    #[test]
    fn upgrade_forced_x11_gdk_backend_under_wayland() {
        // The AppImage hook forces `x11`; on Wayland we want the fallback string.
        assert_eq!(
            decide_gdk_backend(Some("x11"), Some("wayland-1"), false),
            Some("wayland,x11")
        );
    }

    #[test]
    fn respects_user_custom_gdk_backend() {
        assert_eq!(
            decide_gdk_backend(Some("wayland"), Some("wayland-1"), false),
            None
        );
        assert_eq!(
            decide_gdk_backend(Some("broadway"), Some("wayland-1"), false),
            None
        );
    }

    #[test]
    fn respects_force_x11_escape_hatch() {
        assert_eq!(decide_gdk_backend(None, Some("wayland-1"), true), None);
        assert_eq!(
            decide_gdk_backend(Some("x11"), Some("wayland-1"), true),
            None
        );
        assert_eq!(
            decide_gdk_backend(Some("wayland"), Some("wayland-1"), true),
            None
        );
    }

    #[test]
    fn dmabuf_defaults_only_when_unset() {
        assert_eq!(decide_dmabuf(None), Some("1"));
        assert_eq!(decide_dmabuf(Some("0")), None);
        assert_eq!(decide_dmabuf(Some("1")), None);
    }
}
