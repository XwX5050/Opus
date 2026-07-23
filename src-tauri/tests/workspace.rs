use std::path::{Path, PathBuf};

use markdown_edit_lib::workspace::{
    create_markdown_file, list_directory, open_workspace, rename_entry, trash_entry,
    DirectoryEntry, WorkspaceError,
};

fn entry_names(entries: &[DirectoryEntry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.name.as_str()).collect()
}

fn is_outside_root(error: &WorkspaceError) -> bool {
    matches!(error, WorkspaceError::OutsideRoot { .. })
}

fn populated_root() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir_all(root.join("notes").join("deep")).unwrap();
    std::fs::create_dir_all(root.join("archive")).unwrap();
    std::fs::write(root.join("b.md"), b"b").unwrap();
    std::fs::write(root.join("a.markdown"), b"a").unwrap();
    std::fs::write(root.join("notes").join("inner.md"), b"inner").unwrap();
    std::fs::write(root.join("notes").join("deep").join("leaf.md"), b"leaf").unwrap();
    std::fs::write(root.join("draft.txt"), b"txt").unwrap();
    std::fs::write(root.join("image.png"), b"png").unwrap();
    std::fs::write(root.join(".hidden.md"), b"hidden").unwrap();
    std::fs::create_dir_all(root.join(".hidden-dir")).unwrap();
    (dir, root)
}

#[test]
fn open_workspace_returns_canonical_root_and_directory_title() {
    let (_dir, root) = populated_root();
    let info = open_workspace(&root).unwrap();
    assert_eq!(info.path, std::fs::canonicalize(&root).unwrap());
    assert_eq!(info.title, "workspace");
}

#[test]
fn open_workspace_rejects_files_and_missing_paths() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.md");
    std::fs::write(&file, b"a").unwrap();
    assert!(open_workspace(&file).is_err());
    assert!(open_workspace(&dir.path().join("missing")).is_err());
}

#[test]
fn list_directory_is_lazy_sorted_directories_first_and_filters_entries() {
    let (_dir, root) = populated_root();
    let entries = list_directory(&root, Path::new("")).unwrap();

    // Lazy: files inside subdirectories are not listed at the top level.
    assert_eq!(entry_names(&entries), ["archive", "notes", "a.markdown", "b.md"]);
    assert!(entries[0].is_directory && entries[1].is_directory);
    assert!(!entries[2].is_directory && !entries[3].is_directory);

    let nested = list_directory(&root, Path::new("notes")).unwrap();
    assert_eq!(entry_names(&nested), ["deep", "inner.md"]);
}

#[test]
fn list_directory_rejects_escapes_outside_the_root() {
    let (_dir, root) = populated_root();
    assert!(is_outside_root(
        &list_directory(&root, Path::new("..")).unwrap_err()
    ));
    assert!(is_outside_root(
        &list_directory(&root, Path::new("notes/../../..")).unwrap_err()
    ));
    assert!(is_outside_root(
        &list_directory(&root, Path::new("/etc")).unwrap_err()
    ));
}

#[cfg(unix)]
#[test]
fn symlink_loops_are_followed_without_hanging_and_escape_links_are_rejected() {
    use std::os::unix::fs::symlink;
    let (_dir, root) = populated_root();
    // A loop back into the root stays inside after canonicalization.
    symlink(&root, root.join("notes").join("loop")).unwrap();
    // A link pointing outside the root must be rejected when traversed.
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.md"), b"secret").unwrap();
    symlink(outside.path(), root.join("escape")).unwrap();

    let notes = list_directory(&root, Path::new("notes")).unwrap();
    assert_eq!(entry_names(&notes), ["deep", "loop", "inner.md"]);

    let through_loop = list_directory(&root, Path::new("notes/loop/notes")).unwrap();
    assert_eq!(entry_names(&through_loop), ["deep", "loop", "inner.md"]);

    assert!(is_outside_root(
        &list_directory(&root, Path::new("escape")).unwrap_err()
    ));
}

#[test]
fn create_markdown_file_creates_an_empty_file_inside_the_root() {
    let (_dir, root) = populated_root();
    let created = create_markdown_file(&root, Path::new("notes/new.md")).unwrap();

    assert_eq!(created.name, "new.md");
    assert!(!created.is_directory);
    assert_eq!(std::fs::read(&created.path).unwrap(), b"");
    let notes_entries = list_directory(&root, Path::new("notes")).unwrap();
    let names = entry_names(&notes_entries);
    assert!(names.contains(&"new.md"));
}

#[test]
fn create_markdown_file_rejects_conflicts_non_markdown_and_escapes() {
    let (_dir, root) = populated_root();
    assert!(matches!(
        create_markdown_file(&root, Path::new("b.md")).unwrap_err(),
        WorkspaceError::AlreadyExists { .. }
    ));
    assert!(matches!(
        create_markdown_file(&root, Path::new("notes/new.txt")).unwrap_err(),
        WorkspaceError::NotMarkdown { .. }
    ));
    assert!(is_outside_root(
        &create_markdown_file(&root, Path::new("../outside.md")).unwrap_err()
    ));
    // A symlinked parent directory pointing outside the root is an escape too.
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
        assert!(is_outside_root(
            &create_markdown_file(&root, Path::new("linked/escape.md")).unwrap_err()
        ));
        assert!(!outside.path().join("escape.md").exists());
    }
}

#[test]
fn rename_entry_renames_in_place_and_reports_the_new_entry() {
    let (_dir, root) = populated_root();
    let renamed = rename_entry(&root, Path::new("b.md"), "renamed.md").unwrap();

    assert_eq!(renamed.name, "renamed.md");
    assert!(!root.join("b.md").exists());
    assert_eq!(std::fs::read(root.join("b.md").with_file_name("renamed.md")).unwrap(), b"b");

    let renamed_dir = rename_entry(&root, Path::new("archive"), "archive-2").unwrap();
    assert!(renamed_dir.is_directory);
    assert!(root.join("archive-2").is_dir());
}

#[test]
fn rename_entry_rejects_conflicts_non_markdown_names_and_escapes() {
    let (dir, root) = populated_root();
    let outside = dir.path().join("escape.md");
    std::fs::write(&outside, b"outside").unwrap();
    assert!(matches!(
        rename_entry(&root, Path::new("a.markdown"), "b.md").unwrap_err(),
        WorkspaceError::AlreadyExists { .. }
    ));
    assert!(matches!(
        rename_entry(&root, Path::new("b.md"), "b.txt").unwrap_err(),
        WorkspaceError::NotMarkdown { .. }
    ));
    assert!(matches!(
        rename_entry(&root, Path::new("b.md"), "nested/b.md").unwrap_err(),
        WorkspaceError::InvalidName { .. }
    ));
    assert!(matches!(
        rename_entry(&root, Path::new("b.md"), ".hidden.md").unwrap_err(),
        WorkspaceError::InvalidName { .. }
    ));
    assert!(is_outside_root(
        &rename_entry(&root, Path::new("../escape.md"), "x.md").unwrap_err()
    ));
    // Nothing was renamed by the rejected attempts.
    assert!(root.join("b.md").exists());
    assert!(root.join("a.markdown").exists());
    assert!(outside.exists());
}

#[test]
fn trash_entry_moves_a_file_to_the_system_trash() {
    let (_dir, root) = populated_root();
    let target = root.join("b.md");
    trash_entry(&root, Path::new("b.md")).unwrap();

    assert!(!target.exists());
    let remaining = list_directory(&root, Path::new("")).unwrap();
    let names = entry_names(&remaining);
    assert!(!names.contains(&"b.md"));
}

#[test]
fn trash_entry_rejects_escapes_and_the_root_itself_without_deleting() {
    let (_dir, root) = populated_root();
    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("keep.md");
    std::fs::write(&outside_file, b"keep").unwrap();

    assert!(is_outside_root(
        &trash_entry(&root, Path::new("..")).unwrap_err()
    ));
    assert!(is_outside_root(
        &trash_entry(&root, Path::new("")).unwrap_err()
    ));
    assert!(is_outside_root(
        &trash_entry(&root, Path::new("notes/../../..")).unwrap_err()
    ));
    assert!(root.exists());
    assert!(outside_file.exists());
}

#[cfg(unix)]
#[test]
fn trash_entry_on_an_in_root_symlink_trashes_the_link_not_the_target() {
    use std::os::unix::fs::symlink;
    let (_dir, root) = populated_root();
    symlink(root.join("b.md"), root.join("notes").join("alias.md")).unwrap();

    trash_entry(&root, Path::new("notes/alias.md")).unwrap();

    assert!(std::fs::symlink_metadata(root.join("notes").join("alias.md")).is_err());
    assert_eq!(std::fs::read(root.join("b.md")).unwrap(), b"b");
}

#[cfg(unix)]
#[test]
fn rename_entry_on_an_in_root_symlink_renames_the_link_not_the_target() {
    use std::os::unix::fs::symlink;
    let (_dir, root) = populated_root();
    symlink(root.join("b.md"), root.join("alias.md")).unwrap();

    let renamed = rename_entry(&root, Path::new("alias.md"), "renamed.md").unwrap();

    assert_eq!(renamed.name, "renamed.md");
    assert!(std::fs::symlink_metadata(root.join("alias.md")).is_err());
    assert_eq!(
        std::fs::read_link(root.join("renamed.md")).unwrap(),
        root.join("b.md")
    );
    assert_eq!(std::fs::read(root.join("b.md")).unwrap(), b"b");
}

#[cfg(unix)]
#[test]
fn trash_and_rename_reject_symlinks_escaping_the_root() {
    use std::os::unix::fs::symlink;
    let (_dir, root) = populated_root();
    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("keep.md");
    std::fs::write(&outside_file, b"keep").unwrap();
    symlink(&outside_file, root.join("escape.md")).unwrap();

    assert!(is_outside_root(
        &trash_entry(&root, Path::new("escape.md")).unwrap_err()
    ));
    assert!(is_outside_root(
        &rename_entry(&root, Path::new("escape.md"), "x.md").unwrap_err()
    ));
    assert!(root.join("escape.md").exists());
    assert_eq!(std::fs::read(&outside_file).unwrap(), b"keep");
}

#[test]
fn rename_entry_to_the_same_name_succeeds_as_a_no_op() {
    let (_dir, root) = populated_root();

    let renamed = rename_entry(&root, Path::new("b.md"), "b.md").unwrap();

    assert_eq!(renamed.name, "b.md");
    assert_eq!(std::fs::read(root.join("b.md")).unwrap(), b"b");
}

#[cfg(unix)]
#[test]
fn create_markdown_file_never_writes_through_a_symlink() {
    use std::os::unix::fs::symlink;
    let (_dir, root) = populated_root();
    let outside = tempfile::tempdir().unwrap();
    // A dangling symlink inside the root points at a would-be outside file.
    symlink(outside.path().join("ghost.md"), root.join("ghost.md")).unwrap();

    assert!(matches!(
        create_markdown_file(&root, Path::new("ghost.md")).unwrap_err(),
        WorkspaceError::AlreadyExists { .. }
    ));
    assert!(!outside.path().join("ghost.md").exists());
}
