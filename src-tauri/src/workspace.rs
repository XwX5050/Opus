use std::fmt;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub enum WorkspaceError {
    NotAbsolute { path: PathBuf },
    NotFound { path: PathBuf },
    NotADirectory { path: PathBuf },
    OutsideRoot { path: PathBuf },
    NotMarkdown { path: PathBuf },
    InvalidName { name: String },
    AlreadyExists { path: PathBuf },
    Io { path: PathBuf, source: io::Error },
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute { path } => write!(formatter, "path must be absolute: {}", path.display()),
            Self::NotFound { path } => write!(formatter, "{} does not exist", path.display()),
            Self::NotADirectory { path } => write!(formatter, "{} is not a directory", path.display()),
            Self::OutsideRoot { path } => write!(
                formatter,
                "{} escapes the opened workspace root",
                path.display()
            ),
            Self::NotMarkdown { path } => write!(
                formatter,
                "{} must have a .md or .markdown extension",
                path.display()
            ),
            Self::InvalidName { name } => write!(formatter, "invalid entry name: {name}"),
            Self::AlreadyExists { path } => write!(formatter, "{} already exists", path.display()),
            Self::Io { path, source } => write!(formatter, "I/O error for {}: {source}", path.display()),
        }
    }
}

impl std::error::Error for WorkspaceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorkspaceRootInfo {
    pub path: PathBuf,
    pub title: String,
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

/// Canonicalizes the opened root. Temp directories on macOS live behind a
/// `/var` symlink, so every boundary check compares canonical paths.
fn canonical_root(root: &Path) -> Result<PathBuf, WorkspaceError> {
    if !root.is_absolute() {
        return Err(WorkspaceError::NotAbsolute {
            path: root.to_path_buf(),
        });
    }
    let canonical = fs::canonicalize(root).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => WorkspaceError::NotFound {
            path: root.to_path_buf(),
        },
        _ => WorkspaceError::Io {
            path: root.to_path_buf(),
            source: error,
        },
    })?;
    if !canonical.is_dir() {
        return Err(WorkspaceError::NotADirectory { path: canonical });
    }
    Ok(canonical)
}

/// Resolves an existing entry inside the root, rejecting anything whose
/// canonical path escapes it (through `..` or symlinks).
fn resolve_existing(root: &Path, relative: &Path) -> Result<PathBuf, WorkspaceError> {
    let root = canonical_root(root)?;
    let candidate = if relative.as_os_str().is_empty() {
        root.clone()
    } else {
        root.join(relative)
    };
    let canonical = fs::canonicalize(&candidate).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => WorkspaceError::NotFound { path: candidate.clone() },
        _ => WorkspaceError::Io {
            path: candidate.clone(),
            source: error,
        },
    })?;
    if !canonical.starts_with(&root) {
        return Err(WorkspaceError::OutsideRoot { path: canonical });
    }
    Ok(canonical)
}

/// Resolves the parent directory of a not-yet-existing target and returns
/// the canonical target path after the boundary check.
fn resolve_new_target(root: &Path, relative: &Path) -> Result<PathBuf, WorkspaceError> {
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err(WorkspaceError::InvalidName {
            name: relative.display().to_string(),
        });
    }
    let name = relative
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| WorkspaceError::InvalidName {
            name: relative.display().to_string(),
        })?;
    if name.starts_with('.') {
        return Err(WorkspaceError::InvalidName { name: name.into() });
    }
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
    let parent = resolve_existing(root, parent_relative)?;
    if !parent.is_dir() {
        return Err(WorkspaceError::NotADirectory { path: parent });
    }
    Ok(parent.join(name))
}

pub fn open_workspace(root: &Path) -> Result<WorkspaceRootInfo, WorkspaceError> {
    let canonical = canonical_root(root)?;
    let title = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical.display().to_string());
    Ok(WorkspaceRootInfo {
        path: canonical,
        title,
    })
}

/// Lists one directory level only: non-hidden subdirectories first, then
/// Markdown files, each group sorted case-insensitively by name. Symlinks
/// are classified by their target so a link to a directory can be expanded;
/// expanding it re-runs the boundary check against the canonical target.
pub fn list_directory(root: &Path, relative: &Path) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
    let directory = resolve_existing(root, relative)?;
    if !directory.is_dir() {
        return Err(WorkspaceError::NotADirectory { path: directory });
    }
    let mut directories = Vec::new();
    let mut files = Vec::new();
    let entries = fs::read_dir(&directory).map_err(|error| WorkspaceError::Io {
        path: directory.clone(),
        source: error,
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| WorkspaceError::Io {
            path: directory.clone(),
            source: error,
        })?;
        let path = entry.path();
        if is_hidden(&path) {
            continue;
        }
        // `fs::metadata` follows symlinks; broken links are skipped.
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if metadata.is_dir() {
            directories.push(DirectoryEntry {
                name,
                path,
                is_directory: true,
            });
        } else if metadata.is_file() && is_markdown(&path) {
            files.push(DirectoryEntry {
                name,
                path,
                is_directory: false,
            });
        }
    }
    let by_name = |left: &DirectoryEntry, right: &DirectoryEntry| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    };
    directories.sort_by(by_name);
    files.sort_by(by_name);
    directories.extend(files);
    Ok(directories)
}

pub fn create_markdown_file(root: &Path, relative: &Path) -> Result<DirectoryEntry, WorkspaceError> {
    if !is_markdown(relative) {
        return Err(WorkspaceError::NotMarkdown {
            path: relative.to_path_buf(),
        });
    }
    let target = resolve_new_target(root, relative)?;
    if target.exists() {
        return Err(WorkspaceError::AlreadyExists { path: target });
    }
    fs::write(&target, b"").map_err(|error| WorkspaceError::Io {
        path: target.clone(),
        source: error,
    })?;
    Ok(DirectoryEntry {
        name: target.file_name().unwrap().to_string_lossy().into_owned(),
        path: target,
        is_directory: false,
    })
}

/// Renames an entry within its own directory. `to_name` must be a plain
/// entry name (no separators, not hidden); Markdown files keep a Markdown
/// extension so they cannot be renamed out of the listing.
pub fn rename_entry(root: &Path, from: &Path, to_name: &str) -> Result<DirectoryEntry, WorkspaceError> {
    let source = resolve_existing(root, from)?;
    if source == canonical_root(root)? {
        return Err(WorkspaceError::OutsideRoot { path: source });
    }
    let valid_name = !to_name.is_empty()
        && !to_name.starts_with('.')
        && Path::new(to_name).components().count() == 1
        && matches!(Path::new(to_name).components().next(), Some(Component::Normal(_)));
    if !valid_name {
        return Err(WorkspaceError::InvalidName {
            name: to_name.into(),
        });
    }
    let target = source.parent().unwrap().join(to_name);
    if source.is_file() && !is_markdown(&target) {
        return Err(WorkspaceError::NotMarkdown { path: target });
    }
    if target.exists() {
        return Err(WorkspaceError::AlreadyExists { path: target });
    }
    fs::rename(&source, &target).map_err(|error| WorkspaceError::Io {
        path: source.clone(),
        source: error,
    })?;
    Ok(DirectoryEntry {
        name: to_name.into(),
        is_directory: target.is_dir(),
        path: target,
    })
}

/// Moves an entry to the operating system's trash so the operation stays
/// recoverable; permanent recursive deletion is never used. The workspace
/// root itself and anything escaping it are rejected before touching disk.
pub fn trash_entry(root: &Path, relative: &Path) -> Result<(), WorkspaceError> {
    let canonical_root = canonical_root(root)?;
    let target = resolve_existing(root, relative)?;
    if target == canonical_root {
        return Err(WorkspaceError::OutsideRoot { path: target });
    }
    move_to_system_trash(&target)
}

/// Uses the system trash through `NSFileManager.trashItemAtURL` on macOS,
/// which (unlike the crate's default Finder AppleScript) needs no automation
/// permission and cannot stall on a Finder AppleEvent timeout.
fn move_to_system_trash(target: &Path) -> Result<(), WorkspaceError> {
    #[cfg(target_os = "macos")]
    let result = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::new();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context.delete(target)
    };
    #[cfg(not(target_os = "macos"))]
    let result = trash::delete(target);
    result.map_err(|error| WorkspaceError::Io {
        path: target.to_path_buf(),
        source: io::Error::new(io::ErrorKind::Other, error),
    })
}
