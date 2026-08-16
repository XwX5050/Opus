//! Document translation through an OpenAI-compatible chat completions API.
//!
//! The frontend splits a document into translatable segments and sends one
//! segment per request; each translation is a single chat completion whose
//! user message is the raw segment text, and the model's plain-text answer is
//! the translation — no JSON envelope to parse and no result count to
//! validate. Results are cached on disk per segment so re-translating an
//! unchanged document never calls the provider again. Cache writes reuse the
//! sibling-temp + rename + directory-fsync discipline from `recovery`, and
//! corrupt or missing entries are always treated as misses so a bad write can
//! never fail a translation.
//!
//! The same endpoint also powers the settings dialog's model picker and
//! connection check: `list_translation_models` fetches `GET {endpoint}/models`
//! and returns the advertised model ids, sorted.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::Manager;

/// Provider settings persisted from the settings dialog. Field names are
/// snake_case on the Rust side; serde maps them from the frontend's camelCase
/// `TranslationSettings`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSettings {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub target_language: String,
}

/// One cached translation, stored as `<cache-key>.json` with this shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedTranslation {
    pub translated: String,
}

#[derive(Debug)]
pub enum TranslateError {
    /// The endpoint is not a valid URL or is not allowed to carry API keys.
    InvalidEndpoint { endpoint: String, reason: String },
    /// The HTTP request could not be sent (network, TLS, timeout, …).
    Request { source: reqwest::Error },
    /// The provider answered with a non-success status code.
    ResponseStatus {
        status: reqwest::StatusCode,
        body: String,
    },
    /// The provider's payload could not be decoded into translations.
    BadResponse { detail: String },
}

impl fmt::Display for TranslateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEndpoint { endpoint, reason } => {
                write!(
                    formatter,
                    "translation endpoint {endpoint:?} is not allowed: {reason}"
                )
            }
            Self::Request { source } => write!(formatter, "translation request failed: {source}"),
            Self::ResponseStatus { status, body } => {
                let body: String = body.chars().take(500).collect();
                write!(
                    formatter,
                    "translation provider returned HTTP {status}: {body}"
                )
            }
            Self::BadResponse { detail } => {
                write!(
                    formatter,
                    "unexpected translation provider response: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for TranslateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Request { source } => Some(source),
            _ => None,
        }
    }
}

/// Translation requests carry API keys and document content, so plaintext
/// endpoints are refused except for loopback hosts (tests and local proxies
/// such as Ollama).
pub fn validate_endpoint(endpoint: &str) -> Result<(), TranslateError> {
    let url = reqwest::Url::parse(endpoint).map_err(|error| TranslateError::InvalidEndpoint {
        endpoint: endpoint.to_string(),
        reason: format!("invalid URL: {error}"),
    })?;
    match url.scheme() {
        "https" => Ok(()),
        // host_str() keeps IPv6 in bracketed form on the url crate in the
        // tree, so both spellings are accepted.
        "http" => {
            let host = url.host_str().unwrap_or_default();
            let loopback =
                host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]";
            if loopback {
                Ok(())
            } else {
                Err(TranslateError::InvalidEndpoint {
                    endpoint: endpoint.to_string(),
                    reason: "plaintext http is allowed only for loopback hosts".into(),
                })
            }
        }
        scheme => Err(TranslateError::InvalidEndpoint {
            endpoint: endpoint.to_string(),
            reason: format!("scheme {scheme:?} is not supported (use https)"),
        }),
    }
}

/// Per-segment translation cache in a dedicated directory; each entry is one
/// JSON file named after the sha256 of the cache key.
pub struct TranslationCache {
    dir: PathBuf,
}

/// Cap on the number of cache entries kept before the oldest ones are
/// evicted. The cache is derived from live documents, so it never needs to be
/// unbounded; the sweep keeps a long-running install from growing forever.
pub const CACHE_ENTRY_LIMIT: usize = 5000;

/// How old the previous prune scan must be before the cache directory is
/// scanned again. The sweep is throttled so per-command calls do not pay for a
/// `read_dir` of the whole cache on every translation.
const CACHE_PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Last prune-scan time per cache directory, shared process-wide so the
/// throttle survives individual `TranslationCache` instances (one is created
/// per command call).
static LAST_CACHE_PRUNE: OnceLock<Mutex<HashMap<PathBuf, SystemTime>>> = OnceLock::new();

impl TranslationCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Derives the cache key for a segment: sha256 of model, target language,
    /// and the segment itself, so switching any of them starts a fresh set of
    /// entries. Keys are only ever produced here; callers must not hand
    /// arbitrary strings to `get`/`store`.
    pub fn cache_key(model: &str, target_language: &str, segment: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(model.as_bytes());
        hasher.update(b"\n");
        hasher.update(target_language.as_bytes());
        hasher.update(b"\n");
        hasher.update(segment.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    fn entry_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    /// Reads a cached translation; missing or corrupt entries are misses.
    pub fn get(&self, key: &str) -> Option<String> {
        let bytes = fs::read(self.entry_path(key)).ok()?;
        let entry: CachedTranslation = serde_json::from_slice(&bytes).ok()?;
        Some(entry.translated)
    }

    /// Stores a translation atomically: write a sibling temp file, fsync it,
    /// rename over the destination, then fsync the directory so the rename
    /// itself is durable (same discipline as recovery drafts).
    pub fn store(&self, key: &str, translated: &str) -> Result<(), io::Error> {
        fs::create_dir_all(&self.dir)?;
        let payload = serde_json::to_vec(&CachedTranslation {
            translated: translated.to_string(),
        })?;
        let destination = self.entry_path(key);
        let mut temporary = tempfile::NamedTempFile::new_in(&self.dir)?;
        temporary.write_all(&payload)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .map_err(|error| error.error)?;
        fs::File::open(&self.dir)?.sync_all()?;
        Ok(())
    }

    /// Evicts the oldest cache entries once the directory holds more than
    /// `CACHE_ENTRY_LIMIT` `.json` files, restoring the count to the limit.
    /// Scans at most once per `CACHE_PRUNE_INTERVAL` per cache directory: the
    /// wall-clock check happens up front so the directory is only read when
    /// the previous scan is stale. Eviction is best-effort — read and remove
    /// failures are logged, never surfaced — because a cache prune must not
    /// break a translation.
    pub fn prune_if_due(&self) {
        let now = SystemTime::now();
        let mut last_scans = LAST_CACHE_PRUNE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = last_scans.get(&self.dir) {
            if now.duration_since(*previous).unwrap_or_default() < CACHE_PRUNE_INTERVAL {
                return;
            }
        }
        // Record the scan before doing it, so a failed sweep still counts as
        // attempted and the next one waits out the interval.
        last_scans.insert(self.dir.clone(), now);
        drop(last_scans);
        if let Err(error) = self.evict_oldest_entries(CACHE_ENTRY_LIMIT) {
            log::warn!(
                "failed to prune translation cache {}: {error}",
                self.dir.display()
            );
        }
    }

    /// Removes the oldest `.json` entries (by modification time) until at
    /// most `entry_limit` remain, returning how many were removed. Only files
    /// with a `.json` extension are considered; anything else in the
    /// directory is left untouched. A missing cache directory is a no-op.
    fn evict_oldest_entries(&self, entry_limit: usize) -> Result<usize, io::Error> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let mut candidates: Vec<(PathBuf, SystemTime)> = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    return None;
                }
                Some((path, entry.metadata().ok()?.modified().ok()?))
            })
            .collect();
        if candidates.len() <= entry_limit {
            return Ok(0);
        }
        // Sort by mtime ascending; the stable sort keeps the removal order
        // deterministic when timestamps tie.
        candidates.sort_by_key(|(_, modified)| *modified);
        let remove_count = candidates.len() - entry_limit;
        let mut removed = 0;
        for (path, _) in candidates.into_iter().take(remove_count) {
            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(error) => {
                    log::warn!(
                        "failed to remove stale translation cache entry {}: {error}",
                        path.display()
                    )
                }
            }
        }
        Ok(removed)
    }
}

/// The system prompt asks for one plain-text translation of the user's
/// message; Markdown structure and inline syntax survive the round trip.
fn system_prompt(target_language: &str) -> String {
    format!(
        "You are a professional translator. Translate the user's text into \
         {target_language}. Write natural, fluent prose the way a native \
         speaker would; avoid stiff word-for-word literal translation and \
         preserve the tone of the original. Keep all Markdown syntax, inline \
         code, inline and block math ($...$ and $$...$$), URLs, and HTML \
         tags exactly as they appear, and do not translate code or formula \
         content. Preserve the original line-break structure when the input \
         spans multiple lines. Output only the translation: no explanations, \
         no surrounding quotes, no prefixes or suffixes."
    )
}

/// The chat completions body: model plus a system prompt and the segment to
/// translate as the user message.
fn build_chat_body(model: &str, target_language: &str, segment: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": system_prompt(target_language),
            },
            {
                "role": "user",
                "content": segment,
            },
        ],
    })
}

/// Translates one segment in a single chat completions request and returns
/// the model's plain-text answer with stray surrounding whitespace trimmed.
/// The response is not parsed further: whatever the model writes for this one
/// segment is the translation, so a reply that splits the input into several
/// sentences or paragraphs still counts as a single result.
async fn translate_segment(
    client: &reqwest::Client,
    settings: &TranslationSettings,
    segment: &str,
) -> Result<String, TranslateError> {
    let url = format!(
        "{}/chat/completions",
        settings.endpoint.trim_end_matches('/')
    );
    let body = build_chat_body(&settings.model, &settings.target_language, segment);
    let response = client
        .post(&url)
        .bearer_auth(&settings.api_key)
        .json(&body)
        // The client is shared process-wide, so the command's budget lives on
        // the request instead of the client. A long translation may stream for
        // a while, hence the generous timeout.
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|source| TranslateError::Request { source })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(TranslateError::ResponseStatus { status, body });
    }
    let payload: serde_json::Value =
        response
            .json()
            .await
            .map_err(|source| TranslateError::BadResponse {
                detail: format!("response JSON is invalid: {source}"),
            })?;
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| TranslateError::BadResponse {
            detail: "missing choices[0].message.content".into(),
        })?;
    Ok(content.trim().to_string())
}

/// Core translation flow, separated from the Tauri command so integration
/// tests can drive it with a real client against a mock server. Consults the
/// cache first; every uncached segment gets its own single chat completion
/// request, and the plain-text answer is cached before being returned in
/// original order. Cache write failures are logged and never fail a
/// translation.
pub async fn translate_segments_with_client(
    client: &reqwest::Client,
    settings: &TranslationSettings,
    segments: &[String],
    cache: &TranslationCache,
) -> Result<Vec<String>, TranslateError> {
    validate_endpoint(&settings.endpoint)?;
    // Best-effort housekeeping before anything is translated: sweeps the
    // cache down to its cap, throttled to at most once an hour per directory.
    cache.prune_if_due();
    let mut translated = Vec::with_capacity(segments.len());
    for segment in segments {
        let key = TranslationCache::cache_key(&settings.model, &settings.target_language, segment);
        if let Some(hit) = cache.get(&key) {
            translated.push(hit);
            continue;
        }
        let value = translate_segment(client, settings, segment).await?;
        if let Err(error) = cache.store(&key, &value) {
            log::warn!("failed to cache translation for segment {segment:?}: {error}");
        }
        translated.push(value);
    }
    Ok(translated)
}

/// Lists the model ids advertised by an OpenAI-compatible endpoint (GET
/// {endpoint}/models, Bearer api_key), sorted by id. Separated from the Tauri
/// command so integration tests can drive it with a real client against a mock
/// server. Failure styles match `translate_segment`: transport problems, non-
/// success statuses, and malformed payloads are all `TranslateError`s.
pub async fn list_translation_models_with_client(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
) -> Result<Vec<String>, TranslateError> {
    validate_endpoint(endpoint)?;
    let url = format!("{}/models", endpoint.trim_end_matches('/'));
    let response = client
        .get(&url)
        .bearer_auth(api_key)
        // The client is shared process-wide; the settings dialog's model
        // check gets a shorter budget than translation.
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|source| TranslateError::Request { source })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(TranslateError::ResponseStatus { status, body });
    }
    let payload: serde_json::Value =
        response
            .json()
            .await
            .map_err(|source| TranslateError::BadResponse {
                detail: format!("response JSON is invalid: {source}"),
            })?;
    let data = payload
        .get("data")
        .and_then(|value| value.as_array())
        .ok_or_else(|| TranslateError::BadResponse {
            detail: "missing data array".into(),
        })?;
    let mut models: Vec<String> = data
        .iter()
        .map(|entry| {
            entry
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| TranslateError::BadResponse {
            detail: "data entries must have a string id".into(),
        })?;
    models.sort();
    Ok(models)
}

/// One process-wide client shared by every translation command so pooled
/// connections survive across calls. Redirects are never followed: by default
/// reqwest would honor a 307/308 reply from a loopback endpoint and forward
/// the request — POST body and document text included — to whatever host the
/// Location header names, bypassing `validate_endpoint`. With the no-redirect
/// policy in place those replies come back untouched and surface as ordinary
/// non-success statuses (`TranslateError::ResponseStatus`).
static SHARED_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Builds (once) and returns the process-wide client. rustls requires a
/// process-wide crypto provider before any Client is built; installing the
/// ring provider is idempotent, so every call does it and whichever command
/// runs first wins without ordering problems. The build-and-set below keeps
/// the fallible first build out of `get_or_init` (its `get_or_try_init`
/// counterpart is not stable on the pinned toolchain).
pub fn shared_client() -> Result<&'static reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    if let Some(client) = SHARED_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("failed to build HTTP client: {error}"))?;
    // A concurrent first caller may have installed theirs; reuse it so the
    // pool stays a single owner.
    Ok(SHARED_CLIENT.get_or_init(|| client))
}

/// Translates a batch of markdown segments via an OpenAI-compatible chat
/// completions endpoint, caching results per segment under the app data
/// directory.
#[tauri::command]
pub async fn translate_segments(
    app: tauri::AppHandle,
    settings: TranslationSettings,
    segments: Vec<String>,
) -> Result<Vec<String>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let cache = TranslationCache::new(data_dir.join("translation-cache"));
    translate_segments_with_client(shared_client()?, &settings, &segments, &cache)
        .await
        .map_err(|error| error.to_string())
}

/// Lists the models available at an OpenAI-compatible endpoint (GET
/// {endpoint}/models, Bearer api_key), sorted by id. The settings dialog's
/// model picker and connection check both call this; the WebView CSP forbids
/// direct frontend calls to the provider, so the request goes through Rust
/// like translation.
#[tauri::command]
pub async fn list_translation_models(
    endpoint: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    list_translation_models_with_client(shared_client()?, &endpoint, &api_key)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_stable_and_distinguishes_inputs() {
        let key = TranslationCache::cache_key("m", "中文", "hello");
        assert_eq!(key, TranslationCache::cache_key("m", "中文", "hello"));
        assert_eq!(key.len(), 64);
        assert_ne!(key, TranslationCache::cache_key("n", "中文", "hello"));
        assert_ne!(key, TranslationCache::cache_key("m", "英文", "hello"));
        assert_ne!(key, TranslationCache::cache_key("m", "中文", "world"));
    }

    #[test]
    fn endpoint_validation_allows_https_and_loopback_http_only() {
        for allowed in [
            "https://api.openai.com/v1",
            "https://localhost:11434/v1",
            "http://localhost:11434/v1",
            "http://127.0.0.1:1420/v1",
            "http://[::1]:8080/v1",
        ] {
            assert!(
                validate_endpoint(allowed).is_ok(),
                "{allowed} must be allowed"
            );
        }
        for rejected in [
            "http://example.com/v1",
            "ftp://example.com/v1",
            "file:///tmp/v1",
            "not a url",
            "",
        ] {
            assert!(
                validate_endpoint(rejected).is_err(),
                "{rejected:?} must be rejected"
            );
        }
    }

    #[test]
    fn chat_body_carries_model_prompt_and_segment_as_text() {
        let body = build_chat_body("m", "中文", "hello **world**");
        assert_eq!(body["model"], "m");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        let system = messages[0]["content"].as_str().unwrap();
        assert!(system.contains("中文"));
        assert!(system.contains("Markdown"));
        assert!(system.contains("inline code"));
        assert!(system.contains("$...$"));
        assert!(system.contains("HTML"));
        assert!(system.contains("no surrounding quotes"));
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "hello **world**");
    }

    #[test]
    fn eviction_removes_the_oldest_entries_down_to_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let cache = TranslationCache::new(dir.path().join("translation-cache"));
        std::fs::create_dir_all(cache.dir()).unwrap();
        // Five entries with clearly distinct modification times, oldest first.
        for i in 0..5u64 {
            let path = cache.dir().join(format!("{i:064x}.json"));
            std::fs::write(&path, "x").unwrap();
            let times = fs::FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(i * 3600));
            fs::File::open(&path).unwrap().set_times(times).unwrap();
        }
        // A non-json file must never be counted or removed.
        std::fs::write(cache.dir().join("README"), "keep me").unwrap();

        let removed = cache.evict_oldest_entries(3).unwrap();
        assert_eq!(removed, 2, "the two oldest entries are evicted");
        let mut remaining: Vec<String> = fs::read_dir(cache.dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        remaining.sort();
        assert_eq!(
            remaining,
            vec![
                "0000000000000000000000000000000000000000000000000000000000000002.json",
                "0000000000000000000000000000000000000000000000000000000000000003.json",
                "0000000000000000000000000000000000000000000000000000000000000004.json",
                "README",
            ]
        );

        // Already at or under the limit: nothing is removed.
        assert_eq!(cache.evict_oldest_entries(3).unwrap(), 0);
        assert_eq!(cache.evict_oldest_entries(10).unwrap(), 0);
    }

    #[test]
    fn eviction_is_a_no_op_for_missing_directories_and_never_removes_directories() {
        let dir = tempfile::tempdir().unwrap();
        let cache = TranslationCache::new(dir.path().join("translation-cache"));
        // A cache directory that never existed is not an error.
        assert_eq!(cache.evict_oldest_entries(10).unwrap(), 0);
        // A directory that happens to end in .json is not a cache entry; the
        // removal attempt fails and is logged, never fatal, and the directory
        // survives.
        std::fs::create_dir_all(cache.dir().join("dir.json")).unwrap();
        assert_eq!(cache.evict_oldest_entries(0).unwrap(), 0);
        assert!(cache.dir().join("dir.json").is_dir());
    }
}
