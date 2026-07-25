pub mod asset_scope;
pub mod document_commands;
pub mod document_io;
pub mod open_events;
pub mod perf_mark;
pub mod recovery;
pub mod watch;
pub mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use std::sync::{Arc, Mutex};
    use tauri::{Emitter, Listener, Manager};
    let open_queue = Arc::new(Mutex::new(open_events::OpenPathQueue::default()));
    let setup_queue = Arc::clone(&open_queue);
    let run_queue = Arc::clone(&open_queue);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(document_commands::SharedAssetScopes::default())
        .invoke_handler(tauri::generate_handler![
            document_commands::open_document,
            document_commands::save_document,
            document_commands::save_clipboard_image,
            document_commands::acquire_document_scope,
            document_commands::acquire_workspace_scope,
            document_commands::release_asset_scope,
            document_commands::choose_workspace,
            document_commands::open_workspace,
            document_commands::list_directory,
            document_commands::create_markdown_file,
            document_commands::rename_entry,
            document_commands::trash_entry,
            document_commands::watch_document,
            document_commands::watch_workspace,
            document_commands::unwatch,
            document_commands::write_recovery_draft,
            document_commands::list_recovery_drafts,
            document_commands::read_recovery_draft,
            document_commands::discard_recovery_draft,
            perf_mark::perf_mark_editor_editable
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
            let disk_handle = app.handle().clone();
            app.manage(document_commands::SharedWatchService::new(watch::WatchService::new(
                watch::DEFAULT_DEBOUNCE_WINDOW,
                move |event| {
                    let _ = disk_handle.emit("document-disk-event", &event);
                },
            )));
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
            event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }),
            ..
        } = event
        {
            // Tauri 2 with the default `dragDropEnabled: true` delivers drops
            // only through this native event (the webview never sees HTML5
            // drops, and DOM File objects would carry no real paths anyway).
            // Image files are emitted for in-place insertion into the active
            // editor; everything else keeps the open-as-document behavior.
            let (images, documents) = open_events::partition_dropped_paths(paths);
            if !images.is_empty() {
                let _ = handle.emit(
                    "image-files-dropped",
                    open_events::ImageDropPayload {
                        paths: images,
                        x: position.x,
                        y: position.y,
                    },
                );
            }
            if let Some(payload) = run_queue
                .lock()
                .expect("open path queue poisoned")
                .enqueue(documents)
            {
                let _ = handle.emit("open-paths", payload);
            }
        }
    });
}
