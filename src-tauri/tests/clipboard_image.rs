use markdown_edit_lib::document_commands::save_clipboard_image_impl;

#[test]
fn clipboard_image_is_written_to_a_validated_png_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image.png");

    save_clipboard_image_impl(path.clone(), &[137, 80, 78, 71], "image/png").unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), vec![137, 80, 78, 71]);
}

#[test]
fn clipboard_image_accepts_jpg_and_jpeg_extensions_for_jpeg_bytes() {
    let dir = tempfile::tempdir().unwrap();

    save_clipboard_image_impl(dir.path().join("a.jpg"), &[255, 216], "image/jpeg").unwrap();
    save_clipboard_image_impl(dir.path().join("b.jpeg"), &[255, 216], "image/jpeg").unwrap();

    assert_eq!(std::fs::read(dir.path().join("a.jpg")).unwrap(), vec![255, 216]);
    assert_eq!(std::fs::read(dir.path().join("b.jpeg")).unwrap(), vec![255, 216]);
}

#[test]
fn clipboard_image_rejects_relative_paths() {
    let result = save_clipboard_image_impl("notes/image.png".into(), &[1], "image/png");
    assert!(result.is_err());
}

#[test]
fn clipboard_image_rejects_extension_and_mime_mismatches_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let gif = dir.path().join("image.gif");
    let mislabeled = dir.path().join("image.png");

    assert!(save_clipboard_image_impl(gif.clone(), &[1], "image/png").is_err());
    assert!(save_clipboard_image_impl(mislabeled.clone(), &[1], "image/gif").is_err());
    assert!(save_clipboard_image_impl(mislabeled.clone(), &[1], "image/jpeg").is_err());
    assert!(!gif.exists());
    assert!(!mislabeled.exists());
}

#[test]
fn clipboard_image_rejects_empty_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image.png");

    assert!(save_clipboard_image_impl(path.clone(), &[], "image/png").is_err());
    assert!(!path.exists());
}

#[test]
fn clipboard_image_reports_a_missing_parent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing").join("image.png");

    assert!(save_clipboard_image_impl(path, &[1], "image/png").is_err());
}
