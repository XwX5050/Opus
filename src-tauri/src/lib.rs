pub mod document_commands;
pub mod document_io;
pub mod open_events;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Emitter;
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            document_commands::open_document,
            document_commands::save_document
        ])
        .setup(|app| {
            let initial = open_events::normalize_open_paths(std::env::args().skip(1));
            if !initial.is_empty() {
                app.emit("open-paths", initial)?;
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = open_events::normalize_open_paths(urls.iter().map(tauri::Url::as_str));
            if !paths.is_empty() {
                let _ = handle.emit("open-paths", paths);
            }
        }
    });
}
