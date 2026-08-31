use markdown_edit_lib::document_commands::rename_document_impl;

fn populated_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), b"alpha\n").unwrap();
    std::fs::write(dir.path().join("b.md"), b"beta\n").unwrap();
    std::fs::write(dir.path().join("c.markdown"), b"gamma\n").unwrap();
    std::fs::write(dir.path().join("draft.txt"), b"txt").unwrap();
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    dir
}

#[test]
fn rename_document_renames_in_place_and_returns_the_new_path() {
    let dir = populated_dir();
    let path = dir.path().join("a.md");
    let original = std::fs::read(&path).unwrap();

    let renamed = rename_document_impl(path.clone(), "renamed".into()).unwrap();

    assert_eq!(renamed, dir.path().join("renamed.md").to_string_lossy());
    assert!(!path.exists());
    assert_eq!(
        std::fs::read(dir.path().join("renamed.md")).unwrap(),
        original
    );
}

#[test]
fn rename_document_keeps_the_original_markdown_extension() {
    let dir = populated_dir();
    let path = dir.path().join("c.markdown");

    let renamed = rename_document_impl(path.clone(), "renamed".into()).unwrap();

    assert_eq!(
        renamed,
        dir.path().join("renamed.markdown").to_string_lossy()
    );
    assert!(!path.exists());
    assert_eq!(
        std::fs::read(dir.path().join("renamed.markdown")).unwrap(),
        b"gamma\n"
    );
}

#[test]
fn rename_document_to_the_same_name_succeeds_as_a_no_op() {
    let dir = populated_dir();
    let path = dir.path().join("a.md");

    let renamed = rename_document_impl(path.clone(), "a".into()).unwrap();

    assert_eq!(renamed, path.to_string_lossy());
    assert_eq!(std::fs::read(&path).unwrap(), b"alpha\n");
}

#[test]
fn rename_document_rejects_a_target_that_already_exists() {
    let dir = populated_dir();
    let path = dir.path().join("a.md");

    let error = rename_document_impl(path.clone(), "b".into()).unwrap_err();

    assert_eq!(error.code, "conflict");
    assert!(path.exists());
    assert_eq!(std::fs::read(dir.path().join("b.md")).unwrap(), b"beta\n");
}

#[test]
fn rename_document_rejects_a_target_colliding_with_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), b"alpha\n").unwrap();
    std::fs::create_dir_all(dir.path().join("sub.md")).unwrap();
    let path = dir.path().join("a.md");

    let error = rename_document_impl(path.clone(), "sub".into()).unwrap_err();

    assert_eq!(error.code, "conflict");
    assert!(path.exists());
}

#[test]
fn rename_document_rejects_non_markdown_paths() {
    let dir = populated_dir();
    let txt = dir.path().join("draft.txt");

    let error = rename_document_impl(txt.clone(), "renamed".into()).unwrap_err();

    assert_eq!(error.code, "io");
    assert!(txt.exists());
}

#[test]
fn rename_document_rejects_missing_paths() {
    let dir = populated_dir();
    let missing = dir.path().join("ghost.md");

    let error = rename_document_impl(missing.clone(), "renamed".into()).unwrap_err();

    assert_eq!(error.code, "not_found");
}

#[test]
fn rename_document_rejects_directories() {
    let dir = populated_dir();
    let directory = dir.path().join("sub");

    let error = rename_document_impl(directory.clone(), "renamed".into()).unwrap_err();

    assert_eq!(error.code, "io");
    assert!(directory.is_dir());
}

#[test]
fn rename_document_rejects_relative_paths() {
    let dir = populated_dir();
    let error = rename_document_impl("a.md".into(), "renamed".into()).unwrap_err();
    assert_eq!(error.code, "io");
    // The relative path was never touched.
    assert!(!dir.path().join("renamed.md").exists());
}

#[test]
fn rename_document_rejects_empty_and_separator_carrying_names() {
    let dir = populated_dir();
    let path = dir.path().join("a.md");

    assert_eq!(
        rename_document_impl(path.clone(), "".into())
            .unwrap_err()
            .code,
        "io"
    );
    assert_eq!(
        rename_document_impl(path.clone(), "nested/name".into())
            .unwrap_err()
            .code,
        "io"
    );
    assert!(path.exists());
}

#[test]
fn rename_document_rejects_hidden_names() {
    let dir = populated_dir();
    let path = dir.path().join("a.md");

    let error = rename_document_impl(path.clone(), ".hidden".into()).unwrap_err();

    assert_eq!(error.code, "io");
    assert!(path.exists());
    assert!(!dir.path().join(".hidden.md").exists());
}
