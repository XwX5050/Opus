//! Perf harness hook (scripts/measure-startup.mjs).
//!
//! When the app is launched with the `MARKDOWN_EDIT_PERF_MARK` environment
//! variable set to a file path, the frontend reports the moment the editor
//! first becomes editable and this command appends the current UNIX
//! timestamp (milliseconds) to that file. The harness compares the
//! timestamp against its own spawn timestamp to compute
//! process-to-editable latency. Without the variable the command is a
//! no-op, so production behavior is untouched.

use std::io::Write;

#[tauri::command]
pub fn perf_mark_editor_editable() {
    let Ok(path) = std::env::var("MARKDOWN_EDIT_PERF_MARK") else {
        return;
    };
    if path.is_empty() {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{now}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn writes_timestamp_only_when_mark_path_is_set() {
        // No-op without the variable (must not panic, must not write).
        std::env::remove_var("MARKDOWN_EDIT_PERF_MARK");
        super::perf_mark_editor_editable();

        let dir = std::env::temp_dir().join(format!("perf-mark-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mark.txt");
        std::env::set_var("MARKDOWN_EDIT_PERF_MARK", &file);
        super::perf_mark_editor_editable();
        std::env::remove_var("MARKDOWN_EDIT_PERF_MARK");

        let content = std::fs::read_to_string(&file).unwrap();
        let timestamp: u128 = content.trim().parse().unwrap();
        assert!(timestamp > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
