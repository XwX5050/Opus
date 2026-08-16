//! Filesystem watching: one debounced watcher service with reference-counted
//! consumers (mirroring the asset scope registry), emitting a normalized
//! disk-event stream to the frontend.
//!
//! Normalization rules (kept deterministic and documented here):
//!
//! - Events for one path inside one debounce window coalesce into a single
//!   outcome, decided by probing the filesystem at flush time: existing paths
//!   yield `changed`, absent paths yield `missing`. A create+delete inside one
//!   window therefore reports `missing`, and a delete+recreate reports
//!   `changed`.
//! - `moved` is only detected when the platform backend reports both paths of
//!   a rename in a single event. macOS FSEvents commonly delivers a rename as
//!   separate from/to events, which then normalize to `missing` + `changed`
//!   instead of `moved`; consumers must tolerate that.
//! - A rename supersedes any pending single-path entries for its endpoints.
//! - Debounce deadlines use first-seen time and are never extended, so a
//!   continuously modified file still flushes after one window.

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::document_io;

pub const DEFAULT_DEBOUNCE_WINDOW: Duration = Duration::from_millis(200);
const DISPATCH_TICK: Duration = Duration::from_millis(25);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiskEvent {
    Changed {
        path: PathBuf,
        modified_unix_ms: u128,
        version: String,
    },
    Missing {
        path: PathBuf,
    },
    Moved {
        from: PathBuf,
        to: PathBuf,
    },
}

/// Raw filesystem signal, decoupled from notify types so the normalization
/// logic stays a pure, deterministically testable state machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RawFsEvent {
    Modified(PathBuf),
    Created(PathBuf),
    Removed(PathBuf),
    Renamed { from: PathBuf, to: PathBuf },
}

fn raw_events(event: &notify::Event) -> Vec<RawFsEvent> {
    match event.kind {
        EventKind::Create(_) => event
            .paths
            .iter()
            .cloned()
            .map(RawFsEvent::Created)
            .collect(),
        EventKind::Remove(_) => event
            .paths
            .iter()
            .cloned()
            .map(RawFsEvent::Removed)
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() == 2 => {
            vec![RawFsEvent::Renamed {
                from: event.paths[0].clone(),
                to: event.paths[1].clone(),
            }]
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event
            .paths
            .iter()
            .cloned()
            .map(RawFsEvent::Removed)
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => event
            .paths
            .iter()
            .cloned()
            .map(RawFsEvent::Created)
            .collect(),
        EventKind::Modify(_) => event
            .paths
            .iter()
            .cloned()
            .map(RawFsEvent::Modified)
            .collect(),
        // Access events are pure reads and cannot change disk state. Every
        // other kind (including the vague Any/Other kinds some backends
        // produce) is treated as a touch: the flush-time probe decides
        // between `changed` and `missing` anyway.
        EventKind::Access(_) => Vec::new(),
        _ => event
            .paths
            .iter()
            .cloned()
            .map(RawFsEvent::Modified)
            .collect(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchError {
    NotAbsolute { path: PathBuf },
    MissingParent { path: PathBuf },
    UnknownConsumer { consumer_id: String },
    Unavailable,
    Notify { message: String },
}

impl fmt::Display for WatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute { path } => {
                write!(formatter, "path must be absolute: {}", path.display())
            }
            Self::MissingParent { path } => {
                write!(
                    formatter,
                    "path has no parent directory: {}",
                    path.display()
                )
            }
            Self::UnknownConsumer { consumer_id } => {
                write!(formatter, "unknown watch consumer: {consumer_id}")
            }
            Self::Unavailable => write!(formatter, "file watching is unavailable"),
            Self::Notify { message } => write!(formatter, "watcher error: {message}"),
        }
    }
}

impl std::error::Error for WatchError {}

/// Collapses `.` and `..` components without touching the filesystem.
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
/// normalization otherwise (same discipline as the asset scope registry).
fn resolve(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| lexical_normalize(path))
}

/// Resolves a document path through its parent directory: documents are
/// watched via the (canonicalized) parent, and platform events report
/// children as `canonical-parent/name`, so keys must take the same form even
/// when the document itself does not exist yet.
fn resolve_document(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => resolve(parent).join(name),
        _ => resolve(path),
    }
}

/// A logical watched entity: an exact document path (`recursive == false`)
/// or a workspace root watched recursively.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WatchKey {
    pub path: PathBuf,
    pub recursive: bool,
}

/// The concrete notify watch target derived from a key. Documents are
/// watched through their parent directory (non-recursive) so that deletion
/// and recreation of the file are both observed; registry matching filters
/// sibling events back out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchTarget {
    pub path: PathBuf,
    pub recursive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquiredWatch {
    pub key: WatchKey,
    pub target: WatchTarget,
    pub newly_added: bool,
}

#[derive(Debug, Clone)]
struct WatchEntry {
    refs: usize,
    target: WatchTarget,
}

/// Reference-counted registry of watched paths, mirroring
/// `asset_scope::AssetScopeRegistry`: a watch disappears once its last
/// consumer releases it. Each entry remembers the exact notify target it
/// was created with so releases stop precisely what acquires started.
#[derive(Debug, Default)]
pub struct WatchRegistry {
    watches: HashMap<WatchKey, WatchEntry>,
    consumers: HashMap<String, Vec<WatchKey>>,
}

impl WatchRegistry {
    /// Watches one open document. `path` does not need to exist — missing
    /// documents are watched so their recreation is reported.
    pub fn watch_document(
        &mut self,
        consumer_id: &str,
        path: &Path,
    ) -> Result<AcquiredWatch, WatchError> {
        if !path.is_absolute() {
            return Err(WatchError::NotAbsolute {
                path: path.to_path_buf(),
            });
        }
        let parent = path.parent().ok_or_else(|| WatchError::MissingParent {
            path: path.to_path_buf(),
        })?;
        let target = WatchTarget {
            path: resolve(parent),
            recursive: false,
        };
        Ok(self.acquire(
            consumer_id,
            WatchKey {
                path: resolve_document(path),
                recursive: false,
            },
            target,
        ))
    }

    /// Watches a workspace root recursively.
    pub fn watch_workspace(
        &mut self,
        consumer_id: &str,
        root: &Path,
    ) -> Result<AcquiredWatch, WatchError> {
        if !root.is_absolute() {
            return Err(WatchError::NotAbsolute {
                path: root.to_path_buf(),
            });
        }
        let key = WatchKey {
            path: resolve(root),
            recursive: true,
        };
        let target = WatchTarget {
            path: key.path.clone(),
            recursive: true,
        };
        Ok(self.acquire(consumer_id, key, target))
    }

    fn acquire(&mut self, consumer_id: &str, key: WatchKey, target: WatchTarget) -> AcquiredWatch {
        let entry = self
            .watches
            .entry(key.clone())
            .or_insert_with(|| WatchEntry {
                refs: 0,
                target: target.clone(),
            });
        let newly_added = entry.refs == 0;
        entry.refs += 1;
        self.consumers
            .entry(consumer_id.to_string())
            .or_default()
            .push(key.clone());
        AcquiredWatch {
            key,
            target,
            newly_added,
        }
    }

    /// Removes one reference to `key`; returns the target to stop when the
    /// last reference disappeared.
    fn release_key(&mut self, key: &WatchKey) -> Option<WatchTarget> {
        let entry = self.watches.get_mut(key)?;
        entry.refs -= 1;
        if entry.refs == 0 {
            let entry = self.watches.remove(key)?;
            Some(entry.target)
        } else {
            None
        }
    }

    /// Releases one specific key for a consumer. Returns the target to stop
    /// when this release dropped the last reference.
    pub fn release_one(&mut self, consumer_id: &str, key: &WatchKey) -> Option<WatchTarget> {
        let keys = self.consumers.get_mut(consumer_id)?;
        let index = keys.iter().position(|candidate| candidate == key)?;
        keys.remove(index);
        if keys.is_empty() {
            self.consumers.remove(consumer_id);
        }
        self.release_key(key)
    }

    /// Releases every watch held by the consumer and returns the targets
    /// whose last reference disappeared.
    pub fn release_consumer(&mut self, consumer_id: &str) -> Result<Vec<WatchTarget>, WatchError> {
        let keys =
            self.consumers
                .remove(consumer_id)
                .ok_or_else(|| WatchError::UnknownConsumer {
                    consumer_id: consumer_id.to_string(),
                })?;
        let mut released = Vec::new();
        for key in keys {
            if let Some(target) = self.release_key(&key) {
                released.push(target);
            }
        }
        Ok(released)
    }

    /// Returns true when any active watch covers `path`: exact match for
    /// document watches, prefix match for recursive workspace watches.
    pub fn matches<P: AsRef<Path>>(&self, path: P) -> bool {
        let candidate = resolve(path.as_ref());
        self.watches.keys().any(|key| {
            if key.recursive {
                candidate.starts_with(&key.path)
            } else {
                candidate == key.path
            }
        })
    }
}

/// The on-disk state of a path at flush time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbedFile {
    pub modified_unix_ms: u128,
    pub version: String,
}

#[derive(Debug)]
struct PendingPath {
    path: PathBuf,
    deadline: Instant,
}

#[derive(Debug)]
struct PendingRename {
    from: PathBuf,
    to: PathBuf,
    deadline: Instant,
}

/// Debouncing/coalescing state machine. Pure: time is injected and the
/// filesystem is probed through a closure, so tests are deterministic.
#[derive(Debug)]
pub struct DebounceQueue {
    window: Duration,
    pending: Vec<PendingPath>,
    renames: Vec<PendingRename>,
}

impl DebounceQueue {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            pending: Vec::new(),
            renames: Vec::new(),
        }
    }

    pub fn push(&mut self, event: RawFsEvent, now: Instant) {
        match event {
            RawFsEvent::Modified(path) | RawFsEvent::Created(path) | RawFsEvent::Removed(path) => {
                if !self.pending.iter().any(|entry| entry.path == path) {
                    self.pending.push(PendingPath {
                        path,
                        deadline: now + self.window,
                    });
                }
            }
            RawFsEvent::Renamed { from, to } => {
                self.pending
                    .retain(|entry| entry.path != from && entry.path != to);
                if !self
                    .renames
                    .iter()
                    .any(|rename| rename.from == from && rename.to == to)
                {
                    self.renames.push(PendingRename {
                        from,
                        to,
                        deadline: now + self.window,
                    });
                }
            }
        }
    }

    /// Emits events whose debounce window has elapsed. Output order is
    /// deterministic: renames first (in arrival order), then single paths
    /// (in arrival order).
    pub fn collect(
        &mut self,
        now: Instant,
        mut probe: impl FnMut(&Path) -> Option<ProbedFile>,
    ) -> Vec<DiskEvent> {
        let mut events = Vec::new();
        let mut index = 0;
        while index < self.renames.len() {
            if now >= self.renames[index].deadline {
                let rename = self.renames.remove(index);
                if probe(&rename.to).is_some() {
                    events.push(DiskEvent::Moved {
                        from: rename.from,
                        to: rename.to,
                    });
                } else {
                    events.push(DiskEvent::Missing { path: rename.from });
                }
            } else {
                index += 1;
            }
        }
        let mut index = 0;
        while index < self.pending.len() {
            if now >= self.pending[index].deadline {
                let entry = self.pending.remove(index);
                match probe(&entry.path) {
                    Some(probed) => events.push(DiskEvent::Changed {
                        path: entry.path,
                        modified_unix_ms: probed.modified_unix_ms,
                        version: probed.version,
                    }),
                    None => events.push(DiskEvent::Missing { path: entry.path }),
                }
            } else {
                index += 1;
            }
        }
        events
    }
}

/// Abstraction over the platform watcher so target refcounting is testable
/// without real filesystem timing.
pub trait FsWatcher: Send {
    fn watch(&mut self, path: &Path, recursive: bool) -> Result<(), String>;
    fn unwatch(&mut self, path: &Path) -> Result<(), String>;
}

struct NotifyWatcher(notify::RecommendedWatcher);

impl FsWatcher for NotifyWatcher {
    fn watch(&mut self, path: &Path, recursive: bool) -> Result<(), String> {
        let mode = if recursive {
            notify::RecursiveMode::Recursive
        } else {
            notify::RecursiveMode::NonRecursive
        };
        self.0.watch(path, mode).map_err(|error| error.to_string())
    }

    fn unwatch(&mut self, path: &Path) -> Result<(), String> {
        self.0.unwatch(path).map_err(|error| error.to_string())
    }
}

#[derive(Debug)]
struct TargetState {
    refs: usize,
    recursive: bool,
}

fn probe_path(path: &Path) -> Option<ProbedFile> {
    document_io::probe_version(path)
        .ok()
        .map(|(modified_unix_ms, version)| ProbedFile {
            modified_unix_ms,
            version,
        })
}

fn spawn_dispatcher(
    receiver: Receiver<notify::Result<notify::Event>>,
    registry: Arc<Mutex<WatchRegistry>>,
    window: Duration,
    emit: impl Fn(DiskEvent) + Send + 'static,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut queue = DebounceQueue::new(window);
        loop {
            match receiver.recv_timeout(DISPATCH_TICK) {
                Ok(Ok(event)) => {
                    let now = Instant::now();
                    let registry = registry.lock().expect("watch registry poisoned");
                    for raw in raw_events(&event) {
                        let matched = match &raw {
                            RawFsEvent::Renamed { from, to } => {
                                registry.matches(from) || registry.matches(to)
                            }
                            RawFsEvent::Modified(path)
                            | RawFsEvent::Created(path)
                            | RawFsEvent::Removed(path) => registry.matches(path),
                        };
                        if matched {
                            queue.push(raw, now);
                        }
                    }
                }
                Ok(Err(error)) => log::warn!("file watcher error: {error}"),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            for event in queue.collect(Instant::now(), probe_path) {
                emit(event);
            }
        }
    })
}

/// One debounced watcher service. Consumers acquire document/workspace
/// watches; the underlying platform watch starts with the first consumer
/// and stops with the last. Normalized events are delivered through the
/// `emit` callback.
pub struct WatchService {
    registry: Arc<Mutex<WatchRegistry>>,
    watcher: Option<Box<dyn FsWatcher>>,
    targets: HashMap<PathBuf, TargetState>,
    dispatcher: Option<JoinHandle<()>>,
}

impl WatchService {
    /// Creates a service backed by the platform watcher. When watcher
    /// creation fails the service stays alive but unavailable, so watch
    /// commands return an error instead of crashing the app.
    pub fn new(window: Duration, emit: impl Fn(DiskEvent) + Send + 'static) -> Self {
        let registry = Arc::new(Mutex::new(WatchRegistry::default()));
        let (sender, receiver) = channel();
        match notify::recommended_watcher(move |result| {
            let _ = sender.send(result);
        }) {
            Ok(watcher) => {
                let dispatcher = spawn_dispatcher(receiver, Arc::clone(&registry), window, emit);
                Self {
                    registry,
                    watcher: Some(Box::new(NotifyWatcher(watcher))),
                    targets: HashMap::new(),
                    dispatcher: Some(dispatcher),
                }
            }
            Err(error) => {
                log::error!("file watching unavailable: {error}");
                Self {
                    registry,
                    watcher: None,
                    targets: HashMap::new(),
                    dispatcher: None,
                }
            }
        }
    }

    /// Test constructor: no platform watcher, no dispatcher thread.
    #[doc(hidden)]
    pub fn with_watcher(watcher: Box<dyn FsWatcher>) -> Self {
        Self {
            registry: Arc::new(Mutex::new(WatchRegistry::default())),
            watcher: Some(watcher),
            targets: HashMap::new(),
            dispatcher: None,
        }
    }

    pub fn watch_document(&mut self, consumer_id: &str, path: &Path) -> Result<(), WatchError> {
        let acquired = self
            .registry
            .lock()
            .expect("watch registry poisoned")
            .watch_document(consumer_id, path)?;
        if acquired.newly_added {
            self.add_target(&acquired.target, consumer_id, &acquired.key)?;
        }
        Ok(())
    }

    pub fn watch_workspace(&mut self, consumer_id: &str, root: &Path) -> Result<(), WatchError> {
        let acquired = self
            .registry
            .lock()
            .expect("watch registry poisoned")
            .watch_workspace(consumer_id, root)?;
        if acquired.newly_added {
            self.add_target(&acquired.target, consumer_id, &acquired.key)?;
        }
        Ok(())
    }

    /// Releases all watches held by the consumer.
    pub fn unwatch(&mut self, consumer_id: &str) -> Result<(), WatchError> {
        let released = self
            .registry
            .lock()
            .expect("watch registry poisoned")
            .release_consumer(consumer_id)?;
        for target in released {
            self.remove_target(&target);
        }
        Ok(())
    }

    /// Starts the platform watch for a newly added key. On failure the
    /// registry reference is released again so a failed acquire never leaks
    /// (same compensation discipline as `document_commands::acquire_scoped`).
    fn add_target(
        &mut self,
        target: &WatchTarget,
        consumer_id: &str,
        key: &WatchKey,
    ) -> Result<(), WatchError> {
        let result = self.try_add_target(target);
        if result.is_err() {
            let stale = self
                .registry
                .lock()
                .expect("watch registry poisoned")
                .release_one(consumer_id, key);
            if let Some(stale) = stale {
                self.remove_target(&stale);
            }
        }
        result
    }

    fn try_add_target(&mut self, target: &WatchTarget) -> Result<(), WatchError> {
        let watcher = self.watcher.as_mut().ok_or(WatchError::Unavailable)?;
        match self.targets.get_mut(&target.path) {
            Some(state) => {
                // A path watched both ways is watched recursively; the mode
                // is never downgraded while any reference remains. The ref
                // is counted before the upgrade so `add_target`'s failure
                // compensation decrements it back to the pre-acquire count.
                state.refs += 1;
                if target.recursive && !state.recursive {
                    watcher
                        .unwatch(&target.path)
                        .map_err(|message| WatchError::Notify { message })?;
                    if let Err(message) = watcher.watch(&target.path, true) {
                        // Restore the original non-recursive watch before
                        // failing, so the platform watch survives the
                        // upgrade for the existing consumers.
                        if let Err(rollback) = watcher.watch(&target.path, false) {
                            log::warn!(
                                "failed to restore non-recursive watch for {}: {rollback}",
                                target.path.display()
                            );
                        }
                        return Err(WatchError::Notify { message });
                    }
                    state.recursive = true;
                }
            }
            None => {
                watcher
                    .watch(&target.path, target.recursive)
                    .map_err(|message| WatchError::Notify { message })?;
                self.targets.insert(
                    target.path.clone(),
                    TargetState {
                        refs: 1,
                        recursive: target.recursive,
                    },
                );
            }
        }
        Ok(())
    }

    fn remove_target(&mut self, target: &WatchTarget) {
        let Some(state) = self.targets.get_mut(&target.path) else {
            return;
        };
        state.refs -= 1;
        if state.refs == 0 {
            self.targets.remove(&target.path);
            if let Some(watcher) = self.watcher.as_mut() {
                if let Err(message) = watcher.unwatch(&target.path) {
                    log::warn!(
                        "failed to stop watching {}: {message}",
                        target.path.display()
                    );
                }
            }
        }
    }

    #[cfg(test)]
    fn watched_targets(&self) -> Vec<(PathBuf, bool)> {
        let mut targets: Vec<_> = self
            .targets
            .iter()
            .map(|(path, state)| (path.clone(), state.recursive))
            .collect();
        targets.sort();
        targets
    }
}

impl Drop for WatchService {
    fn drop(&mut self) {
        // Dropping the watcher disconnects the event channel, which ends
        // the dispatcher loop.
        self.watcher.take();
        if let Some(dispatcher) = self.dispatcher.take() {
            let _ = dispatcher.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn key(path: &str, recursive: bool) -> WatchKey {
        WatchKey {
            path: PathBuf::from(path),
            recursive,
        }
    }

    #[test]
    fn document_watch_requires_an_absolute_path() {
        let mut registry = WatchRegistry::default();
        let error = registry
            .watch_document("tab-1", Path::new("notes/a.md"))
            .unwrap_err();
        assert_eq!(
            error,
            WatchError::NotAbsolute {
                path: PathBuf::from("notes/a.md")
            }
        );
    }

    #[test]
    fn document_watch_targets_the_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let document = dir.path().join("a.md");
        let mut registry = WatchRegistry::default();
        let acquired = registry.watch_document("tab-1", &document).unwrap();
        assert!(acquired.newly_added);
        assert_eq!(acquired.target.path, resolve(dir.path()));
        assert!(!acquired.target.recursive);
    }

    #[test]
    fn workspace_watch_targets_the_root_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = WatchRegistry::default();
        let acquired = registry.watch_workspace("ws", dir.path()).unwrap();
        assert!(acquired.newly_added);
        assert_eq!(acquired.target.path, resolve(dir.path()));
        assert!(acquired.target.recursive);
    }

    #[test]
    fn watches_are_reference_counted_per_consumer() {
        let mut registry = WatchRegistry::default();
        let first = registry
            .watch_document("tab-1", Path::new("/notes/a.md"))
            .unwrap();
        let second = registry
            .watch_document("tab-2", Path::new("/notes/a.md"))
            .unwrap();
        assert!(first.newly_added);
        assert!(!second.newly_added);

        let released = registry.release_consumer("tab-1").unwrap();
        assert!(released.is_empty(), "shared watch survives first release");
        assert!(registry.matches(Path::new("/notes/a.md")));

        let released = registry.release_consumer("tab-2").unwrap();
        assert_eq!(released.len(), 1);
        assert!(!registry.matches(Path::new("/notes/a.md")));
    }

    #[test]
    fn releasing_an_unknown_consumer_fails() {
        let mut registry = WatchRegistry::default();
        assert_eq!(
            registry.release_consumer("ghost"),
            Err(WatchError::UnknownConsumer {
                consumer_id: "ghost".into()
            })
        );
    }

    #[test]
    fn document_matching_is_exact_and_workspace_matching_is_recursive() {
        let mut registry = WatchRegistry::default();
        registry
            .watch_document("tab-1", Path::new("/notes/a.md"))
            .unwrap();
        registry.watch_workspace("ws", Path::new("/ws")).unwrap();

        assert!(registry.matches(Path::new("/notes/a.md")));
        assert!(!registry.matches(Path::new("/notes/b.md")));
        assert!(!registry.matches(Path::new("/notes/sub/a.md")));
        assert!(registry.matches(Path::new("/ws/deep/nested/x.md")));
        assert!(!registry.matches(Path::new("/wsx/a.md")));
    }

    #[test]
    fn release_one_removes_a_single_key() {
        let mut registry = WatchRegistry::default();
        registry
            .watch_document("tab-1", Path::new("/notes/a.md"))
            .unwrap();
        registry
            .watch_document("tab-1", Path::new("/notes/b.md"))
            .unwrap();

        let released = registry.release_one("tab-1", &key("/notes/a.md", false));
        assert!(released.is_some());
        assert!(registry.matches(Path::new("/notes/b.md")));
        assert!(!registry.matches(Path::new("/notes/a.md")));
        // The consumer still holds b.md, so a full release succeeds.
        assert!(registry.release_consumer("tab-1").is_ok());
    }

    fn probe_from(entries: &[(&str, Option<u128>)]) -> impl FnMut(&Path) -> Option<ProbedFile> {
        let table: HashMap<PathBuf, Option<u128>> = entries
            .iter()
            .map(|(path, ms)| (PathBuf::from(path), *ms))
            .collect();
        move |path| {
            table
                .get(path)
                .copied()
                .flatten()
                .map(|modified_unix_ms| ProbedFile {
                    modified_unix_ms,
                    version: format!("v{modified_unix_ms}"),
                })
        }
    }

    #[test]
    fn events_hold_until_the_window_elapses_then_report_disk_state() {
        let window = Duration::from_millis(100);
        let start = Instant::now();
        let mut queue = DebounceQueue::new(window);
        queue.push(RawFsEvent::Modified(PathBuf::from("/a.md")), start);

        let early = queue.collect(
            start + Duration::from_millis(50),
            probe_from(&[("/a.md", Some(7))]),
        );
        assert!(early.is_empty());

        let events = queue.collect(
            start + Duration::from_millis(100),
            probe_from(&[("/a.md", Some(7))]),
        );
        assert_eq!(
            events,
            vec![DiskEvent::Changed {
                path: PathBuf::from("/a.md"),
                modified_unix_ms: 7,
                version: "v7".into()
            }]
        );
    }

    #[test]
    fn bursts_for_one_path_coalesce_and_do_not_extend_the_deadline() {
        let window = Duration::from_millis(100);
        let start = Instant::now();
        let mut queue = DebounceQueue::new(window);
        for offset in [0, 40, 80, 95] {
            queue.push(
                RawFsEvent::Modified(PathBuf::from("/a.md")),
                start + Duration::from_millis(offset),
            );
        }
        let events = queue.collect(
            start + Duration::from_millis(100),
            probe_from(&[("/a.md", Some(3))]),
        );
        assert_eq!(events.len(), 1, "first-seen deadline prevents starvation");
    }

    #[test]
    fn delete_then_recreate_inside_one_window_reports_changed() {
        let window = Duration::from_millis(100);
        let start = Instant::now();
        let mut queue = DebounceQueue::new(window);
        queue.push(RawFsEvent::Removed(PathBuf::from("/a.md")), start);
        queue.push(
            RawFsEvent::Created(PathBuf::from("/a.md")),
            start + Duration::from_millis(10),
        );
        let events = queue.collect(start + window, probe_from(&[("/a.md", Some(9))]));
        assert_eq!(
            events,
            vec![DiskEvent::Changed {
                path: PathBuf::from("/a.md"),
                modified_unix_ms: 9,
                version: "v9".into()
            }]
        );
    }

    #[test]
    fn create_then_delete_inside_one_window_reports_missing() {
        let window = Duration::from_millis(100);
        let start = Instant::now();
        let mut queue = DebounceQueue::new(window);
        queue.push(RawFsEvent::Created(PathBuf::from("/a.md")), start);
        queue.push(
            RawFsEvent::Removed(PathBuf::from("/a.md")),
            start + Duration::from_millis(10),
        );
        let events = queue.collect(start + window, probe_from(&[("/a.md", None)]));
        assert_eq!(
            events,
            vec![DiskEvent::Missing {
                path: PathBuf::from("/a.md")
            }]
        );
    }

    #[test]
    fn renames_emit_moved_and_supersede_pending_entries() {
        let window = Duration::from_millis(100);
        let start = Instant::now();
        let mut queue = DebounceQueue::new(window);
        queue.push(RawFsEvent::Modified(PathBuf::from("/a.md")), start);
        queue.push(
            RawFsEvent::Renamed {
                from: PathBuf::from("/a.md"),
                to: PathBuf::from("/b.md"),
            },
            start,
        );
        // Duplicate delivery of the same rename (overlapping watches) dedups.
        queue.push(
            RawFsEvent::Renamed {
                from: PathBuf::from("/a.md"),
                to: PathBuf::from("/b.md"),
            },
            start,
        );
        let events = queue.collect(start + window, probe_from(&[("/b.md", Some(1))]));
        assert_eq!(
            events,
            vec![DiskEvent::Moved {
                from: PathBuf::from("/a.md"),
                to: PathBuf::from("/b.md")
            }]
        );
    }

    #[test]
    fn a_rename_whose_target_vanishes_reports_missing_for_the_source() {
        let window = Duration::from_millis(100);
        let start = Instant::now();
        let mut queue = DebounceQueue::new(window);
        queue.push(
            RawFsEvent::Renamed {
                from: PathBuf::from("/a.md"),
                to: PathBuf::from("/b.md"),
            },
            start,
        );
        let events = queue.collect(start + window, probe_from(&[("/b.md", None)]));
        assert_eq!(
            events,
            vec![DiskEvent::Missing {
                path: PathBuf::from("/a.md")
            }]
        );
    }

    #[derive(Default)]
    struct FakeWatcher {
        calls: Arc<StdMutex<Vec<(String, PathBuf, bool)>>>,
        fail_watch: bool,
        fail_recursive_watch: bool,
    }

    impl FakeWatcher {
        fn call_log(&self) -> std::sync::MutexGuard<'_, Vec<(String, PathBuf, bool)>> {
            self.calls.lock().unwrap()
        }
    }

    impl FsWatcher for FakeWatcher {
        fn watch(&mut self, path: &Path, recursive: bool) -> Result<(), String> {
            self.call_log()
                .push(("watch".into(), path.to_path_buf(), recursive));
            if recursive && self.fail_recursive_watch {
                return Err("simulated recursive watch failure".into());
            }
            if self.fail_watch {
                return Err("simulated watch failure".into());
            }
            Ok(())
        }

        fn unwatch(&mut self, path: &Path) -> Result<(), String> {
            self.call_log()
                .push(("unwatch".into(), path.to_path_buf(), false));
            Ok(())
        }
    }

    #[test]
    fn service_starts_and_stops_watches_with_consumer_lifetimes() {
        let dir = tempfile::tempdir().unwrap();
        let document = dir.path().join("a.md");
        let parent = resolve(dir.path());
        let watcher = Box::new(FakeWatcher::default());
        let mut service = WatchService::with_watcher(watcher);

        service.watch_document("tab-1", &document).unwrap();
        service.watch_document("tab-2", &document).unwrap();
        assert_eq!(service.watched_targets(), vec![(parent.clone(), false)]);

        service.unwatch("tab-1").unwrap();
        assert_eq!(service.watched_targets(), vec![(parent.clone(), false)]);

        service.unwatch("tab-2").unwrap();
        assert!(service.watched_targets().is_empty());
    }

    #[test]
    fn service_upgrades_a_target_to_recursive_when_a_workspace_arrives() {
        let dir = tempfile::tempdir().unwrap();
        let root = resolve(dir.path());
        let document = dir.path().join("a.md");
        let watcher = Box::new(FakeWatcher::default());
        let mut service = WatchService::with_watcher(watcher);

        service.watch_document("tab-1", &document).unwrap();
        service.watch_workspace("ws", dir.path()).unwrap();
        assert_eq!(service.watched_targets(), vec![(root.clone(), true)]);

        // Releasing the workspace keeps the document watch alive (still
        // recursive; the mode is never downgraded while referenced).
        service.unwatch("ws").unwrap();
        assert_eq!(service.watched_targets(), vec![(root.clone(), true)]);
        service.unwatch("tab-1").unwrap();
        assert!(service.watched_targets().is_empty());
    }

    #[test]
    fn a_failed_recursive_upgrade_keeps_refcounts_and_restores_the_watch() {
        let dir = tempfile::tempdir().unwrap();
        let root = resolve(dir.path());
        let document = dir.path().join("a.md");
        let fake = FakeWatcher {
            fail_recursive_watch: true,
            ..FakeWatcher::default()
        };
        let call_log = Arc::clone(&fake.calls);
        let mut service = WatchService::with_watcher(Box::new(fake));

        service.watch_document("tab-1", &document).unwrap();
        let error = service.watch_workspace("ws", dir.path()).unwrap_err();
        assert_eq!(
            error,
            WatchError::Notify {
                message: "simulated recursive watch failure".into()
            }
        );

        // The failed acquire was compensated and the original non-recursive
        // platform watch was restored: the target state is unchanged and the
        // workspace consumer no longer exists.
        assert_eq!(service.watched_targets(), vec![(root.clone(), false)]);
        assert_eq!(
            service.unwatch("ws"),
            Err(WatchError::UnknownConsumer {
                consumer_id: "ws".into()
            })
        );

        // No reference drift: releasing the document tears the watch down.
        service.unwatch("tab-1").unwrap();
        assert!(service.watched_targets().is_empty());

        // The upgrade unwatch + recursive watch attempt were rolled back to the
        // non-recursive mode the document consumer originally acquired, and
        // the final teardown unwatchs the restored watch.
        assert_eq!(
            *call_log.lock().unwrap(),
            vec![
                ("watch".into(), root.clone(), false),
                ("unwatch".into(), root.clone(), false),
                ("watch".into(), root.clone(), true),
                ("watch".into(), root.clone(), false),
                ("unwatch".into(), root.clone(), false),
            ]
        );
    }

    #[test]
    fn a_failed_platform_watch_releases_the_registry_reference() {
        let dir = tempfile::tempdir().unwrap();
        let document = dir.path().join("a.md");
        let watcher = Box::new(FakeWatcher {
            fail_watch: true,
            ..FakeWatcher::default()
        });
        let mut service = WatchService::with_watcher(watcher);

        let error = service.watch_document("tab-1", &document).unwrap_err();
        assert_eq!(
            error,
            WatchError::Notify {
                message: "simulated watch failure".into()
            }
        );
        // The compensation released the consumer, so a retry starts clean
        // and a release reports the consumer as unknown.
        assert_eq!(
            service.unwatch("tab-1"),
            Err(WatchError::UnknownConsumer {
                consumer_id: "tab-1".into()
            })
        );
    }

    #[test]
    fn unwatching_an_unknown_consumer_fails() {
        let watcher = Box::new(FakeWatcher::default());
        let mut service = WatchService::with_watcher(watcher);
        assert_eq!(
            service.unwatch("ghost"),
            Err(WatchError::UnknownConsumer {
                consumer_id: "ghost".into()
            })
        );
    }

    /// The only real-watcher timing test: a smoke check that the full
    /// pipeline (platform watcher → dispatcher → debounce → probe → emit)
    /// delivers events. Generous timeout keeps it stable on loaded machines.
    #[test]
    fn real_watcher_delivers_changed_and_missing_for_a_watched_document() {
        let dir = tempfile::tempdir().unwrap();
        let document = dir.path().join("note.md");
        std::fs::write(&document, "one").unwrap();

        let (sender, receiver) = channel();
        let mut service = WatchService::new(Duration::from_millis(50), move |event| {
            let _ = sender.send(event);
        });
        service.watch_document("tab-1", &document).unwrap();
        // FSEvents registers the stream asynchronously; give it a moment so
        // the very first modification is not lost.
        std::thread::sleep(Duration::from_millis(300));
        // Watcher events carry canonical paths (the watched parent is
        // canonicalized). Compute the expectation once, because after the
        // delete below the document itself can no longer be canonicalized.
        let watched_path = resolve(dir.path()).join("note.md");

        let wait_for = |predicate: &dyn Fn(&DiskEvent) -> bool| -> DiskEvent {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(
                    remaining > Duration::ZERO,
                    "timed out waiting for disk event"
                );
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(event) if predicate(&event) => return event,
                    Ok(_) => {}
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => panic!("dispatcher stopped"),
                }
            }
        };

        std::fs::write(&document, "two").unwrap();
        let (_, expected) = document_io::probe_version(&watched_path).unwrap();
        let changed = wait_for(&|event| {
            matches!(
                event,
                DiskEvent::Changed { path, version, .. }
                    if *path == watched_path && version == &expected
            )
        });
        match changed {
            DiskEvent::Changed { version, .. } => {
                assert_eq!(version, expected);
            }
            _ => unreachable!(),
        }

        std::fs::remove_file(&document).unwrap();
        wait_for(&|event| matches!(event, DiskEvent::Missing { path } if *path == watched_path));
    }
}
