use markdown_edit_lib::document_io::Newline;
use markdown_edit_lib::recovery::{DraftRecord, RecoveryStore};
use std::path::PathBuf;

fn draft(id: &str, path: Option<PathBuf>, text: &str) -> DraftRecord {
    DraftRecord {
        draft_id: id.into(),
        original_path: path,
        title: format!("title-{id}"),
        text: text.into(),
        has_utf8_bom: true,
        newline: Newline::CrLf,
        saved_text_hash: format!("hash-{id}"),
        saved_version: Some(format!("version-{id}")),
    }
}

#[test]
fn drafts_round_trip_through_write_list_and_read() {
    let dir = tempfile::tempdir().unwrap();
    let store = RecoveryStore::new(dir.path().join("recovery"));
    let original = dir.path().join("notes").join("a.md");
    let record = draft("document-1", Some(original), "dirty text");

    let info = store.write_draft(&record).unwrap();
    assert_eq!(info.draft_id, "document-1");
    assert_eq!(info.saved_text_hash, "hash-document-1");
    assert!(info.updated_unix_ms > 0);

    let listed = store.list_drafts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].draft_id, "document-1");
    assert_eq!(listed[0].title, "title-document-1");

    let read = store.read_draft("document-1").unwrap();
    assert_eq!(read, record);
}

#[test]
fn drafts_live_under_the_store_directory_and_never_touch_original_documents() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("notes").join("a.md");
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::write(&original, "on disk").unwrap();

    let store = RecoveryStore::new(dir.path().join("recovery"));
    store
        .write_draft(&draft(
            "document-1",
            Some(original.clone()),
            "unsaved edits",
        ))
        .unwrap();

    assert_eq!(std::fs::read(&original).unwrap(), b"on disk");
    let stored = store.dir().join("document-1.json");
    assert!(stored.is_file());
    let bytes = std::fs::read(&stored).unwrap();
    assert!(String::from_utf8(bytes).unwrap().contains("unsaved edits"));
}

#[test]
fn writes_are_atomic_and_leave_no_temp_files_behind() {
    let dir = tempfile::tempdir().unwrap();
    let store = RecoveryStore::new(dir.path().join("recovery"));
    store
        .write_draft(&draft("document-1", None, "one"))
        .unwrap();
    store
        .write_draft(&draft("document-2", None, "two"))
        .unwrap();

    let mut names: Vec<_> = std::fs::read_dir(store.dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, vec!["document-1.json", "document-2.json"]);
}

#[test]
fn updating_a_draft_replaces_it_and_keeps_a_single_listing() {
    let dir = tempfile::tempdir().unwrap();
    let store = RecoveryStore::new(dir.path().join("recovery"));
    store
        .write_draft(&draft("document-1", None, "first"))
        .unwrap();
    store
        .write_draft(&draft("document-1", None, "second"))
        .unwrap();

    assert_eq!(store.list_drafts().unwrap().len(), 1);
    assert_eq!(store.read_draft("document-1").unwrap().text, "second");
}

#[test]
fn a_fresh_store_on_the_same_directory_lists_drafts_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let recovery_dir = dir.path().join("recovery");
    let first = RecoveryStore::new(recovery_dir.clone());
    first
        .write_draft(&draft("document-1", None, "one"))
        .unwrap();
    first
        .write_draft(&draft("document-2", None, "two"))
        .unwrap();
    first.discard_draft("document-1").unwrap();
    drop(first);

    let restarted = RecoveryStore::new(recovery_dir);
    let listed = restarted.list_drafts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].draft_id, "document-2");
}

#[test]
fn discarding_an_unknown_draft_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let store = RecoveryStore::new(dir.path().join("recovery"));
    let error = store.discard_draft("nope").unwrap_err();
    assert!(matches!(
        error,
        markdown_edit_lib::recovery::RecoveryError::NotFound { .. }
    ));
}

#[test]
fn invalid_draft_ids_are_rejected_before_any_write() {
    let dir = tempfile::tempdir().unwrap();
    let store = RecoveryStore::new(dir.path().join("recovery"));
    for id in ["", "../evil", "a/b", "a\\b", ".hidden", "id with space"] {
        let record = draft(id, None, "x");
        assert!(
            store.write_draft(&record).is_err(),
            "id {id:?} must be rejected"
        );
    }
    assert!(!store.dir().exists() || store.list_drafts().unwrap().is_empty());
}

#[test]
fn corrupt_files_are_skipped_in_listings_but_reported_on_read() {
    let dir = tempfile::tempdir().unwrap();
    let recovery_dir = dir.path().join("recovery");
    let store = RecoveryStore::new(recovery_dir.clone());
    store
        .write_draft(&draft("document-1", None, "good"))
        .unwrap();
    std::fs::create_dir_all(&recovery_dir).unwrap();
    std::fs::write(recovery_dir.join("broken.json"), b"{not json").unwrap();
    std::fs::write(recovery_dir.join("notes.txt"), b"unrelated").unwrap();

    let listed = store.list_drafts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].draft_id, "document-1");

    let error = store.read_draft("broken").unwrap_err();
    assert!(matches!(
        error,
        markdown_edit_lib::recovery::RecoveryError::Corrupt { .. }
    ));
}

#[test]
fn unsaved_documents_round_trip_with_a_null_original_path() {
    let dir = tempfile::tempdir().unwrap();
    let store = RecoveryStore::new(dir.path().join("recovery"));
    let record = draft("document-7", None, "brand new");
    store.write_draft(&record).unwrap();

    let read = store.read_draft("document-7").unwrap();
    assert_eq!(read, record);
    assert_eq!(read.original_path, None);
}

#[test]
fn listing_an_empty_or_missing_store_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let store = RecoveryStore::new(dir.path().join("recovery"));
    assert!(store.list_drafts().unwrap().is_empty());
}
