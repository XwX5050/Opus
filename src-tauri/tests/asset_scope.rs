use std::path::Path;

use markdown_edit_lib::asset_scope::AssetScopeRegistry;

#[test]
fn shared_parent_scope_is_removed_only_after_last_tab_closes() {
    let mut scopes = AssetScopeRegistry::default();
    scopes
        .acquire_document("tab-a", Path::new("/notes/a.md"))
        .unwrap();
    scopes
        .acquire_document("tab-b", Path::new("/notes/b.md"))
        .unwrap();
    scopes.release_consumer("tab-a").unwrap();
    assert!(scopes.allows(Path::new("/notes/image.png")));
    scopes.release_consumer("tab-b").unwrap();
    assert!(!scopes.allows(Path::new("/notes/image.png")));
}

#[test]
fn opening_a_document_allows_only_its_parent_directory() {
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes");
    let nested = notes.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let document = notes.join("a.md");
    std::fs::write(&document, b"# A\n").unwrap();
    let image = notes.join("image.png");
    let nested_image = nested.join("image.png");
    std::fs::write(&image, b"png").unwrap();
    std::fs::write(&nested_image, b"png").unwrap();

    let mut scopes = AssetScopeRegistry::default();
    scopes.acquire_document("tab-a", &document).unwrap();

    assert!(scopes.allows(&image));
    assert!(!scopes.allows(&nested_image));
    assert!(!scopes.allows(dir.path().join("other.png")));
}

#[test]
fn a_workspace_grants_recursive_access_only_inside_its_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    let deep = root.join("a").join("b");
    std::fs::create_dir_all(&deep).unwrap();
    let inside = deep.join("image.png");
    let outside = dir.path().join("outside.png");
    std::fs::write(&inside, b"png").unwrap();
    std::fs::write(&outside, b"png").unwrap();

    let mut scopes = AssetScopeRegistry::default();
    scopes.acquire_workspace("workspace-1", &root).unwrap();

    assert!(scopes.allows(&inside));
    assert!(!scopes.allows(&outside));

    scopes.release_consumer("workspace-1").unwrap();
    assert!(!scopes.allows(&inside));
}

#[test]
fn releasing_an_unknown_consumer_is_an_error() {
    let mut scopes = AssetScopeRegistry::default();
    assert!(scopes.release_consumer("missing").is_err());
}

#[test]
fn non_absolute_paths_are_rejected() {
    let mut scopes = AssetScopeRegistry::default();
    assert!(scopes
        .acquire_document("tab-a", Path::new("notes/a.md"))
        .is_err());
    assert!(scopes.acquire_workspace("ws", Path::new("notes")).is_err());
}

#[test]
fn dot_dot_escapes_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    let document = notes.join("a.md");
    std::fs::write(&document, b"# A\n").unwrap();
    let outside = dir.path().join("secret.png");
    std::fs::write(&outside, b"png").unwrap();

    let mut scopes = AssetScopeRegistry::default();
    scopes.acquire_document("tab-a", &document).unwrap();

    // An existing path whose `..` is resolved by canonicalization.
    assert!(!scopes.allows(notes.join("..").join("secret.png")));
    // A non-existent path that only lexical normalization can contain.
    assert!(!scopes.allows(notes.join("..").join("..").join("etc").join("passwd")));
    assert!(!scopes.allows(Path::new("/notes/../etc/passwd")));
}

#[cfg(unix)]
#[test]
fn symlink_escapes_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    let document = notes.join("a.md");
    std::fs::write(&document, b"# A\n").unwrap();
    let outside = dir.path().join("secret.png");
    std::fs::write(&outside, b"png").unwrap();
    std::os::unix::fs::symlink(&outside, notes.join("link.png")).unwrap();
    std::os::unix::fs::symlink(dir.path(), notes.join("dir-link")).unwrap();

    let mut scopes = AssetScopeRegistry::default();
    scopes.acquire_document("tab-a", &document).unwrap();

    assert!(!scopes.allows(notes.join("link.png")));
    assert!(!scopes.allows(notes.join("dir-link").join("secret.png")));
}

#[test]
fn capabilities_default_json_has_no_home_or_whole_filesystem_glob() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json");
    let text = std::fs::read_to_string(&path).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let serialized = serde_json::to_string(&json).unwrap();
    assert!(
        !serialized.contains("**"),
        "whole-tree glob found: {serialized}"
    );
    assert!(
        !serialized.contains("$HOME"),
        "home directory scope found: {serialized}"
    );
    assert!(
        !serialized.contains("assetProtocol"),
        "static asset scope found: {serialized}"
    );
}

#[test]
fn tauri_conf_asset_protocol_scope_is_empty() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let text = std::fs::read_to_string(&path).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let scope = &json["app"]["security"]["assetProtocol"]["scope"];
    assert_eq!(*scope, serde_json::json!([]));
}
