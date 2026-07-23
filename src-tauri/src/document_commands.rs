use crate::asset_scope::{AcquiredScope, AssetScopeError, AssetScopeRegistry};
use crate::document_io::{self, DocumentIoError, Newline};
use crate::workspace::{self, DirectoryEntry, WorkspaceError, WorkspaceRootInfo};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub type SharedAssetScopes = Mutex<AssetScopeRegistry>;

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
        "image/jpeg" => extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg"),
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
    app: tauri::AppHandle,
    scopes: tauri::State<'_, SharedAssetScopes>,
    consumer_id: String,
    root: PathBuf,
) -> Result<(), CommandError> {
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

pub fn open_workspace_impl(root: PathBuf) -> Result<WorkspaceRootInfo, CommandError> {
    workspace::open_workspace(&root).map_err(map_workspace_error)
}

#[tauri::command]
pub fn open_workspace(root: PathBuf) -> Result<WorkspaceRootInfo, CommandError> {
    open_workspace_impl(root)
}

#[tauri::command]
pub fn choose_workspace(app: tauri::AppHandle) -> Result<Option<WorkspaceRootInfo>, CommandError> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|error| CommandError {
        code: "io".into(),
        message: error.to_string(),
    })?;
    open_workspace_impl(path).map(Some)
}

pub fn list_directory_impl(
    root: PathBuf,
    relative: PathBuf,
) -> Result<Vec<DirectoryEntry>, CommandError> {
    workspace::list_directory(&root, &relative).map_err(map_workspace_error)
}

#[tauri::command]
pub fn list_directory(
    root: PathBuf,
    relative: PathBuf,
) -> Result<Vec<DirectoryEntry>, CommandError> {
    list_directory_impl(root, relative)
}

#[tauri::command]
pub fn create_markdown_file(
    root: PathBuf,
    relative: PathBuf,
) -> Result<DirectoryEntry, CommandError> {
    workspace::create_markdown_file(&root, &relative).map_err(map_workspace_error)
}

#[tauri::command]
pub fn rename_entry(
    root: PathBuf,
    from: PathBuf,
    to_name: String,
) -> Result<DirectoryEntry, CommandError> {
    workspace::rename_entry(&root, &from, &to_name).map_err(map_workspace_error)
}

#[tauri::command]
pub fn trash_entry(root: PathBuf, relative: PathBuf) -> Result<(), CommandError> {
    workspace::trash_entry(&root, &relative).map_err(map_workspace_error)
}
