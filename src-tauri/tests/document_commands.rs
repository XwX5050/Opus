use markdown_edit_lib::document_commands::{
    open_document_impl, save_document_impl, SaveDocumentRequest,
};
use markdown_edit_lib::document_io::Newline;

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
