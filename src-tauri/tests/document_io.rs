use std::os::unix::{fs::symlink, fs::PermissionsExt};

use markdown_edit_lib::document_io::{read_document, write_document, DocumentIoError, Newline};

#[test]
fn document_io_reads_utf8_bom_and_crlf_without_normalizing_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    std::fs::write(&path, b"\xEF\xBB\xBF# A\r\nB\r\n").unwrap();

    let opened = read_document(&path).unwrap();

    assert_eq!(opened.text, "# A\r\nB\r\n");
    assert!(opened.has_utf8_bom);
    assert_eq!(opened.newline, Newline::CrLf);
}

#[test]
fn document_io_write_preserves_requested_bom_and_newlines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");

    write_document(&path, "a\nb\n", true, Newline::CrLf).unwrap();

    assert_eq!(std::fs::read(path).unwrap(), b"\xEF\xBB\xBFa\r\nb\r\n");
}

#[test]
fn document_io_reads_lf_without_bom() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    std::fs::write(&path, b"# A\nB\n").unwrap();

    let opened = read_document(&path).unwrap();

    assert_eq!(opened.text, "# A\nB\n");
    assert!(!opened.has_utf8_bom);
    assert_eq!(opened.newline, Newline::Lf);
}

#[test]
fn document_io_defaults_to_lf_when_text_has_no_newline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    let bytes = b"# A";
    std::fs::write(&path, bytes).unwrap();

    let opened = read_document(&path).unwrap();

    assert_eq!(opened.text.as_bytes(), bytes);
    assert_eq!(opened.newline, Newline::Lf);
}

#[test]
fn document_io_detects_the_dominant_style_in_mixed_newlines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    let bytes = b"a\r\nb\nc\n";
    std::fs::write(&path, bytes).unwrap();

    let opened = read_document(&path).unwrap();

    assert_eq!(opened.text.as_bytes(), bytes);
    assert_eq!(opened.newline, Newline::Lf);
}

#[test]
fn document_io_resolves_a_mixed_newline_tie_using_the_first_style() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    let bytes = b"a\nb\r\n";
    std::fs::write(&path, bytes).unwrap();

    let opened = read_document(&path).unwrap();

    assert_eq!(opened.text.as_bytes(), bytes);
    assert_eq!(opened.newline, Newline::Lf);
}

#[test]
fn document_io_writing_crlf_never_doubles_existing_carriage_returns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");

    write_document(&path, "a\r\nb\n", false, Newline::CrLf).unwrap();

    assert_eq!(std::fs::read(path).unwrap(), b"a\r\nb\r\n");
}

#[test]
fn document_io_writing_crlf_preserves_a_literal_carriage_return_before_a_newline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");

    write_document(&path, "a\r\r\nb", false, Newline::CrLf).unwrap();

    assert_eq!(std::fs::read(path).unwrap(), b"a\r\r\nb");
}

#[test]
fn document_io_writing_lf_normalizes_input_crlf_to_lf() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");

    write_document(&path, "a\r\nb\n", false, Newline::Lf).unwrap();

    assert_eq!(std::fs::read(path).unwrap(), b"a\nb\n");
}

#[test]
fn document_io_rejects_invalid_utf8_without_modifying_existing_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    let bytes = b"\xFFinvalid";
    std::fs::write(&path, bytes).unwrap();

    assert!(matches!(
        read_document(&path),
        Err(DocumentIoError::InvalidUtf8 { .. })
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn document_io_reads_a_missing_file_as_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.md");

    assert!(matches!(
        read_document(&path),
        Err(DocumentIoError::NotFound { .. })
    ));
}

#[test]
fn document_io_write_reports_a_missing_parent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing").join("note.md");

    assert!(matches!(
        write_document(&path, "text", false, Newline::Lf),
        Err(DocumentIoError::MissingParent { .. })
    ));
}

#[test]
fn document_io_write_to_read_only_target_keeps_bytes_and_cleans_up_temp_siblings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    let bytes = b"original\n";
    std::fs::write(&path, bytes).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();

    assert!(matches!(
        write_document(&path, "replacement\n", false, Newline::Lf),
        Err(DocumentIoError::PermissionDenied { .. })
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(directory_entry_names(dir.path()), vec!["note.md"]);
}

#[test]
fn document_io_writing_a_symlink_updates_its_target_without_replacing_the_link() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.md");
    let link = dir.path().join("note.md");
    std::fs::write(&target, b"original\n").unwrap();
    symlink("target.md", &link).unwrap();

    write_document(&link, "replacement\n", false, Newline::Lf).unwrap();

    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(target).unwrap(), b"replacement\n");
}

#[test]
fn document_io_write_preserves_existing_target_permissions_and_reports_metadata_time() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    std::fs::write(&path, b"original\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();

    let modified_unix_ms = write_document(&path, "replacement\n", false, Newline::Lf).unwrap();

    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert_eq!(
        read_document(&path).unwrap().modified_unix_ms,
        modified_unix_ms
    );
    assert_eq!(directory_entry_names(dir.path()), vec!["note.md"]);
}

#[test]
fn document_io_cleans_up_temporary_sibling_after_rename_to_a_directory_fails() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("destination");
    std::fs::create_dir(&path).unwrap();

    assert!(matches!(
        write_document(&path, "replacement\n", false, Newline::Lf),
        Err(DocumentIoError::Io { .. })
    ));
    assert!(path.is_dir());
    assert_eq!(directory_entry_names(dir.path()), vec!["destination"]);
}

fn directory_entry_names(path: &std::path::Path) -> Vec<String> {
    let mut names = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    names
}
