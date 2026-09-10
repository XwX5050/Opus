//! Document translation through an OpenAI-compatible chat completions API.
//!
//! The frontend splits a document into translatable segments and sends them
//! in batches; each batch is a single chat completion whose user message
//! joins the segments with ⟪n⟫ delimiter lines. The model's plain-text reply
//! is split back on those lines and must reproduce the exact ⟪1⟫…⟪N⟫
//! sequence with non-empty bodies — there is no JSON envelope to parse and no
//! result count to validate. A reply that fails that validation falls back to
//! one plain request per segment, which is also the protocol for a single
//! unbatched segment. Results are cached on disk per segment so re-translating
//! an unchanged document never calls the provider again; a 429 reply with an
//! integer Retry-After of at most 10 seconds is retried once after waiting.
//! Cache writes reuse the sibling-temp + rename + directory-fsync discipline
//! from `recovery`, and corrupt or missing entries are always treated as
//! misses so a bad write can never fail a translation. Providers whose models
//! reason by default get a per-provider override (`reasoning_override`):
//! 智谱 (bigmodel.cn / z.ai) and DeepSeek requests carry
//! `"thinking": {"type": "disabled"}` — their hybrid models can otherwise
//! burn the whole completion budget on billed reasoning tokens (智谱 may even
//! return an empty translation) — and OpenAI reasoning models (gpt-5 family,
//! o-series) get `"reasoning_effort": "low"`, the minimum they accept.
//!
//! The same endpoint also powers the settings dialog's model picker and
//! connection check: `list_translation_models` fetches `GET {endpoint}/models`
//! and returns the advertised model ids, sorted.
//!
//! API keys are not part of the settings: both commands receive a *slot* name
//! and read the key from the OS credential store (`api_keys`), so key material
//! never enters the frontend or any message this module produces.

use crate::api_keys;
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
/// `TranslationSettings`. The API key itself is not part of the settings: the
/// frontend holds only `key_slot` and the key is read from the credential
/// store for each request (see `api_keys`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSettings {
    pub endpoint: String,
    pub key_slot: String,
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

    /// Derives the cache key for a segment: sha256 of endpoint, model, target
    /// language, and the segment itself, so switching any of them starts a
    /// fresh set of entries. The endpoint belongs in the key because one
    /// model id can mean different providers (or differently configured
    /// proxies) behind different endpoints; its trailing slashes never change
    /// which provider a request reaches, so they are ignored. Keys are only
    /// ever produced here; callers must not hand arbitrary strings to
    /// `get`/`store`. Entries written before the endpoint joined the key are
    /// simply never read again; the ordinary entry-cap prune ages them out.
    pub fn cache_key(endpoint: &str, model: &str, target_language: &str, segment: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(endpoint.trim_end_matches('/').as_bytes());
        hasher.update(b"\n");
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
    /// itself is durable (same discipline as recovery drafts). The directory
    /// fsync is Unix-only: Windows cannot open directories for fsync
    /// (ERROR_ACCESS_DENIED) and NTFS already journals directory metadata.
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
        #[cfg(not(windows))]
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
        "Translate the following text into {target_language}. Preserve all \
         Markdown syntax, inline code, math ($...$ and $$...$$), URLs, and \
         HTML tags exactly as they appear, and do not translate code or \
         formula content. Output only the translation."
    )
}

/// Batching variant of the prompt: the base contract plus the one sentence
/// the batched reply is validated against.
fn batch_system_prompt(target_language: &str) -> String {
    format!(
        "{} Every segment is preceded by a delimiter line (⟪n⟫); keep every \
         ⟪n⟫ line verbatim on its own line and translate only the text \
         between markers.",
        system_prompt(target_language)
    )
}

/// Provider-specific request fields that keep translation fast and cheap by
/// turning reasoning off — or, where no off switch exists, down. Reasoning
/// models otherwise burn invisible "thinking" tokens (billed as output)
/// before writing the translation: 智谱 glm-4.7-flash can even return empty
/// content when reasoning exhausts the completion budget, and DeepSeek V4
/// reasons at high effort by default. Each field follows the provider's own
/// documented convention and is only sent to the hosts that document it —
/// other providers reject unknown fields with HTTP 400.
fn reasoning_override(endpoint: &str, model: &str) -> Vec<(&'static str, serde_json::Value)> {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return vec![];
    };
    let Some(host) = url.host_str() else {
        return vec![];
    };
    let host = host.to_ascii_lowercase();
    // 智谱 GLM (open.bigmodel.cn, *.bigmodel.cn, *.z.ai) and DeepSeek share
    // the same `thinking` toggle object.
    if host == "open.bigmodel.cn"
        || host.ends_with(".bigmodel.cn")
        || host.ends_with(".z.ai")
        || host == "api.deepseek.com"
        || host.ends_with(".deepseek.com")
    {
        return vec![("thinking", serde_json::json!({ "type": "disabled" }))];
    }
    // OpenAI reasoning models (gpt-5 family, o-series) have no off switch;
    // "low" is the minimal effort they all accept. Non-reasoning models
    // (e.g. gpt-4o-mini) reject the field, so gate on the model name.
    if host == "api.openai.com" {
        let model = model.to_ascii_lowercase();
        let reasoning_model = model.starts_with("gpt-5")
            || model.starts_with("o1")
            || model.starts_with("o3")
            || model.starts_with("o4");
        if reasoning_model {
            return vec![("reasoning_effort", serde_json::json!("low"))];
        }
    }
    vec![]
}

/// The chat completions body for a single segment: model, temperature 0, and
/// the segment to translate as the user message. Providers with default-on
/// reasoning additionally get their off/low override (see
/// `reasoning_override`).
fn build_chat_body(
    endpoint: &str,
    model: &str,
    target_language: &str,
    segment: &str,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "temperature": 0,
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
    });
    for (key, value) in reasoning_override(endpoint, model) {
        body[key] = value;
    }
    body
}

/// The chat completions body for a batch: the segments joined into one user
/// message, each preceded by its own ⟪n⟫ delimiter line (n is the 1-based
/// position within the joined message). Reasoning overrides apply exactly
/// like in `build_chat_body`.
fn build_batch_chat_body(
    endpoint: &str,
    model: &str,
    target_language: &str,
    segments: &[String],
) -> serde_json::Value {
    let mut content = String::new();
    for (index, segment) in segments.iter().enumerate() {
        if index > 0 {
            content.push_str("\n\n");
        }
        content.push_str(&format!("⟪{}⟫\n{segment}", index + 1));
    }
    let mut body = serde_json::json!({
        "model": model,
        "temperature": 0,
        "messages": [
            {
                "role": "system",
                "content": batch_system_prompt(target_language),
            },
            {
                "role": "user",
                "content": content,
            },
        ],
    });
    for (key, value) in reasoning_override(endpoint, model) {
        body[key] = value;
    }
    body
}

/// Longest 429 `Retry-After` (in seconds) that is honoured with a wait and
/// one retry; any longer wait is reported like any other provider error.
const MAX_RETRY_AFTER_SECONDS: u64 = 10;

/// The wait a 429 reply asks for before a retry, when `Retry-After` is an
/// integer of at most `MAX_RETRY_AFTER_SECONDS` seconds. A date-formatted
/// header, a longer wait, or any non-429 status means no retry.
fn retry_after_seconds(response: &reqwest::Response) -> Option<u64> {
    if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
        return None;
    }
    let value = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?;
    let seconds: u64 = value.parse().ok()?;
    (seconds <= MAX_RETRY_AFTER_SECONDS).then_some(seconds)
}

/// POSTs one chat completions body with the API key. The client is shared
/// process-wide, so the command's budget lives on the request instead of the
/// client; a long translation may stream for a while, hence the generous
/// timeout. The key is passed in rather than read from the settings: it comes
/// from the credential store and never lands anywhere else.
async fn post_chat(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, TranslateError> {
    client
        .post(url)
        .bearer_auth(api_key)
        .json(body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|source| TranslateError::Request { source })
}

/// Sends a chat completions request, retrying once after a 429 whose
/// integer `Retry-After` is at most `MAX_RETRY_AFTER_SECONDS`. The async
/// sleep yields the runtime thread; it happens at most once per request.
async fn send_chat_request(
    client: &reqwest::Client,
    api_key: &str,
    settings: &TranslationSettings,
    body: &serde_json::Value,
) -> Result<reqwest::Response, TranslateError> {
    let url = format!(
        "{}/chat/completions",
        settings.endpoint.trim_end_matches('/')
    );
    let response = post_chat(client, &url, api_key, body).await?;
    if let Some(seconds) = retry_after_seconds(&response) {
        tokio::time::sleep(Duration::from_secs(seconds)).await;
        return post_chat(client, &url, api_key, body).await;
    }
    Ok(response)
}

/// Turns a chat completions response into the assistant's message content;
/// non-success statuses and malformed payloads are `TranslateError`s.
async fn chat_completion_content(response: reqwest::Response) -> Result<String, TranslateError> {
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
    payload
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| TranslateError::BadResponse {
            detail: "missing choices[0].message.content".into(),
        })
}

/// Translates one segment in a single chat completions request and returns
/// the model's plain-text answer with stray surrounding whitespace trimmed.
/// The response is not parsed further: whatever the model writes for this one
/// segment is the translation, so a reply that splits the input into several
/// sentences or paragraphs still counts as a single result. This is also the
/// fallback path when a batched reply fails marker validation.
async fn translate_segment(
    client: &reqwest::Client,
    api_key: &str,
    settings: &TranslationSettings,
    segment: &str,
) -> Result<String, TranslateError> {
    let body = build_chat_body(
        &settings.endpoint,
        &settings.model,
        &settings.target_language,
        segment,
    );
    let response = send_chat_request(client, api_key, settings, &body).await?;
    Ok(chat_completion_content(response).await?.trim().to_string())
}

/// Returns n when a line is exactly a ⟪n⟫ marker (surrounding whitespace
/// ignored); any other line is not a marker.
fn marker_number(line: &str) -> Option<usize> {
    let line = line.trim();
    let inner = line.strip_prefix("⟪")?.strip_suffix("⟫")?;
    inner.parse().ok()
}

/// Splits a batched reply on its ⟪n⟫ marker lines. Requires the exact
/// sequence ⟪1⟫..⟪N⟫ with nothing before ⟪1⟫ and a non-empty, trimmed body
/// between consecutive markers; any other shape (missing, duplicated, or
/// out-of-order markers, a preamble, an empty body) is rejected.
fn parse_batch_reply(reply: &str, expected: usize) -> Option<Vec<String>> {
    let mut bodies: Vec<String> = vec![String::new(); expected];
    let mut preamble = String::new();
    let mut marker_seen = 0usize;
    for raw_line in reply.lines() {
        if let Some(number) = marker_number(raw_line) {
            if number != marker_seen + 1 || number > expected {
                return None;
            }
            marker_seen = number;
        } else if marker_seen == 0 {
            preamble.push_str(raw_line);
            preamble.push('\n');
        } else {
            bodies[marker_seen - 1].push_str(raw_line);
            bodies[marker_seen - 1].push('\n');
        }
    }
    if !preamble.trim().is_empty() || marker_seen != expected {
        return None;
    }
    let mut results = Vec::with_capacity(expected);
    for body in bodies {
        let body = body.trim().to_string();
        if body.is_empty() {
            return None;
        }
        results.push(body);
    }
    Some(results)
}

/// Translates several uncached segments in one chat completions request whose
/// user message joins them with ⟪n⟫ delimiter lines, then splits the reply
/// back. When the reply does not reproduce the exact marker sequence with
/// non-empty bodies, falls back to one plain request per segment — today's
/// protocol.
async fn translate_batch_segments(
    client: &reqwest::Client,
    api_key: &str,
    settings: &TranslationSettings,
    segments: &[String],
) -> Result<Vec<String>, TranslateError> {
    let body = build_batch_chat_body(
        &settings.endpoint,
        &settings.model,
        &settings.target_language,
        segments,
    );
    let response = send_chat_request(client, api_key, settings, &body).await?;
    let content = chat_completion_content(response).await?;
    if let Some(translations) = parse_batch_reply(&content, segments.len()) {
        return Ok(translations);
    }
    let mut translations = Vec::with_capacity(segments.len());
    for segment in segments {
        translations.push(translate_segment(client, api_key, settings, segment).await?);
    }
    Ok(translations)
}

/// Caches one translation; write failures are logged and never fail the
/// translation itself.
fn store_translation(
    cache: &TranslationCache,
    settings: &TranslationSettings,
    segment: &str,
    value: &str,
) {
    let key = TranslationCache::cache_key(
        &settings.endpoint,
        &settings.model,
        &settings.target_language,
        segment,
    );
    if let Err(error) = cache.store(&key, value) {
        log::warn!("failed to cache translation for segment {segment:?}: {error}");
    }
}

/// The cache's answer for one translation request: the translations it can
/// serve right away and the segments that still need a provider request.
/// Keeping the cache lookup separate from the network work is what lets a
/// caller skip credentials entirely — a fully cached document keeps rendering
/// on a machine with no key configured, and a keyless slot only fails when a
/// request would actually be sent.
pub struct TranslationPlan {
    /// One entry per input segment; `None` until its translation arrives.
    results: Vec<Option<String>>,
    /// Positions into the caller's segment list, with the text to translate.
    uncached: Vec<(usize, String)>,
}

impl TranslationPlan {
    /// Consults the cache for every segment. Best-effort housekeeping runs
    /// first: the cache is swept down to its cap, throttled to at most once
    /// an hour per directory.
    pub fn from_cache(
        cache: &TranslationCache,
        settings: &TranslationSettings,
        segments: &[String],
    ) -> Self {
        cache.prune_if_due();
        let mut results: Vec<Option<String>> = vec![None; segments.len()];
        let mut uncached: Vec<(usize, String)> = Vec::new();
        for (index, segment) in segments.iter().enumerate() {
            let key = TranslationCache::cache_key(
                &settings.endpoint,
                &settings.model,
                &settings.target_language,
                segment,
            );
            match cache.get(&key) {
                Some(hit) => results[index] = Some(hit),
                None => uncached.push((index, segment.clone())),
            }
        }
        Self { results, uncached }
    }

    /// Whether any segment still needs a provider request — and therefore
    /// whether an API key has to be resolved at all.
    pub fn needs_request(&self) -> bool {
        !self.uncached.is_empty()
    }

    /// The finished translations, for a plan that needs no request. Panics if
    /// a segment is still pending, which is why callers check
    /// [`Self::needs_request`] first.
    pub fn into_results(self) -> Vec<String> {
        Self::collect(self.results)
    }

    /// Translates the pending segments and caches each result. The uncached
    /// ones are sent as one batched chat completion (or as one plain request
    /// when only a single segment is missing, or when the batched reply fails
    /// marker validation); cache write failures are logged and never fail a
    /// translation.
    pub async fn translate_uncached(
        self,
        client: &reqwest::Client,
        api_key: &str,
        settings: &TranslationSettings,
        cache: &TranslationCache,
    ) -> Result<Vec<String>, TranslateError> {
        validate_endpoint(&settings.endpoint)?;
        let Self {
            mut results,
            uncached,
        } = self;
        if uncached.len() == 1 {
            let (index, segment) = &uncached[0];
            let value = translate_segment(client, api_key, settings, segment).await?;
            results[*index] = Some(value.clone());
            store_translation(cache, settings, segment, &value);
        } else if uncached.len() > 1 {
            let texts: Vec<String> = uncached.iter().map(|(_, text)| text.clone()).collect();
            let values = translate_batch_segments(client, api_key, settings, &texts).await?;
            for ((index, segment), value) in uncached.iter().zip(values) {
                results[*index] = Some(value.clone());
                store_translation(cache, settings, segment, &value);
            }
        }
        Ok(Self::collect(results))
    }

    /// Collects a plan whose every slot is filled; the `expect` is this
    /// module's invariant, upheld by the flows above (every segment is either
    /// served from the cache or translated).
    fn collect(results: Vec<Option<String>>) -> Vec<String> {
        results
            .into_iter()
            .map(|result| result.expect("every segment is translated or served from cache"))
            .collect()
    }
}

/// Core translation flow, separated from the Tauri command so integration
/// tests can drive it with a real client against a mock server. `api_key` is
/// the already-resolved key for the settings' slot; callers that want the key
/// resolved lazily (so a fully cached document needs none) drive
/// [`TranslationPlan`] directly.
pub async fn translate_segments_with_client(
    client: &reqwest::Client,
    api_key: &str,
    settings: &TranslationSettings,
    segments: &[String],
    cache: &TranslationCache,
) -> Result<Vec<String>, TranslateError> {
    TranslationPlan::from_cache(cache, settings, segments)
        .translate_uncached(client, api_key, settings, cache)
        .await
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
/// directory. The API key belongs to `settings.key_slot` and is read from the
/// credential store here, so it never reaches the frontend; a slot with no
/// key fails with the structured `missing-key` error the UI matches on.
///
/// The key is resolved *lazily*: the cache is consulted first, and a document
/// the cache can serve in full is returned without touching the credential
/// store, so a translation made before the key was removed still renders
/// offline.
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
    let plan = TranslationPlan::from_cache(&cache, &settings, &segments);
    if !plan.needs_request() {
        return Ok(plan.into_results());
    }
    let store = api_keys::store_for_app(&app)?;
    let slot = settings.key_slot.clone();
    let api_key = api_keys::run_store(move || api_keys::key_for_slot(&store, &slot)).await?;
    plan.translate_uncached(shared_client()?, &api_key, &settings, &cache)
        .await
        .map_err(|error| error.to_string())
}

/// Lists the models available at an OpenAI-compatible endpoint (GET
/// {endpoint}/models, Bearer api_key), sorted by id. The settings dialog's
/// model picker and connection check both call this; the WebView CSP forbids
/// direct frontend calls to the provider, so the request goes through Rust
/// like translation. The key is read from the credential store by slot and
/// never travels through the frontend.
#[tauri::command]
pub async fn list_translation_models(
    app: tauri::AppHandle,
    endpoint: String,
    key_slot: String,
) -> Result<Vec<String>, String> {
    let store = api_keys::store_for_app(&app)?;
    let api_key = api_keys::run_store(move || api_keys::key_for_slot(&store, &key_slot)).await?;
    list_translation_models_with_client(shared_client()?, &endpoint, &api_key)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_stable_and_distinguishes_inputs() {
        let key = TranslationCache::cache_key("https://a.example/v1", "m", "中文", "hello");
        assert_eq!(
            key,
            TranslationCache::cache_key("https://a.example/v1", "m", "中文", "hello")
        );
        assert_eq!(key.len(), 64);
        // The endpoint participates: the same model id can mean a different
        // provider (or proxy) behind a different endpoint.
        assert_ne!(
            key,
            TranslationCache::cache_key("https://b.example/v1", "m", "中文", "hello")
        );
        assert_ne!(
            key,
            TranslationCache::cache_key("https://a.example/v1", "n", "中文", "hello")
        );
        assert_ne!(
            key,
            TranslationCache::cache_key("https://a.example/v1", "m", "英文", "hello")
        );
        assert_ne!(
            key,
            TranslationCache::cache_key("https://a.example/v1", "m", "中文", "world")
        );
        // Trailing slashes never change which provider a request reaches.
        assert_eq!(
            key,
            TranslationCache::cache_key("https://a.example/v1/", "m", "中文", "hello")
        );
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
    fn chat_body_carries_model_prompt_and_segment_as_text_with_temperature_zero() {
        let body = build_chat_body("https://api.openai.com/v1", "m", "中文", "hello **world**");
        assert_eq!(body["model"], "m");
        assert_eq!(body["temperature"], 0);
        assert!(body.get("thinking").is_none());
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        let system = messages[0]["content"].as_str().unwrap();
        assert!(system.contains("中文"));
        assert!(system.contains("Markdown"));
        assert!(system.contains("inline code"));
        assert!(system.contains("$...$"));
        assert!(system.contains("HTML"));
        assert!(system.contains("Output only the translation"));
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "hello **world**");
    }

    #[test]
    fn batch_chat_body_joins_segments_with_marker_lines_and_temperature_zero() {
        let body = build_batch_chat_body(
            "https://api.openai.com/v1",
            "m",
            "中文",
            &["one".into(), "two".into()],
        );
        assert_eq!(body["model"], "m");
        assert_eq!(body["temperature"], 0);
        assert!(body.get("thinking").is_none());
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        let system = messages[0]["content"].as_str().unwrap();
        assert!(system.contains("中文"));
        assert!(system.contains("only the text between markers"));
        assert_eq!(
            messages[1]["content"].as_str().unwrap(),
            "⟪1⟫\none\n\n⟪2⟫\ntwo"
        );
    }

    #[test]
    fn reasoning_override_hosts_and_models() {
        let overrides = |endpoint: &str, model: &str| reasoning_override(endpoint, model);
        // 智谱 and DeepSeek hosts get the thinking toggle, any model.
        for endpoint in [
            "https://open.bigmodel.cn/api/paas/v4",
            "https://api.bigmodel.cn/v1",
            "https://open.z.ai/api/paas/v4",
            "https://anything.z.ai/v1",
            "https://api.deepseek.com/v1",
            "https://api.deepseek.com",
        ] {
            let fields = overrides(endpoint, "glm-4.7-flash");
            assert_eq!(fields.len(), 1, "{endpoint} must override thinking");
            assert_eq!(fields[0].1, serde_json::json!({ "type": "disabled" }));
        }
        // OpenAI: only reasoning-model names get the effort floor.
        assert_eq!(
            overrides("https://api.openai.com/v1", "gpt-5-mini"),
            vec![("reasoning_effort", serde_json::json!("low"))]
        );
        assert_eq!(
            overrides("https://api.openai.com/v1", "o3"),
            vec![("reasoning_effort", serde_json::json!("low"))]
        );
        for model in ["gpt-4o-mini", "gpt-4.1", "chatgpt-4o-latest"] {
            assert!(
                overrides("https://api.openai.com/v1", model).is_empty(),
                "{model} must not carry reasoning_effort"
            );
        }
        // The apex domains, other providers, loopback, and unparseable URLs
        // never get an override; a reasoning model name on a non-OpenAI host
        // is not OpenAI's concern either.
        for endpoint in [
            "https://bigmodel.cn/v1",
            "https://z.ai/v1",
            "https://api.openai.com/v1",
            "https://tokenhub.tencentmaas.com/v1",
            "http://localhost:11434/v1",
            "not a url",
            "",
        ] {
            assert!(
                overrides(endpoint, "m").is_empty(),
                "{endpoint:?} must not carry an override"
            );
        }
        assert!(overrides("https://api.deepseek.com/v1", "gpt-5-mini")[0].0 == "thinking");
        assert!(overrides("https://example.com/v1", "gpt-5-mini").is_empty());
    }

    #[test]
    fn chat_body_disables_reasoning_per_provider() {
        for endpoint in [
            "https://open.bigmodel.cn/api/paas/v4",
            "https://open.z.ai/api/paas/v4",
            "https://api.deepseek.com/v1",
        ] {
            let body = build_chat_body(endpoint, "m", "中文", "hello");
            assert_eq!(
                body["thinking"]["type"], "disabled",
                "{endpoint} must disable thinking"
            );
        }
        let body = build_chat_body("https://api.openai.com/v1", "gpt-5-mini", "中文", "hello");
        assert_eq!(body["reasoning_effort"], "low");
        assert!(body.get("thinking").is_none());
        // Non-reasoning models and other providers carry no override at all.
        for (endpoint, model) in [
            ("https://api.openai.com/v1", "gpt-4o-mini"),
            ("https://tokenhub.tencentmaas.com/v1", "hy-mt2-lite"),
            ("http://localhost:11434/v1", "m"),
        ] {
            let body = build_chat_body(endpoint, model, "中文", "hello");
            assert!(
                body.get("thinking").is_none() && body.get("reasoning_effort").is_none(),
                "{endpoint}/{model} must not carry a reasoning override"
            );
        }
    }

    #[test]
    fn batch_chat_body_disables_reasoning_per_provider() {
        for endpoint in [
            "https://open.bigmodel.cn/api/paas/v4",
            "https://api.deepseek.com/v1",
        ] {
            let body = build_batch_chat_body(endpoint, "m", "中文", &["one".into()]);
            assert_eq!(
                body["thinking"]["type"], "disabled",
                "{endpoint} must disable thinking"
            );
        }
        let body = build_batch_chat_body(
            "https://api.openai.com/v1",
            "gpt-5-mini",
            "中文",
            &["one".into()],
        );
        assert_eq!(body["reasoning_effort"], "low");
        let body = build_batch_chat_body(
            "https://tokenhub.tencentmaas.com/v1",
            "m",
            "中文",
            &["one".into()],
        );
        assert!(
            body.get("thinking").is_none() && body.get("reasoning_effort").is_none(),
            "TokenHub must not carry a reasoning override"
        );
    }

    #[test]
    fn batch_reply_parses_exact_marker_sequences_with_non_empty_bodies() {
        assert_eq!(
            parse_batch_reply("⟪1⟫\n一\n\n⟪2⟫\n二、三\n", 2),
            Some(vec!["一".into(), "二、三".into()])
        );
        // multi-line bodies keep their inner line breaks
        assert_eq!(
            parse_batch_reply("⟪1⟫\n第一行\n第二行\n⟪2⟫\n二", 2),
            Some(vec!["第一行\n第二行".into(), "二".into()])
        );
        // trailing blank lines and stray whitespace around markers are fine
        assert_eq!(
            parse_batch_reply("  \n⟪1⟫  \n你好\n", 1),
            Some(vec!["你好".into()])
        );
    }

    #[test]
    fn batch_reply_rejects_missing_duplicated_or_foreign_markers() {
        // no markers at all
        assert_eq!(parse_batch_reply("一\n二", 2), None);
        // out-of-order markers
        assert_eq!(parse_batch_reply("⟪2⟫\n二\n⟪1⟫\n一", 2), None);
        // a duplicated marker
        assert_eq!(parse_batch_reply("⟪1⟫\n一\n⟪1⟫\n一", 2), None);
        // a marker beyond the batch's count
        assert_eq!(parse_batch_reply("⟪1⟫\n一\n⟪2⟫\n二\n⟪3⟫\n三", 2), None);
        // text before the first marker
        assert_eq!(parse_batch_reply("译文：\n⟪1⟫\n一\n⟪2⟫\n二", 2), None);
        // an empty body
        assert_eq!(parse_batch_reply("⟪1⟫\n\n⟪2⟫\n二", 2), None);
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
            // Windows requires a handle with write access for SetFileTime, so
            // a plain File::open (read-only) fails there with ACCESS_DENIED.
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(times)
                .unwrap();
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
