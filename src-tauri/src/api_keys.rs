//! Translation API keys in the OS credential store.
//!
//! A key belongs to one *slot* — a provider preset id, or `custom` when no
//! preset matches the endpoint and model — and is addressed by that slot
//! alone: the frontend stores, probes, and deletes keys by slot and never gets
//! key material back, so a secret only exists in this backend (and in the
//! one-time migration request that carries it in).
//!
//! A slot either holds a key or it does not. Stored keys are trimmed of
//! surrounding whitespace, a blank one is rejected with `invalid-key:`, and
//! every reader treats a blank stored value as "no key" — so
//! `has_translation_key`, `translate_segments`, and the settings dialog's
//! "已保存" state can never disagree about whether a slot is configured.
//!
//! The store is the system credential store — macOS Keychain, Windows
//! Credential Manager, the Linux Secret Service, all through `keyring`, with
//! the bundle identifier as the service name and the slot as the account. Its
//! fallback, used only while that store cannot be reached at all (a Linux
//! session without a Secret Service provider, a locked keychain), is a JSON
//! file in the app data directory created owner-only (0600) — and
//! `translation_key_protection` reports `file` then, so the settings dialog
//! can say the keys are not protected by the OS. A store that answers but
//! refuses an operation is *not* downgraded silently; its error is reported.
//!
//! Reads recover in both directions. A slot written to the file during an
//! outage is still found after the system store comes back (the file is
//! consulted when the system store has no entry for the slot), and a
//! successful write to the system store deletes the now-stale file copy so a
//! later fallback can never resurrect a superseded key.
//!
//! Key material never appears in an error message, a log line, or a `Debug`
//! rendering: everything user-visible names the slot, the store, or the
//! platform's own description of the failure.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

/// Keyring service name for every entry this app writes: the bundle
/// identifier, so Keychain Access and Credential Manager list these entries
/// under a name the user recognizes.
pub const KEYRING_SERVICE: &str = "com.xiongweini.markdown-edit";

/// Slot holding the key of endpoints and models that match no provider
/// preset.
pub const CUSTOM_SLOT: &str = "custom";

/// The fallback store's file name inside the app data directory.
pub const FALLBACK_FILE_NAME: &str = "translation-keys.json";

/// Longest accepted slot id, matching `^[a-z0-9-]{1,64}$`.
const MAX_SLOT_LENGTH: usize = 64;

/// The account the reachability probe reads. Deliberately not a valid slot
/// (slots never contain `_`), so no user key can ever live there — the probe
/// only discovers whether the store answers.
const PROBE_SLOT: &str = "__probe__";

/// How well the store keys are written to is protected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyProtection {
    /// The OS credential store: macOS Keychain, Windows Credential Manager,
    /// or the Linux Secret Service.
    System,
    /// The owner-only file in the app data directory, used while the system
    /// store is unreachable.
    File,
}

impl KeyProtection {
    /// The string the IPC contract returns.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::File => "file",
        }
    }
}

/// Why one credential store could not serve a request. The distinction
/// decides the fallback: only a store that cannot be reached at all hands the
/// slot to the file, a store that answered and refused is reported.
#[derive(Debug)]
pub enum StoreError {
    /// The store is unreachable in this environment (no Secret Service
    /// provider, a keychain the platform refuses to open, …).
    Unavailable(String),
    /// The store exists but the operation failed.
    Failed(String),
}

impl StoreError {
    /// The store's own description of the failure; never key material.
    fn detail(&self) -> &str {
        match self {
            Self::Unavailable(detail) | Self::Failed(detail) => detail,
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(detail) => write!(formatter, "unavailable: {detail}"),
            Self::Failed(detail) => write!(formatter, "failed: {detail}"),
        }
    }
}

/// One place a slot's key can live. Implementations must keep key material
/// out of the errors they return.
pub trait KeyBackend: Send + Sync + 'static {
    /// How this store is named in user-visible messages ("the system
    /// credential store", "the key file at …").
    fn describe(&self) -> String;

    /// The key stored for `slot`, `None` when the store holds none.
    fn get(&self, slot: &str) -> Result<Option<String>, StoreError>;

    /// Stores (or replaces) `slot`'s key.
    fn store(&self, slot: &str, key: &str) -> Result<(), StoreError>;

    /// Removes `slot`'s key. Deleting a slot that holds no key succeeds.
    fn delete(&self, slot: &str) -> Result<(), StoreError>;
}

/// The system credential store. Which platform store this is was decided at
/// compile time by the `keyring` features in `Cargo.toml`: the Keychain on
/// macOS, Credential Manager on Windows, the Secret Service on Linux.
pub struct SystemKeyBackend;

impl SystemKeyBackend {
    fn entry(slot: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(KEYRING_SERVICE, slot).map_err(map_keyring_error)
    }
}

impl KeyBackend for SystemKeyBackend {
    fn describe(&self) -> String {
        "the system credential store".to_string()
    }

    fn get(&self, slot: &str) -> Result<Option<String>, StoreError> {
        match Self::entry(slot)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn store(&self, slot: &str, key: &str) -> Result<(), StoreError> {
        Self::entry(slot)?
            .set_password(key)
            .map_err(map_keyring_error)
    }

    fn delete(&self, slot: &str) -> Result<(), StoreError> {
        match Self::entry(slot)?.delete_credential() {
            // Deleting a slot that holds no key is a success, exactly like
            // deleting one that does.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

/// Maps a `keyring` failure onto the fallback decision. A store that cannot
/// be reached at all hands the slot to the file; a store that answered and
/// refused (`Invalid`, `TooLong`, `BadEncoding`, an ambiguous match) is a real
/// failure the caller must see.
fn map_keyring_error(error: keyring::Error) -> StoreError {
    match error {
        keyring::Error::NoStorageAccess(source) | keyring::Error::PlatformFailure(source) => {
            StoreError::Unavailable(source.to_string())
        }
        other => StoreError::Failed(other.to_string()),
    }
}

/// The fallback store: one JSON object mapping slot to key, kept in the app
/// data directory and written with the sibling-temp + fsync + rename
/// discipline the other stores use. The file is created owner-only (0600).
pub struct FileKeyBackend {
    path: PathBuf,
}

impl FileKeyBackend {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Reads the whole map. A missing file is an empty map; an unreadable
    /// payload is logged and treated the same way, so a corrupt file can
    /// never fail a translation.
    fn read(&self) -> Result<BTreeMap<String, String>, StoreError> {
        match fs::read(&self.path) {
            Ok(payload) => match serde_json::from_slice(&payload) {
                Ok(entries) => Ok(entries),
                Err(error) => {
                    log::warn!(
                        "ignoring unreadable translation key file {}: {error}",
                        self.path.display()
                    );
                    Ok(BTreeMap::new())
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(self.io_error(&error)),
        }
    }

    /// Replaces the file with `entries`, owner-only and atomically: the temp
    /// file is fsynced, renamed over the destination, and the directory is
    /// fsynced so the rename itself is durable.
    fn write(&self, entries: &BTreeMap<String, String>) -> Result<(), StoreError> {
        let Some(dir) = self.path.parent() else {
            return Err(StoreError::Failed(format!(
                "{} has no parent directory",
                self.path.display()
            )));
        };
        fs::create_dir_all(dir).map_err(|error| self.io_error(&error))?;
        let payload =
            serde_json::to_vec(entries).map_err(|error| StoreError::Failed(error.to_string()))?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(dir).map_err(|error| self.io_error(&error))?;
        temporary
            .write_all(&payload)
            .and_then(|()| temporary.as_file().sync_all())
            .map_err(|error| self.io_error(&error))?;
        temporary
            .persist(&self.path)
            .map_err(|error| self.io_error(&error.error))?;
        restrict_to_owner(&self.path)?;
        sync_directory(dir).map_err(|error| self.io_error(&error))
    }

    fn io_error(&self, error: &io::Error) -> StoreError {
        StoreError::Failed(format!("{}: {error}", self.path.display()))
    }
}

impl KeyBackend for FileKeyBackend {
    fn describe(&self) -> String {
        format!("the key file at {}", self.path.display())
    }

    fn get(&self, slot: &str) -> Result<Option<String>, StoreError> {
        let lock = file_lock(&self.path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(self.read()?.get(slot).cloned())
    }

    fn store(&self, slot: &str, key: &str) -> Result<(), StoreError> {
        let lock = file_lock(&self.path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut entries = self.read()?;
        entries.insert(slot.to_string(), key.to_string());
        self.write(&entries)
    }

    fn delete(&self, slot: &str) -> Result<(), StoreError> {
        let lock = file_lock(&self.path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut entries = self.read()?;
        if entries.remove(slot).is_none() {
            // Nothing stored: leave the file (and its mtime) alone.
            return Ok(());
        }
        self.write(&entries)
    }
}

/// The per-path lock a file operation must hold, so read-modify-write cycles
/// on one key file are serialized within this process: a key file holds every
/// slot, and the migration stores several slots in a row, so two racing
/// writes could otherwise drop each other's key. The entries live as long as
/// the process, so a returned handle stays valid.
fn file_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(locks.entry(path.to_path_buf()).or_default())
}

/// Makes the key file owner-readable only. `tempfile` creates it that way
/// already; setting it explicitly keeps the guarantee independent of the
/// platform's temp-file defaults, and re-applies it to a file that was
/// loosened by hand.
#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| StoreError::Failed(format!("{}: {error}", path.display())))
}

/// Windows protects the file through the user profile directory's ACLs;
/// there is no mode bit to set.
#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> Result<(), StoreError> {
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(dir: &Path) -> io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// Slot-addressable key storage: the system credential store, with the
/// app-data-directory file as its fallback.
pub struct ApiKeyStore {
    system: Box<dyn KeyBackend>,
    fallback: Box<dyn KeyBackend>,
}

impl ApiKeyStore {
    /// Builds a store from explicit backends. Tests inject fakes here, which
    /// is what keeps the suite off every real keychain.
    pub fn new(system: Box<dyn KeyBackend>, fallback: Box<dyn KeyBackend>) -> Self {
        Self { system, fallback }
    }

    /// The production store: the OS credential store, falling back to the key
    /// file in `data_dir` (the app data directory).
    pub fn for_app_data_dir(data_dir: &Path) -> Self {
        Self::new(
            Box::new(SystemKeyBackend),
            Box::new(FileKeyBackend::new(data_dir.join(FALLBACK_FILE_NAME))),
        )
    }

    /// The key stored for `slot`, or `None` when the slot holds no usable one
    /// (see `configured_key`: a blank value counts as none). The system store
    /// is asked first; the file is consulted when it is unreachable *or*
    /// simply has no entry, so a key written during an outage stays readable
    /// afterwards.
    pub fn get(&self, slot: &str) -> Result<Option<String>, String> {
        validate_slot(slot)?;
        match self.system.get(slot) {
            Ok(Some(key)) => Ok(configured_key(Some(key))),
            Ok(None) => self.fallback_get(slot),
            Err(StoreError::Unavailable(detail)) => {
                log::warn!(
                    "{} is unavailable ({detail}); reading slot {slot:?} from {}",
                    self.system.describe(),
                    self.fallback.describe()
                );
                self.fallback_get(slot)
            }
            Err(StoreError::Failed(detail)) => Err(format!(
                "key-store: {} failed: {detail}",
                self.system.describe()
            )),
        }
    }

    /// Whether `slot` holds a usable key. Kept next to `get` so the settings
    /// dialog's state and the translation commands can never disagree about
    /// what "configured" means; the key itself is never returned.
    pub fn has(&self, slot: &str) -> Result<bool, String> {
        Ok(self.get(slot)?.is_some())
    }

    fn fallback_get(&self, slot: &str) -> Result<Option<String>, String> {
        self.fallback
            .get(slot)
            .map(configured_key)
            .map_err(|error| failure_message(self.fallback.as_ref(), &error))
    }

    /// Stores `key` for `slot`, preferring the system store. Surrounding
    /// whitespace is trimmed off (a pasted key often carries a newline, which
    /// would corrupt the Authorization header), and a key that is blank after
    /// trimming is rejected: clearing a slot is what `delete` is for, and a
    /// store never holds a value no request could use.
    pub fn store(&self, slot: &str, key: &str) -> Result<(), String> {
        validate_slot(slot)?;
        let key = key.trim();
        if key.is_empty() {
            return Err(blank_key_error(slot));
        }
        match self.system.store(slot, key) {
            Ok(()) => {
                // The file copy is superseded now: leaving it behind would let
                // a later fallback read resurrect the old key.
                if let Err(error) = self.fallback.delete(slot) {
                    log::warn!("failed to drop the stale key-file copy of slot {slot:?}: {error}");
                }
                Ok(())
            }
            Err(StoreError::Unavailable(detail)) => {
                log::warn!(
                    "{} is unavailable ({detail}); storing slot {slot:?} in {}",
                    self.system.describe(),
                    self.fallback.describe()
                );
                self.fallback
                    .store(slot, key)
                    .map_err(|error| failure_message(self.fallback.as_ref(), &error))
            }
            Err(StoreError::Failed(detail)) => Err(format!(
                "key-store: {} failed: {detail}",
                self.system.describe()
            )),
        }
    }

    /// Removes `slot`'s key from both stores.
    pub fn delete(&self, slot: &str) -> Result<(), String> {
        validate_slot(slot)?;
        let mut failures = Vec::new();
        match self.system.delete(slot) {
            // A store that cannot be reached holds nothing this session can
            // clear; the file copy is all the user can see.
            Ok(()) | Err(StoreError::Unavailable(_)) => {}
            Err(error) => failures.push(failure_message(self.system.as_ref(), &error)),
        }
        if let Err(error) = self.fallback.delete(slot) {
            failures.push(failure_message(self.fallback.as_ref(), &error));
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    /// Where keys go right now. A probe read of a slot no key can occupy
    /// answers the question without writing anything: `system` while the OS
    /// store answers, `file` while it cannot be reached at all.
    pub fn protection(&self) -> KeyProtection {
        match self.system.get(PROBE_SLOT) {
            Err(StoreError::Unavailable(detail)) => {
                log::debug!(
                    "{} is unavailable ({detail}); keys use {}",
                    self.system.describe(),
                    self.fallback.describe()
                );
                KeyProtection::File
            }
            _ => KeyProtection::System,
        }
    }
}

/// The stored value of a slot, if it counts as a configured key. A blank or
/// whitespace-only value is a slot nobody filled in — whether it arrived
/// through a hand-edited key file or an interrupted migration — so every
/// reader (the translation commands, the settings dialog's "已保存" state)
/// agrees it is unset.
fn configured_key(stored: Option<String>) -> Option<String> {
    stored.filter(|key| !key.trim().is_empty())
}

/// A failure message that names the store without ever naming its contents.
fn failure_message(store: &dyn KeyBackend, error: &StoreError) -> String {
    format!("key-store: {} failed: {}", store.describe(), error.detail())
}

/// Slot names are provider preset ids plus `custom`. The shape is fixed by
/// the IPC contract, so a frontend bug cannot smuggle arbitrary strings into
/// credential-store account names.
pub fn validate_slot(slot: &str) -> Result<(), String> {
    let valid = slot == CUSTOM_SLOT
        || (!slot.is_empty()
            && slot.len() <= MAX_SLOT_LENGTH
            && slot
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
    if valid {
        return Ok(());
    }
    // The rejected slot is echoed back (truncated) so the caller can see which
    // one it was; a slot is an identifier, never key material.
    let shown: String = slot.chars().take(MAX_SLOT_LENGTH).collect();
    Err(format!(
        "invalid-slot: {shown:?} must be \"custom\" or 1-{MAX_SLOT_LENGTH} characters of a-z, 0-9, or -"
    ))
}

/// The API key of `slot`, or the structured error the frontend matches on
/// when the slot holds none. Blank keys are absent keys — `get` never reports
/// one — so this and `ApiKeyStore::has` always agree.
pub fn key_for_slot(store: &ApiKeyStore, slot: &str) -> Result<String, String> {
    store.get(slot)?.ok_or_else(|| missing_key_error(slot))
}

/// The error a command returns when a slot has no key. The stable prefix is
/// part of the IPC contract; the frontend turns it into "configure an API key
/// first".
pub fn missing_key_error(slot: &str) -> String {
    format!("missing-key: no API key stored for slot {slot:?}")
}

/// The error a blank key is rejected with. Storing one is a caller bug — the
/// settings dialog's clear button calls `delete_translation_key` — and
/// silently dropping the slot's key instead would turn a stale form value
/// into a surprise delete.
fn blank_key_error(slot: &str) -> String {
    format!(
        "invalid-key: the API key for slot {slot:?} is blank; use delete_translation_key to clear a slot"
    )
}

/// The store the app uses, with the app data directory resolved.
pub fn store_for_app(app: &tauri::AppHandle) -> Result<ApiKeyStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("key-store: the app data directory is unavailable: {error}"))?;
    Ok(ApiKeyStore::for_app_data_dir(&data_dir))
}

/// Runs one credential-store operation on a blocking thread. The Linux Secret
/// Service backend is a blocking wrapper around its own D-Bus runtime: it must
/// not run on the main thread, and it must not occupy an async worker either,
/// so every call goes through the blocking pool.
pub async fn run_store<T, F>(operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("key-store: the credential task failed: {error}"))?
}

/// Stores (or replaces) `slot`'s key. This is the only place key material
/// enters the backend: everything else is addressed by slot. Surrounding
/// whitespace is trimmed and a blank key is rejected (`invalid-key:`), so the
/// store can never hold a value that `has_translation_key` would report as
/// present while translation reports it missing.
#[tauri::command]
pub async fn store_translation_key(
    app: tauri::AppHandle,
    slot: String,
    key: String,
) -> Result<(), String> {
    let store = store_for_app(&app)?;
    run_store(move || store.store(&slot, &key)).await
}

/// Removes `slot`'s key, from the system store and from the fallback file.
#[tauri::command]
pub async fn delete_translation_key(app: tauri::AppHandle, slot: String) -> Result<(), String> {
    let store = store_for_app(&app)?;
    run_store(move || store.delete(&slot)).await
}

/// Whether `slot` holds a key. The key itself is never returned, and a blank
/// stored value counts as no key — the same answer `translate_segments` and
/// `list_translation_models` reach when they look the slot up.
#[tauri::command]
pub async fn has_translation_key(app: tauri::AppHandle, slot: String) -> Result<bool, String> {
    let store = store_for_app(&app)?;
    run_store(move || store.has(&slot)).await
}

/// Whether keys are protected by the OS credential store (`system`) or by the
/// owner-only fallback file (`file`).
#[tauri::command]
pub async fn translation_key_protection(app: tauri::AppHandle) -> Result<String, String> {
    let store = store_for_app(&app)?;
    run_store(move || Ok(store.protection().as_str().to_string())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A credential store the tests drive directly: an in-memory map plus the
    /// failure the next call must report. Nothing in this suite touches a real
    /// keychain — CI has no Secret Service, and a developer machine's login
    /// keychain must stay untouched by the tests.
    struct FakeBackend {
        entries: Arc<Mutex<BTreeMap<String, String>>>,
        failure: Arc<Mutex<Option<Failure>>>,
    }

    /// A canned failure mode for a fake backend.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Failure {
        Unavailable,
        Failed,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                entries: Arc::new(Mutex::new(BTreeMap::new())),
                failure: Arc::new(Mutex::new(None)),
            }
        }

        fn holding(slot: &str, key: &str) -> Self {
            let backend = Self::new();
            backend
                .entries
                .lock()
                .unwrap()
                .insert(slot.to_string(), key.to_string());
            backend
        }

        /// A second handle on the same store, so a test can hand the store to
        /// an `ApiKeyStore` and still inspect what landed in it.
        fn handle(&self) -> Self {
            Self {
                entries: Arc::clone(&self.entries),
                failure: Arc::clone(&self.failure),
            }
        }

        fn fail_with(&self, failure: Failure) {
            *self.failure.lock().unwrap() = Some(failure);
        }

        /// The store is reachable again (or, in one fake, usable again).
        fn recover(&self) {
            *self.failure.lock().unwrap() = None;
        }

        fn stored(&self, slot: &str) -> Option<String> {
            self.entries.lock().unwrap().get(slot).cloned()
        }

        fn failure(&self) -> Option<StoreError> {
            self.failure.lock().unwrap().map(|failure| match failure {
                Failure::Unavailable => StoreError::Unavailable("no store here".into()),
                Failure::Failed => StoreError::Failed("the store refused".into()),
            })
        }
    }

    impl KeyBackend for FakeBackend {
        fn describe(&self) -> String {
            "the fake store".to_string()
        }

        fn get(&self, slot: &str) -> Result<Option<String>, StoreError> {
            if let Some(error) = self.failure() {
                return Err(error);
            }
            Ok(self.stored(slot))
        }

        fn store(&self, slot: &str, key: &str) -> Result<(), StoreError> {
            if let Some(error) = self.failure() {
                return Err(error);
            }
            self.entries
                .lock()
                .unwrap()
                .insert(slot.to_string(), key.to_string());
            Ok(())
        }

        fn delete(&self, slot: &str) -> Result<(), StoreError> {
            if let Some(error) = self.failure() {
                return Err(error);
            }
            self.entries.lock().unwrap().remove(slot);
            Ok(())
        }
    }

    const KEY: &str = "sk-test-0123456789";

    fn store_with(system: FakeBackend, fallback: FileKeyBackend) -> ApiKeyStore {
        ApiKeyStore::new(Box::new(system), Box::new(fallback))
    }

    fn file_backend(dir: &Path) -> FileKeyBackend {
        FileKeyBackend::new(dir.join(FALLBACK_FILE_NAME))
    }

    #[test]
    fn slot_validation_accepts_custom_and_lowercase_ids() {
        for allowed in [CUSTOM_SLOT, "zhipu", "glm-4-flash", "a", &"x".repeat(64)] {
            assert!(
                validate_slot(allowed).is_ok(),
                "{allowed:?} must be allowed"
            );
        }
    }

    #[test]
    fn slot_validation_rejects_other_shapes() {
        for rejected in [
            "",
            "Custom",
            "custom ",
            "a_b",
            "dot.name",
            "路径",
            &"x".repeat(65),
            // The probe slot must never be addressable, or a stored key could
            // shadow the reachability probe.
            PROBE_SLOT,
        ] {
            let error = validate_slot(rejected).expect_err("must be rejected");
            assert!(error.starts_with("invalid-slot: "), "{error}");
        }
    }

    #[test]
    fn file_backend_round_trips_keys_and_keeps_the_file_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let backend = file_backend(dir.path());

        assert_eq!(backend.get("custom").unwrap(), None);
        backend.store("custom", KEY).unwrap();
        backend.store("zhipu", "sk-second").unwrap();
        assert_eq!(backend.get("custom").unwrap(), Some(KEY.to_string()));
        assert_eq!(backend.get("zhipu").unwrap(), Some("sk-second".to_string()));

        backend.delete("custom").unwrap();
        assert_eq!(backend.get("custom").unwrap(), None);
        // Deleting the other slot must not disturb this one.
        assert_eq!(backend.get("zhipu").unwrap(), Some("sk-second".to_string()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(FALLBACK_FILE_NAME))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "key file must stay owner-only");
        }
    }

    #[test]
    fn file_backend_treats_a_missing_or_corrupt_file_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let backend = file_backend(dir.path());
        assert_eq!(backend.get("custom").unwrap(), None);

        fs::write(dir.path().join(FALLBACK_FILE_NAME), b"{ not json").unwrap();
        assert_eq!(backend.get("custom").unwrap(), None);
        // It is recoverable: the next write replaces the unreadable payload.
        backend.store("custom", KEY).unwrap();
        assert_eq!(backend.get("custom").unwrap(), Some(KEY.to_string()));
    }

    #[test]
    fn deleting_an_unknown_slot_never_creates_the_file() {
        let dir = tempfile::tempdir().unwrap();
        file_backend(dir.path()).delete("custom").unwrap();
        assert!(!dir.path().join(FALLBACK_FILE_NAME).exists());
    }

    #[test]
    fn storing_prefers_the_system_store_and_drops_the_stale_file_copy() {
        let dir = tempfile::tempdir().unwrap();
        let system = FakeBackend::new();
        // A key written while the system store was down.
        file_backend(dir.path())
            .store("custom", "sk-stale")
            .unwrap();
        let store = store_with(system.handle(), file_backend(dir.path()));

        store.store("custom", KEY).unwrap();

        assert_eq!(system.stored("custom"), Some(KEY.to_string()));
        assert_eq!(
            file_backend(dir.path()).get("custom").unwrap(),
            None,
            "the superseded file copy must be gone"
        );
    }

    #[test]
    fn a_stale_file_copy_never_shadows_the_system_store() {
        let dir = tempfile::tempdir().unwrap();
        file_backend(dir.path())
            .store("custom", "sk-stale")
            .unwrap();
        let store = store_with(
            FakeBackend::holding("custom", KEY),
            file_backend(dir.path()),
        );

        store.store("custom", "sk-new").unwrap();

        assert_eq!(store.get("custom").unwrap(), Some("sk-new".to_string()));
        assert_eq!(
            file_backend(dir.path()).get("custom").unwrap(),
            None,
            "the superseded file copy must be gone"
        );
    }

    #[test]
    fn an_unreachable_system_store_stores_and_reads_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let system = FakeBackend::new();
        system.fail_with(Failure::Unavailable);
        let store = store_with(system, file_backend(dir.path()));

        store.store("custom", KEY).unwrap();

        assert_eq!(
            file_backend(dir.path()).get("custom").unwrap(),
            Some(KEY.to_string())
        );
        assert_eq!(store.get("custom").unwrap(), Some(KEY.to_string()));
    }

    #[test]
    fn a_key_written_during_an_outage_survives_the_system_store_returning() {
        let dir = tempfile::tempdir().unwrap();
        let system = FakeBackend::new();
        system.fail_with(Failure::Unavailable);
        let store = store_with(system.handle(), file_backend(dir.path()));
        store.store("custom", KEY).unwrap();

        // The system store answers again, empty — the file copy is still the
        // only place the key exists, and it must be found.
        system.recover();
        assert_eq!(store.get("custom").unwrap(), Some(KEY.to_string()));
    }

    #[test]
    fn a_store_that_answered_and_refused_is_reported_instead_of_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let system = FakeBackend::new();
        system.fail_with(Failure::Failed);
        let store = store_with(system, file_backend(dir.path()));

        let error = store.store("custom", KEY).expect_err("must fail");
        assert!(error.starts_with("key-store: "), "{error}");
        assert_eq!(
            file_backend(dir.path()).get("custom").unwrap(),
            None,
            "a refused write must never land in the plaintext file"
        );
    }

    #[test]
    fn delete_clears_both_stores_and_tolerates_an_unreachable_one() {
        let dir = tempfile::tempdir().unwrap();
        let system = FakeBackend::holding("custom", KEY);
        file_backend(dir.path())
            .store("custom", "sk-stale")
            .unwrap();
        let store = store_with(system, file_backend(dir.path()));

        store.delete("custom").unwrap();
        assert_eq!(store.get("custom").unwrap(), None);
        assert_eq!(
            file_backend(dir.path()).get("custom").unwrap(),
            None,
            "the fallback copy must be deleted too"
        );

        // With the system store unreachable, deleting still clears the file
        // and reports success: there is nothing the user could clear there.
        let dir = tempfile::tempdir().unwrap();
        file_backend(dir.path()).store("custom", KEY).unwrap();
        let system = FakeBackend::new();
        system.fail_with(Failure::Unavailable);
        let store = store_with(system, file_backend(dir.path()));
        store.delete("custom").unwrap();
        assert_eq!(file_backend(dir.path()).get("custom").unwrap(), None);
    }

    #[test]
    fn protection_follows_the_system_store() {
        let dir = tempfile::tempdir().unwrap();
        let system = FakeBackend::new();
        let store = store_with(system, file_backend(dir.path()));
        assert_eq!(store.protection(), KeyProtection::System);
        assert_eq!(store.protection().as_str(), "system");

        let unreachable = FakeBackend::new();
        unreachable.fail_with(Failure::Unavailable);
        let store = store_with(unreachable, file_backend(dir.path()));
        assert_eq!(store.protection(), KeyProtection::File);
        assert_eq!(store.protection().as_str(), "file");
    }

    #[test]
    fn key_for_slot_reports_the_structured_missing_key_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(FakeBackend::new(), file_backend(dir.path()));

        let error = key_for_slot(&store, CUSTOM_SLOT).expect_err("no key stored");
        assert_eq!(error, "missing-key: no API key stored for slot \"custom\"");
        assert!(error.starts_with("missing-key: "));

        store.store(CUSTOM_SLOT, KEY).unwrap();
        assert_eq!(key_for_slot(&store, CUSTOM_SLOT).unwrap(), KEY);
    }

    #[test]
    fn blank_keys_are_rejected_and_keys_are_stored_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(FakeBackend::new(), file_backend(dir.path()));

        for blank in ["", "   ", "\n\t "] {
            let error = store
                .store(CUSTOM_SLOT, blank)
                .expect_err("a blank key is not a key");
            assert!(error.starts_with("invalid-key: "), "{error}");
        }
        // The rejected writes left nothing behind — not even the key file.
        assert_eq!(store.get(CUSTOM_SLOT).unwrap(), None);
        assert!(!store.has(CUSTOM_SLOT).unwrap());
        assert!(!dir.path().join(FALLBACK_FILE_NAME).exists());

        // A key pasted with a stray newline is stored without it: the value
        // goes into an Authorization header verbatim.
        store.store(CUSTOM_SLOT, "  sk-trimmed\n").unwrap();
        assert_eq!(
            store.get(CUSTOM_SLOT).unwrap(),
            Some("sk-trimmed".to_string())
        );
        assert!(store.has(CUSTOM_SLOT).unwrap());
    }

    #[test]
    fn a_blank_stored_value_counts_as_no_key_everywhere() {
        let dir = tempfile::tempdir().unwrap();
        // Written around the store's own guard, the way a hand-edited key file
        // or an older build could have left it.
        file_backend(dir.path()).store(CUSTOM_SLOT, "   ").unwrap();
        let store = store_with(FakeBackend::new(), file_backend(dir.path()));

        assert_eq!(store.get(CUSTOM_SLOT).unwrap(), None);
        assert!(!store.has(CUSTOM_SLOT).unwrap());
        assert!(key_for_slot(&store, CUSTOM_SLOT)
            .expect_err("blank is not a key")
            .starts_with("missing-key: "));
    }

    #[test]
    fn key_for_slot_rejects_an_unknown_slot_before_reading_anything() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(FakeBackend::new(), file_backend(dir.path()));
        let error = key_for_slot(&store, "Not A Slot").expect_err("must be rejected");
        assert!(error.starts_with("invalid-slot: "), "{error}");
    }

    #[test]
    fn keyring_failures_map_to_availability() {
        let platform = || {
            keyring::Error::PlatformFailure(Box::new(io::Error::new(
                io::ErrorKind::NotFound,
                "no secret service",
            )))
        };
        assert!(matches!(
            map_keyring_error(platform()),
            StoreError::Unavailable(_)
        ));
        assert!(matches!(
            map_keyring_error(keyring::Error::NoStorageAccess(Box::new(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "locked",
            )))),
            StoreError::Unavailable(_)
        ));
        assert!(matches!(
            map_keyring_error(keyring::Error::Invalid("slot".into(), "empty".into())),
            StoreError::Failed(_)
        ));
        assert!(matches!(
            map_keyring_error(keyring::Error::TooLong("password".into(), 4096)),
            StoreError::Failed(_)
        ));
    }

    #[test]
    fn store_operations_run_off_the_calling_thread() {
        // The blocking hop is what keeps the Linux Secret Service backend off
        // the main thread; a panicking operation must come back as an error
        // rather than taking the caller down with it.
        let value = tauri::async_runtime::block_on(run_store(|| Ok(7))).unwrap();
        assert_eq!(value, 7);

        let error = tauri::async_runtime::block_on(run_store(|| -> Result<(), String> {
            panic!("the store backend panicked")
        }))
        .unwrap_err();
        assert!(error.starts_with("key-store: "), "{error}");
    }

    #[test]
    fn no_error_message_carries_key_material() {
        const SENTINEL: &str = "sk-sentinel-must-not-be-logged";
        let dir = tempfile::tempdir().unwrap();

        // A store that answered and refused, with the sentinel as the value.
        let system = FakeBackend::new();
        system.fail_with(Failure::Failed);
        let refusing = store_with(system, file_backend(dir.path()));
        let mut messages = vec![refusing
            .store("custom", SENTINEL)
            .expect_err("the system store refuses")];

        // A fallback path that cannot be written at all, with the sentinel as
        // the value again.
        let blocked = tempfile::tempdir().unwrap();
        fs::create_dir(blocked.path().join(FALLBACK_FILE_NAME)).unwrap();
        let system = FakeBackend::new();
        system.fail_with(Failure::Unavailable);
        let store = store_with(system, file_backend(blocked.path()));
        messages.push(
            store
                .store("custom", SENTINEL)
                .expect_err("the key file is a directory"),
        );
        messages.push(key_for_slot(&store, "custom").expect_err("no key stored"));

        for message in messages {
            assert!(
                !message.contains(SENTINEL),
                "error message leaked key material: {message}"
            );
        }
    }
}
