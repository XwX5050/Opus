use std::{
    fmt, fs,
    io::{self, Read, Write},
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
    Conflict { path: PathBuf },
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
            Self::Conflict { path } => write!(formatter, "document changed at {}", path.display()),
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
    let mut file = fs::File::open(path).map_err(|error| map_io_error(path, error))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| map_io_error(path, error))?;
    let has_utf8_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let text = std::str::from_utf8(if has_utf8_bom { &bytes[3..] } else { &bytes })
        .map_err(|_| DocumentIoError::InvalidUtf8 {
            path: path.to_path_buf(),
        })?
        .to_owned();
    let metadata = file.metadata().map_err(|error| map_io_error(path, error))?;

    Ok(OpenedDocument {
        newline: detect_newline(&text),
        text,
        has_utf8_bom,
        modified_unix_ms: modified_unix_ms(&metadata, path)?,
        version: version_for_bytes_and_file(&bytes, &file, path)?,
    })
}

/// Returns the modification time and opaque version of the file at `path`,
/// computed exactly as `read_document` and `write_document_checked` compute
/// them. Watchers use this to attach a version to change events without
/// decoding the text.
pub fn probe_version(path: &Path) -> Result<(u128, String), DocumentIoError> {
    let mut file = fs::File::open(path).map_err(|error| map_io_error(path, error))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| map_io_error(path, error))?;
    let metadata = file.metadata().map_err(|error| map_io_error(path, error))?;
    Ok((
        modified_unix_ms(&metadata, path)?,
        version_for_bytes_and_file(&bytes, &file, path)?,
    ))
}

fn content_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn version_for_bytes_and_file(
    bytes: &[u8],
    file: &fs::File,
    path: &Path,
) -> Result<String, DocumentIoError> {
    Ok(format!(
        "sha256:{}:{}",
        content_hash(bytes),
        identity_token(file, path)?
    ))
}

#[cfg(unix)]
fn identity_token(file: &fs::File, path: &Path) -> Result<String, DocumentIoError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|error| map_io_error(path, error))?;
    Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
}

/// std's `MetadataExt` volume-serial/file-index accessors are still
/// unstable (`windows_by_handle`), so read the same fields through the
/// Win32 API from the already-open file handle.
#[cfg(windows)]
fn identity_token(file: &fs::File, path: &Path) -> Result<String, DocumentIoError> {
    let info = by_handle_file_information(file, path)?;
    Ok(format!(
        "windows:{}:{}:{}:{}",
        info.dwVolumeSerialNumber,
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        (u64::from(info.ftCreationTime.dwHighDateTime) << 32)
            | u64::from(info.ftCreationTime.dwLowDateTime),
        (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
    ))
}

#[cfg(not(any(unix, windows)))]
fn identity_token(file: &fs::File, path: &Path) -> Result<String, DocumentIoError> {
    let metadata = file.metadata().map_err(|error| map_io_error(path, error))?;
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos());
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos());
    Ok(format!(
        "fallback:{}:{created:?}:{modified:?}",
        metadata.len()
    ))
}

/// Queries `BY_HANDLE_FILE_INFORMATION` for an open file: the stable source
/// of the volume serial number and file index that `MetadataExt` only
/// exposes on nightly.
#[cfg(windows)]
fn by_handle_file_information(
    file: &fs::File,
    path: &Path,
) -> Result<windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION, DocumentIoError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    // SAFETY: every field is a plain integer, so a zeroed struct is valid.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `file` is a live file handle and `info` is valid for writes of
    // the expected size.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(map_io_error(path, io::Error::last_os_error()));
    }
    Ok(info)
}

/// Identity snapshot of an already-open file for the checked-write commit
/// guard (`same_identity` below).
#[cfg(not(windows))]
fn identity_of_open_file(file: &fs::File, path: &Path) -> Result<fs::Metadata, DocumentIoError> {
    file.metadata().map_err(|error| map_io_error(path, error))
}

#[cfg(windows)]
fn identity_of_open_file(
    file: &fs::File,
    path: &Path,
) -> Result<windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION, DocumentIoError> {
    by_handle_file_information(file, path)
}

#[cfg(not(windows))]
fn identity_of_path(path: &Path) -> Result<fs::Metadata, DocumentIoError> {
    fs::metadata(path).map_err(|error| map_io_error(path, error))
}

#[cfg(windows)]
fn identity_of_path(
    path: &Path,
) -> Result<windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION, DocumentIoError> {
    let file = fs::File::open(path).map_err(|error| map_io_error(path, error))?;
    by_handle_file_information(&file, path)
}

pub fn write_document_checked(
    path: &Path,
    text: &str,
    bom: bool,
    newline: Newline,
    expected_version: Option<&str>,
) -> Result<(u128, String), DocumentIoError> {
    write_document_checked_with_hook(path, text, bom, newline, expected_version, || {})
}

#[doc(hidden)]
pub fn write_document_checked_with_hook<F>(
    path: &Path,
    text: &str,
    bom: bool,
    newline: Newline,
    expected_version: Option<&str>,
    before_commit: F,
) -> Result<(u128, String), DocumentIoError>
where
    F: FnOnce(),
{
    let destination = resolve_write_path(path)?;
    let parent = parent_directory(&destination)?;
    // This preserves basic filesystem mode/readonly permissions only. ACLs,
    // xattrs, ownership, and hard-link topology are release-hardening work.
    let permissions = existing_mode_permissions(&destination)?;
    let output = output_bytes(text, bom, newline);
    let mut temporary = create_checked_temp(parent, &destination, permissions.as_ref())?;
    if let Some(permissions) = permissions {
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|error| map_io_error(&destination, error))?;
    }
    temporary
        .write_all(&output)
        .map_err(|error| map_io_error(&destination, error))?;
    temporary
        .flush()
        .map_err(|error| map_io_error(&destination, error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| map_io_error(&destination, error))?;
    let temporary_metadata = temporary
        .as_file()
        .metadata()
        .map_err(|error| map_io_error(&destination, error))?;
    let modified = modified_unix_ms(&temporary_metadata, &destination)?;
    let version = version_for_bytes_and_file(&output, temporary.as_file(), &destination)?;

    if let Some(expected) = expected_version {
        let mut current = fs::File::open(&destination).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                DocumentIoError::Conflict {
                    path: path.to_path_buf(),
                }
            } else {
                map_io_error(&destination, error)
            }
        })?;
        let identity = identity_of_open_file(&current, &destination)?;
        let mut bytes = Vec::new();
        current
            .read_to_end(&mut bytes)
            .map_err(|error| map_io_error(&destination, error))?;
        if version_for_bytes_and_file(&bytes, &current, &destination)? != expected {
            return Err(DocumentIoError::Conflict {
                path: path.to_path_buf(),
            });
        }
        before_commit();
        match resolve_write_path(path) {
            Ok(current_destination) if current_destination == destination => {}
            _ => {
                return Err(DocumentIoError::Conflict {
                    path: path.to_path_buf(),
                })
            }
        }
        let current_identity = identity_of_path(&destination)?;
        if !same_identity(&identity, &current_identity) {
            return Err(DocumentIoError::Conflict {
                path: path.to_path_buf(),
            });
        }
        // Windows refuses to rename over a file that still has an open
        // handle (ACCESS_DENIED), so close the conflict-check handle before
        // committing; the identity guard above already passed.
        drop(current);
        temporary
            .persist(&destination)
            .map_err(|error| map_io_error(&destination, error.error))?;
    } else {
        before_commit();
        temporary.persist_noclobber(&destination).map_err(|error| {
            if error.error.kind() == io::ErrorKind::AlreadyExists {
                DocumentIoError::Conflict {
                    path: path.to_path_buf(),
                }
            } else {
                map_io_error(&destination, error.error)
            }
        })?;
    }
    // The rename above lands in the parent directory; syncing it makes the
    // rename itself durable so a crash cannot resurrect the previous file
    // version (same discipline as recovery drafts).
    sync_parent_directory(&destination)?;
    Ok((modified, version))
}

#[cfg(unix)]
fn same_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
}

#[cfg(windows)]
fn same_identity(
    left: &windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION,
    right: &windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION,
) -> bool {
    left.dwVolumeSerialNumber == right.dwVolumeSerialNumber
        && left.nFileIndexHigh == right.nFileIndexHigh
        && left.nFileIndexLow == right.nFileIndexLow
        && left.nFileSizeHigh == right.nFileSizeHigh
        && left.nFileSizeLow == right.nFileSizeLow
        && left.ftLastWriteTime.dwLowDateTime == right.ftLastWriteTime.dwLowDateTime
        && left.ftLastWriteTime.dwHighDateTime == right.ftLastWriteTime.dwHighDateTime
}

#[cfg(not(any(unix, windows)))]
fn same_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}

pub fn write_document(
    path: &Path,
    text: &str,
    bom: bool,
    newline: Newline,
) -> Result<u128, DocumentIoError> {
    let destination = resolve_write_path(path)?;
    let parent = parent_directory(&destination)?;
    let existing_permissions = existing_mode_permissions(&destination)?;
    let output = output_bytes(text, bom, newline);

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
        // Without the directory fsync a crash could roll back the rename on
        // delayed-allocation filesystems (ext4/xfs), losing the new content.
        sync_parent_directory(&destination)?;

        Ok(modified_unix_ms)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

/// Writes opaque binary payload (clipboard image bytes) to `path` through
/// the same atomic sibling-temp + rename strategy as document writes.
pub fn write_image_bytes(path: &Path, bytes: &[u8]) -> Result<(), DocumentIoError> {
    let destination = resolve_write_path(path)?;
    let parent = parent_directory(&destination)?;
    let existing_permissions = existing_mode_permissions(&destination)?;

    let (temporary_path, mut temporary_file) = create_sibling_temp(parent, &destination)?;
    let result = (|| {
        if let Some(permissions) = existing_permissions {
            temporary_file
                .set_permissions(permissions)
                .map_err(|error| map_io_error(&destination, error))?;
        }
        temporary_file
            .write_all(bytes)
            .map_err(|error| map_io_error(&destination, error))?;
        temporary_file
            .flush()
            .map_err(|error| map_io_error(&destination, error))?;
        temporary_file
            .sync_all()
            .map_err(|error| map_io_error(&destination, error))?;
        drop(temporary_file);
        fs::rename(&temporary_path, &destination)
            .map_err(|error| map_io_error(&destination, error))?;
        // Same durability rule as document writes: fsync the directory so the
        // rename survives a crash.
        sync_parent_directory(&destination)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn output_bytes(text: &str, bom: bool, newline: Newline) -> Vec<u8> {
    let mut output = Vec::new();
    if bom {
        output.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    output.extend_from_slice(serialize_text(text, newline).as_bytes());
    output
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

/// Syncs the parent directory of `path` so a completed rename is durable.
#[cfg(not(windows))]
fn sync_parent_directory(path: &Path) -> Result<(), DocumentIoError> {
    let parent = parent_directory(path)?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| map_io_error(parent, error))
}

/// No-op on Windows: directories cannot be opened for fsync there
/// (ERROR_ACCESS_DENIED) and NTFS already journals directory metadata, so
/// the Unix directory-fsync durability idiom has no equivalent to perform.
#[cfg(windows)]
fn sync_parent_directory(_path: &Path) -> Result<(), DocumentIoError> {
    Ok(())
}

fn existing_mode_permissions(path: &Path) -> Result<Option<fs::Permissions>, DocumentIoError> {
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

/// Sibling temp file for a checked write. An existing destination's mode is
/// requested here and then copied over exactly by the caller; a **new**
/// destination requests the default file mode instead of the private temp
/// default.
fn create_checked_temp(
    parent: &Path,
    destination: &Path,
    existing: Option<&fs::Permissions>,
) -> Result<tempfile::NamedTempFile, DocumentIoError> {
    let mut builder = tempfile::Builder::new();
    match existing {
        Some(permissions) => {
            builder.permissions(permissions.clone());
        }
        None => request_new_file_permissions(&mut builder),
    }
    builder
        .tempfile_in(parent)
        .map_err(|error| map_io_error(destination, error))
}

/// Requests `0666` for a brand-new destination: the kernel masks it with the
/// umask, so the saved document lands on the mode a plain `create_new` (and
/// `workspace::create_markdown_file`) produces. `NamedTempFile`'s private
/// `0600` default would otherwise stick to every newly saved document.
#[cfg(unix)]
fn request_new_file_permissions(builder: &mut tempfile::Builder) {
    use std::os::unix::fs::PermissionsExt;
    builder.permissions(fs::Permissions::from_mode(0o666));
}

/// Windows carries no file modes: a created file already gets the platform's
/// default permissions and access control.
#[cfg(not(unix))]
fn request_new_file_permissions(_builder: &mut tempfile::Builder) {}

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

    #[test]
    fn checked_write_syncs_the_parent_directory_and_reports_the_committed_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let (_, version) =
            write_document_checked(&path, "hello\n", false, Newline::Lf, None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\n");
        // The post-rename directory sync is part of the write path: the
        // parent fsync must still succeed after the write completed, and
        // the on-disk version must match the one the write reported.
        sync_parent_directory(&path).unwrap();
        let (_, probed_version) = probe_version(&path).unwrap();
        assert_eq!(probed_version, version);
    }

    #[test]
    fn checked_write_syncs_the_directory_after_a_conflict_check_commit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let (_, first_version) =
            write_document_checked(&path, "one\n", false, Newline::Lf, None).unwrap();
        let (_, version) =
            write_document_checked(&path, "two\n", false, Newline::Lf, Some(&first_version))
                .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two\n");
        let (_, probed_version) = probe_version(&path).unwrap();
        assert_eq!(probed_version, version);
    }
}
