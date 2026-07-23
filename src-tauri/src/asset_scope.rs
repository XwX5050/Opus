use std::collections::HashMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetScopeError {
    NotAbsolute { path: PathBuf },
    MissingParent { path: PathBuf },
    UnknownConsumer { consumer_id: String },
}

impl fmt::Display for AssetScopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute { path } => write!(formatter, "path must be absolute: {}", path.display()),
            Self::MissingParent { path } => {
                write!(formatter, "path has no parent directory: {}", path.display())
            }
            Self::UnknownConsumer { consumer_id } => {
                write!(formatter, "unknown asset scope consumer: {consumer_id}")
            }
        }
    }
}

impl std::error::Error for AssetScopeError {}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ScopeKey {
    root: PathBuf,
    recursive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquiredScope {
    pub root: PathBuf,
    pub recursive: bool,
    pub newly_added: bool,
}

/// Collapses `.` and `..` components without touching the filesystem.
/// `..` at the filesystem root is dropped, so escapes above the root
/// normalize to the root instead of escaping it.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push("..");
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// Resolves symlinks when the path exists and falls back to lexical
/// normalization otherwise. Temp directories on macOS live behind a
/// `/var` symlink, so roots and candidates must go through the same
/// resolution to stay comparable.
fn resolve(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| lexical_normalize(path))
}

/// Reference-counted registry of asset directories the webview may read.
///
/// Tauri's runtime scope (`tauri::scope::fs::Scope`) is additive-only in
/// tauri 2.11 — patterns can be allowed but never removed — so this
/// registry is the authoritative record of which consumer holds which
/// directory and when access logically ends. Command handlers mirror
/// newly added roots into the asset protocol scope with
/// `allow_directory`.
#[derive(Debug, Default)]
pub struct AssetScopeRegistry {
    scopes: HashMap<ScopeKey, usize>,
    consumers: HashMap<String, Vec<ScopeKey>>,
}

impl AssetScopeRegistry {
    /// Grants a consumer access to the document's parent directory
    /// (non-recursive, so only files directly beside the document).
    pub fn acquire_document<P: AsRef<Path>>(
        &mut self,
        consumer_id: &str,
        path: P,
    ) -> Result<AcquiredScope, AssetScopeError> {
        let path = path.as_ref();
        if !path.is_absolute() {
            return Err(AssetScopeError::NotAbsolute {
                path: path.to_path_buf(),
            });
        }
        let parent = path
            .parent()
            .ok_or_else(|| AssetScopeError::MissingParent {
                path: path.to_path_buf(),
            })?;
        Ok(self.acquire(consumer_id, resolve(parent), false))
    }

    /// Grants a consumer recursive access to everything inside `root`.
    pub fn acquire_workspace<P: AsRef<Path>>(
        &mut self,
        consumer_id: &str,
        root: P,
    ) -> Result<AcquiredScope, AssetScopeError> {
        let root = root.as_ref();
        if !root.is_absolute() {
            return Err(AssetScopeError::NotAbsolute {
                path: root.to_path_buf(),
            });
        }
        Ok(self.acquire(consumer_id, resolve(root), true))
    }

    fn acquire(&mut self, consumer_id: &str, root: PathBuf, recursive: bool) -> AcquiredScope {
        let key = ScopeKey { root, recursive };
        let ref_count = self.scopes.entry(key.clone()).or_insert(0);
        let newly_added = *ref_count == 0;
        *ref_count += 1;
        self.consumers
            .entry(consumer_id.to_string())
            .or_default()
            .push(key.clone());
        AcquiredScope {
            root: key.root,
            recursive: key.recursive,
            newly_added,
        }
    }

    /// Releases every scope held by the consumer. A scope disappears once
    /// its last consumer releases it.
    pub fn release_consumer(&mut self, consumer_id: &str) -> Result<(), AssetScopeError> {
        let keys = self
            .consumers
            .remove(consumer_id)
            .ok_or_else(|| AssetScopeError::UnknownConsumer {
                consumer_id: consumer_id.to_string(),
            })?;
        for key in keys {
            if let Some(ref_count) = self.scopes.get_mut(&key) {
                *ref_count -= 1;
                if *ref_count == 0 {
                    self.scopes.remove(&key);
                }
            }
        }
        Ok(())
    }

    /// Returns true when any active scope grants access to `path`.
    /// Symlinks are resolved through canonicalization, so a link inside an
    /// allowed directory that points outside it is rejected. A dangling
    /// symlink cannot be canonicalized and is compared lexically.
    pub fn allows<P: AsRef<Path>>(&self, path: P) -> bool {
        let candidate = resolve(path.as_ref());
        self.scopes.keys().any(|key| {
            if candidate == key.root {
                return true;
            }
            if key.recursive {
                candidate.starts_with(&key.root)
            } else {
                candidate.parent() == Some(key.root.as_path())
            }
        })
    }
}
