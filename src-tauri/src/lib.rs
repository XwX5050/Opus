pub mod document_commands;
pub mod document_io;
pub mod open_events;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use std::sync::{Arc, Mutex};
    use tauri::{Emitter, Listener};
    let open_queue = Arc::new(Mutex::new(open_events::OpenPathQueue::default()));
    let setup_queue = Arc::clone(&open_queue);
    let run_queue = Arc::clone(&open_queue);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            document_commands::open_document,
            document_commands::save_document
        ])
        .setup(move |app| {
            let initial = open_events::normalize_open_paths(std::env::args().skip(1));
            setup_queue
                .lock()
                .expect("open path queue poisoned")
                .enqueue(initial);
            let ready_queue = Arc::clone(&setup_queue);
            let handle = app.handle().clone();
            app.listen("frontend-ready", move |_| {
                if let Some(payload) = ready_queue
                    .lock()
                    .expect("open path queue poisoned")
                    .ready()
                {
                    let _ = handle.emit("open-paths", payload);
                }
            });
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
    app.run(move |handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { ref urls } = event {
            let paths = open_events::normalize_open_paths(urls.iter().map(tauri::Url::as_str));
            if let Some(payload) = run_queue
                .lock()
                .expect("open path queue poisoned")
                .enqueue(paths)
            {
                let _ = handle.emit("open-paths", payload);
            }
        }
        if let tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
            ..
        } = event
        {
            if let Some(payload) = run_queue
                .lock()
                .expect("open path queue poisoned")
                .enqueue(paths)
            {
                let _ = handle.emit("open-paths", payload);
            }
        }
    });
}
