use markdown_edit_lib::asset_scope::AssetScopeRegistry;
use markdown_edit_lib::document_commands::{
    acquire_scoped, open_document_impl, save_document_impl, CommandError, SaveDocumentRequest,
    SharedAssetScopes,
};
use markdown_edit_lib::document_io::Newline;

#[test]
fn failed_asset_scope_mirroring_releases_the_registry_reference() {
    let scopes = SharedAssetScopes::new(AssetScopeRegistry::default());
    let result = acquire_scoped(
        &scopes,
        "tab-a",
        |registry| registry.acquire_document("tab-a", std::path::Path::new("/notes/a.md")),
        |_acquired| {
            Err(CommandError {
                code: "io".into(),
                message: "asset scope mirroring failed".into(),
            })
        },
    );

    assert_eq!(result.unwrap_err().message, "asset scope mirroring failed");
    let registry = scopes.lock().unwrap();
    assert!(!registry.allows(std::path::Path::new("/notes/image.png")));
    drop(registry);
    // The compensating release removed the consumer, so a later acquire for
    // the same id reports the scope as newly added instead of double-counting.
    let acquired = acquire_scoped(
        &scopes,
        "tab-a",
        |registry| registry.acquire_document("tab-a", std::path::Path::new("/notes/a.md")),
        |_acquired| Ok(()),
    );
    assert!(acquired.is_ok());
}

#[test]
fn version_changes_when_equal_length_bytes_change_even_with_same_mtime_millis() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.md");
    std::fs::write(&path, b"one").unwrap();
    let first = open_document_impl(path.clone()).unwrap();
    std::fs::write(&path, b"two").unwrap();
    let second = open_document_impl(path).unwrap();
    assert_ne!(first.version, second.version);
}

#[test]
fn save_rejects_stale_version_without_replacing_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.md");
    std::fs::write(&path, b"old").unwrap();
    let request = SaveDocumentRequest {
        request_id: "r".into(),
        document_id: "d".into(),
        target_path: path.clone(),
        text: "new".into(),
        has_utf8_bom: false,
        newline: Newline::Lf,
        expected_version: Some("stale".into()),
        path_platform: "macos".into(),
    };
    assert_eq!(save_document_impl(request).unwrap_err().code, "conflict");
    assert_eq!(std::fs::read(path).unwrap(), b"old");
}

#[test]
fn new_target_does_not_overwrite_an_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.md");
    std::fs::write(&path, b"old").unwrap();
    let request = SaveDocumentRequest {
        request_id: "r".into(),
        document_id: "d".into(),
        target_path: path.clone(),
        text: "new".into(),
        has_utf8_bom: false,
        newline: Newline::Lf,
        expected_version: None,
        path_platform: "macos".into(),
    };
    assert_eq!(save_document_impl(request).unwrap_err().code, "conflict");
    assert_eq!(std::fs::read(path).unwrap(), b"old");
}

#[test]
fn rejects_relative_and_non_markdown_paths() {
    assert_eq!(open_document_impl("a.md".into()).unwrap_err().code, "io");
    assert_eq!(
        open_document_impl("/tmp/a.txt".into()).unwrap_err().code,
        "io"
    );
}

#[test]
fn valid_open_and_current_version_save_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.md");
    std::fs::write(&path, b"old\n").unwrap();
    let opened = open_document_impl(path.clone()).unwrap();
    assert_eq!(opened.text, "old\n");
    assert!(opened.version.starts_with("sha256:"));
    let saved = save_document_impl(SaveDocumentRequest {
        request_id: "r".into(),
        document_id: "d".into(),
        target_path: path.clone(),
        text: "new\n".into(),
        has_utf8_bom: false,
        newline: Newline::Lf,
        expected_version: Some(opened.version),
        path_platform: "macos".into(),
    })
    .unwrap();
    assert_eq!(saved.path, path);
    assert_eq!(std::fs::read(&saved.path).unwrap(), b"new\n");
    assert_eq!(
        saved.version,
        open_document_impl(saved.path.clone()).unwrap().version
    );
}

#[test]
fn replacing_a_file_with_same_content_changes_version_and_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.md");
    let replacement = dir.path().join("replacement.md");
    std::fs::write(&path, b"same").unwrap();
    let opened = open_document_impl(path.clone()).unwrap();
    std::fs::write(&replacement, b"same").unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    assert_ne!(
        opened.version,
        open_document_impl(path.clone()).unwrap().version
    );
    let error = save_document_impl(SaveDocumentRequest {
        request_id: "r".into(),
        document_id: "d".into(),
        target_path: path,
        text: "ours".into(),
        has_utf8_bom: false,
        newline: Newline::Lf,
        expected_version: Some(opened.version),
        path_platform: "macos".into(),
    })
    .unwrap_err();
    assert_eq!(error.code, "conflict");
}

#[cfg(unix)]
#[test]
fn symlink_open_and_save_checks_and_updates_target_without_replacing_link() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.md");
    let link = dir.path().join("link.md");
    std::fs::write(&target, b"old").unwrap();
    symlink(&target, &link).unwrap();
    let opened = open_document_impl(link.clone()).unwrap();
    save_document_impl(SaveDocumentRequest {
        request_id: "r".into(),
        document_id: "d".into(),
        target_path: link.clone(),
        text: "new".into(),
        has_utf8_bom: false,
        newline: Newline::Lf,
        expected_version: Some(opened.version),
        path_platform: "macos".into(),
    })
    .unwrap();
    assert!(std::fs::symlink_metadata(link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(target).unwrap(), b"new");
}

#[cfg(unix)]
#[test]
fn symlink_retarget_to_same_content_changes_version_and_conflicts() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.md");
    let second = dir.path().join("second.md");
    let link = dir.path().join("link.md");
    std::fs::write(&first, b"same").unwrap();
    std::fs::write(&second, b"same").unwrap();
    symlink(&first, &link).unwrap();
    let opened = open_document_impl(link.clone()).unwrap();
    std::fs::remove_file(&link).unwrap();
    symlink(&second, &link).unwrap();
    assert_ne!(
        opened.version,
        open_document_impl(link.clone()).unwrap().version
    );
    let error = save_document_impl(SaveDocumentRequest {
        request_id: "r".into(),
        document_id: "d".into(),
        target_path: link,
        text: "ours".into(),
        has_utf8_bom: false,
        newline: Newline::Lf,
        expected_version: Some(opened.version),
        path_platform: "macos".into(),
    })
    .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(std::fs::read(second).unwrap(), b"same");
}

#[test]
fn new_target_saves_successfully() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new.md");
    save_document_impl(SaveDocumentRequest {
        request_id: "r".into(),
        document_id: "d".into(),
        target_path: path.clone(),
        text: "new".into(),
        has_utf8_bom: false,
        newline: Newline::Lf,
        expected_version: None,
        path_platform: "macos".into(),
    })
    .unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"new");
}
