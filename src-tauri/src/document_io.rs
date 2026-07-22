use std::{
    fmt, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Newline {
    Lf,
    CrLf,
}

#[derive(Debug, PartialEq, Eq)]
pub struct OpenedDocument {
    pub text: String,
    pub has_utf8_bom: bool,
    pub newline: Newline,
    pub modified_unix_ms: u128,
    pub version: String,
}

#[derive(Debug)]
pub enum DocumentIoError {
    InvalidUtf8 { path: PathBuf },
    MissingParent { path: PathBuf },
    NotFound { path: PathBuf },
    PermissionDenied { path: PathBuf },
    Io { path: PathBuf, source: io::Error },
}

impl fmt::Display for DocumentIoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUtf8 { path } => {
                write!(formatter, "{} is not valid UTF-8", path.display())
            }
            Self::MissingParent { path } => write!(
                formatter,
                "parent directory for {} does not exist",
                path.display()
            ),
            Self::NotFound { path } => write!(formatter, "{} does not exist", path.display()),
            Self::PermissionDenied { path } => {
                write!(formatter, "permission denied for {}", path.display())
            }
            Self::Io { path, source } => {
                write!(formatter, "I/O error for {}: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for DocumentIoError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

pub fn read_document(path: &Path) -> Result<OpenedDocument, DocumentIoError> {
    let bytes = fs::read(path).map_err(|error| map_io_error(path, error))?;
    let has_utf8_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let text = std::str::from_utf8(if has_utf8_bom { &bytes[3..] } else { &bytes })
        .map_err(|_| DocumentIoError::InvalidUtf8 {
            path: path.to_path_buf(),
        })?
        .to_owned();
    let metadata = fs::metadata(path).map_err(|error| map_io_error(path, error))?;

    Ok(OpenedDocument {
        newline: detect_newline(&text),
        text,
        has_utf8_bom,
        modified_unix_ms: modified_unix_ms(&metadata, path)?,
        version: version_for_bytes(&bytes),
    })
}

pub fn document_version(path: &Path) -> Result<String, DocumentIoError> {
    fs::read(path)
        .map(|bytes| version_for_bytes(&bytes))
        .map_err(|error| map_io_error(path, error))
}

fn version_for_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub fn write_document_checked(
    path: &Path,
    text: &str,
    bom: bool,
    newline: Newline,
    expected_version: Option<&str>,
) -> Result<(u128, String), DocumentIoError> {
    let destination = resolve_write_path(path)?;
    match (expected_version, document_version(&destination)) {
        (Some(expected), Ok(actual)) if expected != actual => {
            return Err(DocumentIoError::Io {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::AlreadyExists, "document version conflict"),
            })
        }
        (Some(_), Err(DocumentIoError::NotFound { .. })) | (None, Ok(_)) => {
            return Err(DocumentIoError::Io {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::AlreadyExists, "document version conflict"),
            })
        }
        (Some(_), Err(error)) => return Err(error),
        (None, Err(DocumentIoError::NotFound { .. })) | (Some(_), Ok(_)) => {}
        (None, Err(error)) => return Err(error),
    }
    let modified = write_document(&destination, text, bom, newline)?;
    Ok((modified, document_version(&destination)?))
}

pub fn write_document(
    path: &Path,
    text: &str,
    bom: bool,
    newline: Newline,
) -> Result<u128, DocumentIoError> {
    let destination = resolve_write_path(path)?;
    let parent = parent_directory(&destination)?;
    let existing_permissions = existing_permissions(&destination)?;
    let mut output = Vec::new();
    if bom {
        output.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    output.extend_from_slice(serialize_text(text, newline).as_bytes());

    let (temporary_path, mut temporary_file) = create_sibling_temp(parent, &destination)?;
    let result = (|| {
        if let Some(permissions) = existing_permissions {
            temporary_file
                .set_permissions(permissions)
                .map_err(|error| map_io_error(&destination, error))?;
        }
        temporary_file
            .write_all(&output)
            .map_err(|error| map_io_error(&destination, error))?;
        temporary_file
            .flush()
            .map_err(|error| map_io_error(&destination, error))?;
        temporary_file
            .sync_all()
            .map_err(|error| map_io_error(&destination, error))?;
        let modified_unix_ms = temporary_file_modified_unix_ms(&temporary_file, &destination)?;
        drop(temporary_file);
        fs::rename(&temporary_path, &destination)
            .map_err(|error| map_io_error(&destination, error))?;

        Ok(modified_unix_ms)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn detect_newline(text: &str) -> Newline {
    let mut crlf_count = 0_u64;
    let mut lf_count = 0_u64;
    let mut first = None;

    for (index, byte) in text.bytes().enumerate() {
        if byte != b'\n' {
            continue;
        }

        let style = if index > 0 && text.as_bytes()[index - 1] == b'\r' {
            crlf_count += 1;
            Newline::CrLf
        } else {
            lf_count += 1;
            Newline::Lf
        };
        first.get_or_insert(style);
    }

    match crlf_count.cmp(&lf_count) {
        std::cmp::Ordering::Greater => Newline::CrLf,
        std::cmp::Ordering::Less => Newline::Lf,
        std::cmp::Ordering::Equal => first.unwrap_or(Newline::Lf),
    }
}

fn serialize_text(text: &str, newline: Newline) -> String {
    let canonical = canonicalize_newlines(text);
    match newline {
        Newline::Lf => canonical,
        Newline::CrLf => canonical.replace('\n', "\r\n"),
    }
}

fn canonicalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn resolve_write_path(path: &Path) -> Result<PathBuf, DocumentIoError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => path
            .canonicalize()
            .map_err(|error| map_io_error(path, error)),
        Ok(_) => Ok(path.to_path_buf()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(error) => Err(map_io_error(path, error)),
    }
}

fn parent_directory(path: &Path) -> Result<&Path, DocumentIoError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let parent = parent.unwrap_or_else(|| Path::new("."));
    match fs::metadata(parent) {
        Ok(metadata) if metadata.is_dir() => Ok(parent),
        Ok(_) => Err(DocumentIoError::Io {
            path: path.to_path_buf(),
            source: io::Error::new(io::ErrorKind::InvalidInput, "parent is not a directory"),
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Err(DocumentIoError::MissingParent {
                path: path.to_path_buf(),
            })
        }
        Err(error) => Err(map_io_error(parent, error)),
    }
}

fn existing_permissions(path: &Path) -> Result<Option<fs::Permissions>, DocumentIoError> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if metadata.permissions().readonly() {
                return Err(DocumentIoError::PermissionDenied {
                    path: path.to_path_buf(),
                });
            }
            Ok(Some(metadata.permissions()))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(map_io_error(path, error)),
    }
}

fn create_sibling_temp(
    parent: &Path,
    destination: &Path,
) -> Result<(PathBuf, fs::File), DocumentIoError> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document");

    for _ in 0..128 {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary_path = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            sequence
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => return Ok((temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(map_io_error(&temporary_path, error)),
        }
    }

    Err(DocumentIoError::Io {
        path: destination.to_path_buf(),
        source: io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a sibling temporary file",
        ),
    })
}

fn modified_unix_ms(metadata: &fs::Metadata, path: &Path) -> Result<u128, DocumentIoError> {
    metadata
        .modified()
        .map_err(|error| map_io_error(path, error))?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| DocumentIoError::Io {
            path: path.to_path_buf(),
            source: io::Error::new(io::ErrorKind::InvalidData, error),
        })
}

fn temporary_file_modified_unix_ms(
    file: &fs::File,
    destination: &Path,
) -> Result<u128, DocumentIoError> {
    let metadata = file
        .metadata()
        .map_err(|error| map_io_error(destination, error))?;
    modified_unix_ms(&metadata, destination)
}

fn map_io_error(path: &Path, error: io::Error) -> DocumentIoError {
    match error.kind() {
        io::ErrorKind::NotFound => DocumentIoError::NotFound {
            path: path.to_path_buf(),
        },
        io::ErrorKind::PermissionDenied => DocumentIoError::PermissionDenied {
            path: path.to_path_buf(),
        },
        _ => DocumentIoError::Io {
            path: path.to_path_buf(),
            source: error,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_io_reads_temporary_mtime_before_rename() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let temporary_path = dir.path().join(".note.md.tmp");
        let mut temporary_file = fs::File::create(&temporary_path).unwrap();
        temporary_file.write_all(b"contents\n").unwrap();
        temporary_file.sync_all().unwrap();

        let temporary_mtime = temporary_file_modified_unix_ms(&temporary_file, &path).unwrap();

        assert_eq!(
            temporary_mtime,
            modified_unix_ms(&temporary_file.metadata().unwrap(), &path).unwrap()
        );
    }
}
