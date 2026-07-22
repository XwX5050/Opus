use crate::document_io::{self, DocumentIoError, Newline};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
        DocumentIoError::Io { source, .. }
            if source.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            "conflict"
        }
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
