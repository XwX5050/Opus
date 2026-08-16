//! Crash-recovery draft storage.
//!
//! Dirty document snapshots live as one JSON file per draft inside the
//! recovery directory (the app's data directory in production, an arbitrary
//! directory in tests). Writes reuse the sibling-temp + rename discipline
//! from `document_io` and, like the document write path, synchronize the
//! directory itself so the rename is durable. Draft files are the only files the store
//! ever writes; original documents are never touched.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::document_io::Newline;

/// A full dirty-document snapshot. `saved_text_hash` and `saved_version`
/// are opaque tokens supplied by the caller (derived from the last clean
/// document version) so the frontend can tell whether the draft diverges
/// from what is on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftRecord {
    pub draft_id: String,
    pub original_path: Option<PathBuf>,
    pub title: String,
    pub text: String,
    pub has_utf8_bom: bool,
    pub newline: Newline,
    pub saved_text_hash: String,
    pub saved_version: Option<String>,
}

/// Draft metadata for restart listings; deliberately excludes `text` so
/// listing many drafts stays cheap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DraftInfo {
    pub draft_id: String,
    pub original_path: Option<PathBuf>,
    pub title: String,
    pub saved_text_hash: String,
    pub saved_version: Option<String>,
    pub updated_unix_ms: u128,
}

/// The on-disk shape used by `list_drafts`. Mirrors `DraftRecord`'s fields
/// but decodes `text` as `IgnoredAny`, so a listing never materializes the
/// body — that is what keeps many-draft listings cheap even though each file
/// carries the full text. `has_utf8_bom`/`newline` stay required, so a record
/// missing them is still treated as corrupt exactly like a full read.
#[derive(Deserialize)]
// Fields `text`/`has_utf8_bom`/`newline` are consumed by serde alone (they
// are decoded to validate the record shape, never read); the listed metadata
// is the only part surfaced to callers.
#[allow(dead_code)]
struct StoredDraftInfo {
    draft_id: String,
    original_path: Option<PathBuf>,
    title: String,
    text: serde::de::IgnoredAny,
    has_utf8_bom: bool,
    newline: Newline,
    saved_text_hash: String,
    saved_version: Option<String>,
}

#[derive(Debug)]
pub enum RecoveryError {
    InvalidDraftId { draft_id: String },
    NotFound { draft_id: String },
    Corrupt { path: PathBuf, message: String },
    Io { path: PathBuf, source: io::Error },
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDraftId { draft_id } => {
                write!(formatter, "invalid draft id: {draft_id:?}")
            }
            Self::NotFound { draft_id } => write!(formatter, "no recovery draft: {draft_id}"),
            Self::Corrupt { path, message } => {
                write!(
                    formatter,
                    "corrupt recovery draft {}: {message}",
                    path.display()
                )
            }
            Self::Io { path, source } => {
                write!(formatter, "I/O error for {}: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for RecoveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Draft ids become file names, so they are restricted to a small safe
/// alphabet (document ids like `document-3` fit); anything else is rejected
/// instead of sanitized, keeping the mapping bidirectional and obvious.
fn validate_draft_id(draft_id: &str) -> Result<(), RecoveryError> {
    let valid = !draft_id.is_empty()
        && draft_id.len() <= 128
        && draft_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(RecoveryError::InvalidDraftId {
            draft_id: draft_id.to_string(),
        })
    }
}

pub struct RecoveryStore {
    dir: PathBuf,
}

impl RecoveryStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn draft_path(&self, draft_id: &str) -> PathBuf {
        self.dir.join(format!("{draft_id}.json"))
    }

    /// Stores or replaces a draft atomically: write a sibling temp file,
    /// fsync it, rename over the destination, then fsync the directory so
    /// the rename itself is durable.
    pub fn write_draft(&self, draft: &DraftRecord) -> Result<DraftInfo, RecoveryError> {
        validate_draft_id(&draft.draft_id)?;
        fs::create_dir_all(&self.dir).map_err(|error| RecoveryError::Io {
            path: self.dir.clone(),
            source: error,
        })?;
        let payload = serde_json::to_vec(draft).map_err(|error| RecoveryError::Io {
            path: self.draft_path(&draft.draft_id),
            source: io::Error::new(io::ErrorKind::InvalidData, error),
        })?;
        let destination = self.draft_path(&draft.draft_id);
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.dir).map_err(|error| RecoveryError::Io {
                path: destination.clone(),
                source: error,
            })?;
        temporary
            .write_all(&payload)
            .and_then(|()| temporary.as_file().sync_all())
            .map_err(|error| RecoveryError::Io {
                path: destination.clone(),
                source: error,
            })?;
        temporary
            .persist(&destination)
            .map_err(|error| RecoveryError::Io {
                path: destination.clone(),
                source: error.error,
            })?;
        sync_directory(&self.dir)?;
        let metadata = fs::metadata(&destination).map_err(|error| RecoveryError::Io {
            path: destination.clone(),
            source: error,
        })?;
        Ok(draft_info(
            draft,
            modified_unix_ms(&metadata, &destination)?,
        ))
    }

    /// Lists all drafts, oldest information first by draft id for a
    /// deterministic order. Listings decode metadata only — the stored `text`
    /// is skipped — so listing many drafts stays cheap. Corrupt files are
    /// skipped (and logged) rather than failing the whole listing, so one bad
    /// write at crash time can never block recovery of the remaining drafts.
    /// Leftover temp files from a crash between write and rename are removed
    /// as a side effect so they do not accumulate.
    pub fn list_drafts(&self) -> Result<Vec<DraftInfo>, RecoveryError> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(RecoveryError::Io {
                    path: self.dir.clone(),
                    source: error,
                })
            }
        };
        let mut drafts = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| RecoveryError::Io {
                path: self.dir.clone(),
                source: error,
            })?;
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                // A crash between temp creation and rename leaves a
                // tempfile-shaped file behind; remove those (and nothing
                // else) so they do not accumulate on disk.
                if is_orphaned_temp_file(&path)
                    && entry.file_type().is_ok_and(|kind| kind.is_file())
                {
                    if let Err(error) = fs::remove_file(&path) {
                        log::warn!(
                            "failed to remove orphaned recovery temp {}: {error}",
                            path.display()
                        );
                    }
                }
                continue;
            }
            match read_stored_info(&path) {
                Ok(info) => {
                    let modified = entry
                        .metadata()
                        .ok()
                        .and_then(|metadata| modified_unix_ms(&metadata, &path).ok())
                        .unwrap_or(0);
                    drafts.push(draft_info_from_stored(&info, modified));
                }
                Err(error) => log::warn!("skipping {error}"),
            }
        }
        drafts.sort_by(|a, b| a.draft_id.cmp(&b.draft_id));
        Ok(drafts)
    }

    pub fn read_draft(&self, draft_id: &str) -> Result<DraftRecord, RecoveryError> {
        validate_draft_id(draft_id)?;
        read_stored(&self.draft_path(draft_id))
    }

    /// Removes a draft after a successful save+close (or an explicit
    /// user discard) and fsyncs the directory so the removal is durable.
    pub fn discard_draft(&self, draft_id: &str) -> Result<(), RecoveryError> {
        validate_draft_id(draft_id)?;
        let path = self.draft_path(draft_id);
        match fs::remove_file(&path) {
            Ok(()) => sync_directory(&self.dir),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(RecoveryError::NotFound {
                draft_id: draft_id.to_string(),
            }),
            Err(error) => Err(RecoveryError::Io {
                path,
                source: error,
            }),
        }
    }
}

fn read_stored(path: &Path) -> Result<DraftRecord, RecoveryError> {
    read_stored_any(path)
}

fn read_stored_info(path: &Path) -> Result<StoredDraftInfo, RecoveryError> {
    read_stored_any(path)
}

/// Reads and decodes a stored draft into any deserializable shape, mapping
/// filesystem and JSON failures onto `RecoveryError` the same way for both
/// the full-record and the metadata-only read paths.
fn read_stored_any<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, RecoveryError> {
    let bytes = fs::read(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            RecoveryError::NotFound {
                draft_id: draft_id_from_path(path),
            }
        } else {
            RecoveryError::Io {
                path: path.to_path_buf(),
                source: error,
            }
        }
    })?;
    serde_json::from_slice(&bytes).map_err(|error| RecoveryError::Corrupt {
        path: path.to_path_buf(),
        message: error.to_string(),
    })
}

/// Matches the file names `tempfile::NamedTempFile::new_in` produces (`.tmp`
/// plus exactly six ASCII alphanumerics) — the leftovers of a crash between
/// temp creation and rename. The check is deliberately narrow so nothing but
/// a tempfile-shaped name is ever considered for removal.
fn is_orphaned_temp_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(rest) = name.strip_prefix(".tmp") else {
        return false;
    };
    rest.len() == 6 && rest.chars().all(|c| c.is_ascii_alphanumeric())
}

fn draft_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .to_string()
}

fn draft_info(draft: &DraftRecord, updated_unix_ms: u128) -> DraftInfo {
    DraftInfo {
        draft_id: draft.draft_id.clone(),
        original_path: draft.original_path.clone(),
        title: draft.title.clone(),
        saved_text_hash: draft.saved_text_hash.clone(),
        saved_version: draft.saved_version.clone(),
        updated_unix_ms,
    }
}

fn draft_info_from_stored(stored: &StoredDraftInfo, updated_unix_ms: u128) -> DraftInfo {
    DraftInfo {
        draft_id: stored.draft_id.clone(),
        original_path: stored.original_path.clone(),
        title: stored.title.clone(),
        saved_text_hash: stored.saved_text_hash.clone(),
        saved_version: stored.saved_version.clone(),
        updated_unix_ms,
    }
}

fn sync_directory(dir: &Path) -> Result<(), RecoveryError> {
    fs::File::open(dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| RecoveryError::Io {
            path: dir.to_path_buf(),
            source: error,
        })
}

fn modified_unix_ms(metadata: &fs::Metadata, path: &Path) -> Result<u128, RecoveryError> {
    metadata
        .modified()
        .map_err(|error| RecoveryError::Io {
            path: path.to_path_buf(),
            source: error,
        })?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| RecoveryError::Io {
            path: path.to_path_buf(),
            source: io::Error::new(io::ErrorKind::InvalidData, error),
        })
}
