use crate::asset_scope::{AcquiredScope, AssetScopeError, AssetScopeRegistry};
use crate::document_io::{self, DocumentIoError, Newline};
use crate::recovery::{DraftInfo, DraftRecord, RecoveryError, RecoveryStore};
use crate::watch::{WatchError, WatchService};
use crate::workspace::{self, DirectoryEntry, WorkspaceError, WorkspaceRootInfo};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

pub type SharedAssetScopes = Mutex<AssetScopeRegistry>;
pub type SharedWatchService = Mutex<WatchService>;

/// The canonical root of the single workspace opened through `open_workspace`.
/// Workspace commands reject any root that does not match this anchor, so an
/// injected renderer can never steer the backend into an arbitrary directory
/// (e.g. "/") it did not first open through the workspace flow.
pub type SharedWorkspaceAnchor = Mutex<Option<PathBuf>>;

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}
#[derive(Debug, Serialize)]
pub struct OpenedDocumentDto {
    pub path: PathBuf,
    pub text: String,
    pub has_utf8_bom: bool,
    pub newline: Newline,
    pub modified_unix_ms: u128,
    pub version: String,
}
#[derive(Debug, Deserialize)]
pub struct SaveDocumentRequest {
    pub request_id: String,
    pub document_id: String,
    pub target_path: PathBuf,
    pub text: String,
    pub has_utf8_bom: bool,
    pub newline: Newline,
    pub expected_version: Option<String>,
    pub path_platform: String,
}
#[derive(Debug, Serialize)]
pub struct SavedDocumentDto {
    pub path: PathBuf,
    pub modified_unix_ms: u128,
    pub version: String,
}

fn validate(path: &Path) -> Result<(), CommandError> {
    if !path.is_absolute() {
        return Err(CommandError {
            code: "io".into(),
            message: "path must be absolute".into(),
        });
    }
    let markdown = path
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| x.eq_ignore_ascii_case("md") || x.eq_ignore_ascii_case("markdown"));
    if !markdown {
        return Err(CommandError {
            code: "io".into(),
            message: "path must have a .md or .markdown extension".into(),
        });
    }
    if let Ok(metadata) = std::fs::metadata(path) {
        if !metadata.is_file() {
            return Err(CommandError {
                code: "io".into(),
                message: "path must identify a regular file".into(),
            });
        }
    }
    Ok(())
}
fn map_error(error: DocumentIoError) -> CommandError {
    let code = match &error {
        DocumentIoError::InvalidUtf8 { .. } => "invalid_utf8",
        DocumentIoError::NotFound { .. } => "not_found",
        DocumentIoError::PermissionDenied { .. } => "permission_denied",
        DocumentIoError::Conflict { .. } => "conflict",
        _ => "io",
    };
    CommandError {
        code: code.into(),
        message: error.to_string(),
    }
}
pub fn open_document_impl(path: PathBuf) -> Result<OpenedDocumentDto, CommandError> {
    validate(&path)?;
    let d = document_io::read_document(&path).map_err(map_error)?;
    // Return the canonical path: watch keys and disk-event paths are
    // canonicalized (watch.rs `resolve`), so a tab opened through a symlinked
    // directory (macOS /tmp -> /private/tmp) must carry the canonical path or
    // disk events would never match it. Canonicalization cannot fail for a
    // file that was just read, but fall back to the input path defensively.
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    Ok(OpenedDocumentDto {
        path,
        text: d.text,
        has_utf8_bom: d.has_utf8_bom,
        newline: d.newline,
        modified_unix_ms: d.modified_unix_ms,
        version: d.version,
    })
}
pub fn save_document_impl(request: SaveDocumentRequest) -> Result<SavedDocumentDto, CommandError> {
    validate(&request.target_path)?;
    let path = request.target_path;
    let (modified_unix_ms, version) = document_io::write_document_checked(
        &path,
        &request.text,
        request.has_utf8_bom,
        request.newline,
        request.expected_version.as_deref(),
    )
    .map_err(map_error)?;
    Ok(SavedDocumentDto {
        path,
        modified_unix_ms,
        version,
    })
}
#[tauri::command]
pub fn open_document(path: PathBuf) -> Result<OpenedDocumentDto, CommandError> {
    open_document_impl(path)
}
#[tauri::command]
pub fn save_document(request: SaveDocumentRequest) -> Result<SavedDocumentDto, CommandError> {
    save_document_impl(request)
}

fn validate_image(path: &Path, bytes: &[u8], mime_type: &str) -> Result<(), CommandError> {
    if !path.is_absolute() {
        return Err(CommandError {
            code: "io".into(),
            message: "path must be absolute".into(),
        });
    }
    let extension = path.extension().and_then(|x| x.to_str()).unwrap_or("");
    let matches_mime = match mime_type {
        "image/png" => extension.eq_ignore_ascii_case("png"),
        "image/jpeg" => {
            extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg")
        }
        _ => false,
    };
    if !matches_mime {
        return Err(CommandError {
            code: "io".into(),
            message: "path extension must match the clipboard image type".into(),
        });
    }
    if bytes.is_empty() {
        return Err(CommandError {
            code: "io".into(),
            message: "clipboard image is empty".into(),
        });
    }
    if let Ok(metadata) = std::fs::metadata(path) {
        if !metadata.is_file() {
            return Err(CommandError {
                code: "io".into(),
                message: "path must identify a regular file".into(),
            });
        }
    }
    Ok(())
}

pub fn save_clipboard_image_impl(
    path: PathBuf,
    bytes: &[u8],
    mime_type: &str,
) -> Result<(), CommandError> {
    validate_image(&path, bytes, mime_type)?;
    document_io::write_image_bytes(&path, bytes).map_err(map_error)
}

#[tauri::command]
pub fn save_clipboard_image(
    path: PathBuf,
    bytes: Vec<u8>,
    mime_type: String,
) -> Result<(), CommandError> {
    save_clipboard_image_impl(path, &bytes, &mime_type)
}

fn map_scope_error(error: AssetScopeError) -> CommandError {
    CommandError {
        code: "io".into(),
        message: error.to_string(),
    }
}

/// Mirrors a newly acquired registry root into Tauri's asset protocol
/// scope. Tauri 2.11's runtime scope is additive-only, so releases only
/// update the registry, which stays the authoritative record.
fn allow_in_asset_scope<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    acquired: &crate::asset_scope::AcquiredScope,
) -> Result<(), CommandError> {
    if !acquired.newly_added {
        return Ok(());
    }
    app.asset_protocol_scope()
        .allow_directory(&acquired.root, acquired.recursive)
        .map_err(|error| CommandError {
            code: "io".into(),
            message: error.to_string(),
        })
}

#[tauri::command]
pub fn acquire_document_scope(
    app: tauri::AppHandle,
    scopes: tauri::State<'_, SharedAssetScopes>,
    consumer_id: String,
    path: PathBuf,
) -> Result<(), CommandError> {
    acquire_scoped(
        &scopes,
        &consumer_id,
        |registry| registry.acquire_document(&consumer_id, &path),
        |acquired| allow_in_asset_scope(&app, acquired),
    )
}

#[tauri::command]
pub fn acquire_workspace_scope(
    anchor: tauri::State<'_, SharedWorkspaceAnchor>,
    app: tauri::AppHandle,
    scopes: tauri::State<'_, SharedAssetScopes>,
    consumer_id: String,
    root: PathBuf,
) -> Result<(), CommandError> {
    assert_workspace_anchored(&anchor, &root)?;
    acquire_scoped(
        &scopes,
        &consumer_id,
        |registry| registry.acquire_workspace(&consumer_id, &root),
        |acquired| allow_in_asset_scope(&app, acquired),
    )
}

/// Acquires a registry scope and mirrors it into the asset protocol scope.
/// When the mirroring fails, the registry reference is released again so a
/// failed acquire can never leak a consumer reference.
pub fn acquire_scoped(
    scopes: &SharedAssetScopes,
    consumer_id: &str,
    acquire: impl FnOnce(&mut AssetScopeRegistry) -> Result<AcquiredScope, AssetScopeError>,
    mirror: impl FnOnce(&AcquiredScope) -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    let acquired = acquire(&mut scopes.lock().expect("asset scope registry poisoned"))
        .map_err(map_scope_error)?;
    if let Err(error) = mirror(&acquired) {
        let _ = scopes
            .lock()
            .expect("asset scope registry poisoned")
            .release_consumer(consumer_id);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn release_asset_scope(
    scopes: tauri::State<'_, SharedAssetScopes>,
    consumer_id: String,
) -> Result<(), CommandError> {
    scopes
        .lock()
        .expect("asset scope registry poisoned")
        .release_consumer(&consumer_id)
        .map_err(map_scope_error)
}

fn map_workspace_error(error: WorkspaceError) -> CommandError {
    let code = match &error {
        WorkspaceError::NotFound { .. } | WorkspaceError::NotADirectory { .. } => "not_found",
        WorkspaceError::OutsideRoot { .. } => "permission_denied",
        WorkspaceError::AlreadyExists { .. } => "conflict",
        _ => "io",
    };
    CommandError {
        code: code.into(),
        message: error.to_string(),
    }
}

/// Every workspace command runs against the anchored root only: the root must
/// equal the canonical path stored by `open_workspace`, otherwise the command
/// is rejected. Nothing is anchored until a workspace is opened, so commands
/// issued before `open_workspace` fail closed.
fn assert_workspace_anchored(
    anchor: &SharedWorkspaceAnchor,
    root: &Path,
) -> Result<(), CommandError> {
    let anchored = anchor.lock().expect("workspace anchor poisoned");
    let matches = anchored
        .as_ref()
        .is_some_and(|anchored| anchored.as_path() == root);
    if !matches {
        return Err(CommandError {
            code: "permission_denied".into(),
            message: "path is outside the open workspace".into(),
        });
    }
    Ok(())
}

pub fn open_workspace_impl(
    anchor: &SharedWorkspaceAnchor,
    root: PathBuf,
) -> Result<WorkspaceRootInfo, CommandError> {
    let info = workspace::open_workspace(&root).map_err(map_workspace_error)?;
    *anchor.lock().expect("workspace anchor poisoned") = Some(info.path.clone());
    Ok(info)
}

/// Closes the workspace: no workspace command is accepted until the next
/// `open_workspace`. Idempotent, so closing an already-closed workspace is a
/// no-op.
pub fn close_workspace_impl(anchor: &SharedWorkspaceAnchor) {
    *anchor.lock().expect("workspace anchor poisoned") = None;
}

#[tauri::command]
pub fn open_workspace(
    anchor: tauri::State<'_, SharedWorkspaceAnchor>,
    root: PathBuf,
) -> Result<WorkspaceRootInfo, CommandError> {
    open_workspace_impl(&anchor, root)
}

#[tauri::command]
pub fn close_workspace(anchor: tauri::State<'_, SharedWorkspaceAnchor>) {
    close_workspace_impl(&anchor);
}

pub fn list_directory_impl(
    anchor: &SharedWorkspaceAnchor,
    root: PathBuf,
    relative: PathBuf,
) -> Result<Vec<DirectoryEntry>, CommandError> {
    assert_workspace_anchored(anchor, &root)?;
    workspace::list_directory(&root, &relative).map_err(map_workspace_error)
}

#[tauri::command]
pub fn list_directory(
    anchor: tauri::State<'_, SharedWorkspaceAnchor>,
    root: PathBuf,
    relative: PathBuf,
) -> Result<Vec<DirectoryEntry>, CommandError> {
    list_directory_impl(&anchor, root, relative)
}

pub fn create_markdown_file_impl(
    anchor: &SharedWorkspaceAnchor,
    root: PathBuf,
    relative: PathBuf,
) -> Result<DirectoryEntry, CommandError> {
    assert_workspace_anchored(anchor, &root)?;
    workspace::create_markdown_file(&root, &relative).map_err(map_workspace_error)
}

#[tauri::command]
pub fn create_markdown_file(
    anchor: tauri::State<'_, SharedWorkspaceAnchor>,
    root: PathBuf,
    relative: PathBuf,
) -> Result<DirectoryEntry, CommandError> {
    create_markdown_file_impl(&anchor, root, relative)
}

pub fn rename_entry_impl(
    anchor: &SharedWorkspaceAnchor,
    root: PathBuf,
    from: PathBuf,
    to_name: String,
) -> Result<DirectoryEntry, CommandError> {
    assert_workspace_anchored(anchor, &root)?;
    workspace::rename_entry(&root, &from, &to_name).map_err(map_workspace_error)
}

#[tauri::command]
pub fn rename_entry(
    anchor: tauri::State<'_, SharedWorkspaceAnchor>,
    root: PathBuf,
    from: PathBuf,
    to_name: String,
) -> Result<DirectoryEntry, CommandError> {
    rename_entry_impl(&anchor, root, from, to_name)
}

pub fn trash_entry_impl(
    anchor: &SharedWorkspaceAnchor,
    root: PathBuf,
    relative: PathBuf,
) -> Result<(), CommandError> {
    assert_workspace_anchored(anchor, &root)?;
    workspace::trash_entry(&root, &relative).map_err(map_workspace_error)
}

#[tauri::command]
pub fn trash_entry(
    anchor: tauri::State<'_, SharedWorkspaceAnchor>,
    root: PathBuf,
    relative: PathBuf,
) -> Result<(), CommandError> {
    trash_entry_impl(&anchor, root, relative)
}

fn map_watch_error(error: WatchError) -> CommandError {
    CommandError {
        code: "io".into(),
        message: error.to_string(),
    }
}

#[tauri::command]
pub fn watch_document(
    service: tauri::State<'_, SharedWatchService>,
    consumer_id: String,
    path: PathBuf,
) -> Result<(), CommandError> {
    service
        .lock()
        .expect("watch service poisoned")
        .watch_document(&consumer_id, &path)
        .map_err(map_watch_error)
}

#[tauri::command]
pub fn watch_workspace(
    anchor: tauri::State<'_, SharedWorkspaceAnchor>,
    service: tauri::State<'_, SharedWatchService>,
    consumer_id: String,
    root: PathBuf,
) -> Result<(), CommandError> {
    assert_workspace_anchored(&anchor, &root)?;
    service
        .lock()
        .expect("watch service poisoned")
        .watch_workspace(&consumer_id, &root)
        .map_err(map_watch_error)
}

#[tauri::command]
pub fn unwatch(
    service: tauri::State<'_, SharedWatchService>,
    consumer_id: String,
) -> Result<(), CommandError> {
    service
        .lock()
        .expect("watch service poisoned")
        .unwatch(&consumer_id)
        .map_err(map_watch_error)
}

#[derive(Debug, Deserialize)]
pub struct WriteDraftRequest {
    pub draft_id: String,
    pub original_path: Option<PathBuf>,
    pub title: String,
    pub text: String,
    pub has_utf8_bom: bool,
    pub newline: Newline,
    pub saved_text_hash: String,
    pub saved_version: Option<String>,
}

fn map_recovery_error(error: RecoveryError) -> CommandError {
    let code = match &error {
        RecoveryError::NotFound { .. } => "not_found",
        _ => "io",
    };
    CommandError {
        code: code.into(),
        message: error.to_string(),
    }
}

fn recovery_store(app: &tauri::AppHandle) -> Result<RecoveryStore, CommandError> {
    let data_dir = app.path().app_data_dir().map_err(|error| CommandError {
        code: "io".into(),
        message: error.to_string(),
    })?;
    Ok(RecoveryStore::new(data_dir.join("recovery")))
}

#[tauri::command]
pub fn write_recovery_draft(
    app: tauri::AppHandle,
    request: WriteDraftRequest,
) -> Result<DraftInfo, CommandError> {
    let draft = DraftRecord {
        draft_id: request.draft_id,
        original_path: request.original_path,
        title: request.title,
        text: request.text,
        has_utf8_bom: request.has_utf8_bom,
        newline: request.newline,
        saved_text_hash: request.saved_text_hash,
        saved_version: request.saved_version,
    };
    recovery_store(&app)?
        .write_draft(&draft)
        .map_err(map_recovery_error)
}

#[tauri::command]
pub fn list_recovery_drafts(app: tauri::AppHandle) -> Result<Vec<DraftInfo>, CommandError> {
    recovery_store(&app)?
        .list_drafts()
        .map_err(map_recovery_error)
}

#[tauri::command]
pub fn read_recovery_draft(
    app: tauri::AppHandle,
    draft_id: String,
) -> Result<DraftRecord, CommandError> {
    recovery_store(&app)?
        .read_draft(&draft_id)
        .map_err(map_recovery_error)
}

#[tauri::command]
pub fn discard_recovery_draft(app: tauri::AppHandle, draft_id: String) -> Result<(), CommandError> {
    recovery_store(&app)?
        .discard_draft(&draft_id)
        .map_err(map_recovery_error)
}
