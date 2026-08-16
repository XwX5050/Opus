//! Document translation through an OpenAI-compatible chat completions API.
//!
//! The frontend splits a document into translatable segments and sends them
//! here in batch; results are cached on disk per segment so re-translating an
//! unchanged document never calls the provider again. Cache writes reuse the
//! sibling-temp + rename + directory-fsync discipline from `recovery`, and
//! corrupt or missing entries are always treated as misses so a bad write can
//! never fail a translation.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
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
}

/// The system prompt asks for a JSON object with one translation per input
/// string; Markdown structure and inline syntax survive the round trip.
fn system_prompt(target_language: &str) -> String {
    format!(
        "Translate each string in the user's JSON array into {target_language}. \
         Preserve Markdown syntax, inline code, inline math ($...$), and link \
         URLs exactly as they appear. Respond with only a JSON object of the \
         form {{\"translations\": [...]}} with one translated string per input \
         string, in the same order. Output nothing but the JSON."
    )
}

/// The chat completions body: model plus a system prompt and the segments as
/// a JSON array string in the user message.
fn build_chat_body(model: &str, target_language: &str, segments: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": system_prompt(target_language),
            },
            {
                "role": "user",
                "content": serde_json::to_string(segments).expect("strings serialize to JSON"),
            },
        ],
    })
}

/// Translates `segments` in one chat completions request and decodes the
/// `{"translations": [...]}` payload, failing when the response cannot be
/// turned into exactly one string per input segment.
async fn translate_batch(
    client: &reqwest::Client,
    settings: &TranslationSettings,
    segments: &[&str],
) -> Result<Vec<String>, TranslateError> {
    let url = format!(
        "{}/chat/completions",
        settings.endpoint.trim_end_matches('/')
    );
    let body = build_chat_body(&settings.model, &settings.target_language, segments);
    let response = client
        .post(&url)
        .bearer_auth(&settings.api_key)
        .json(&body)
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
    let parsed: serde_json::Value =
        serde_json::from_str(content).map_err(|error| TranslateError::BadResponse {
            detail: format!("translations JSON is invalid: {error}"),
        })?;
    let translations = parsed
        .get("translations")
        .and_then(|value| value.as_array())
        .ok_or_else(|| TranslateError::BadResponse {
            detail: "missing translations array".into(),
        })?;
    let translated: Vec<String> = translations
        .iter()
        .map(|value| value.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| TranslateError::BadResponse {
            detail: "translations entries must be strings".into(),
        })?;
    if translated.len() != segments.len() {
        return Err(TranslateError::BadResponse {
            detail: format!(
                "expected {} translations, got {}",
                segments.len(),
                translated.len()
            ),
        });
    }
    Ok(translated)
}

/// Core translation flow, separated from the Tauri command so integration
/// tests can drive it with a real client against a mock server. Consults the
/// cache first; only uncached segments hit the provider. A batch response
/// that cannot be decoded into the right number of strings degrades to one
/// request per segment (some compatible providers only answer single-segment
/// payloads reliably). Results are cached before being returned in original
/// order; cache write failures are logged and never fail a translation.
pub async fn translate_segments_with_client(
    client: &reqwest::Client,
    settings: &TranslationSettings,
    segments: &[String],
    cache: &TranslationCache,
) -> Result<Vec<String>, TranslateError> {
    validate_endpoint(&settings.endpoint)?;
    let keys: Vec<String> = segments
        .iter()
        .map(|segment| {
            TranslationCache::cache_key(&settings.model, &settings.target_language, segment)
        })
        .collect();
    let mut translated: Vec<Option<String>> = vec![None; segments.len()];
    let mut uncached: Vec<usize> = Vec::new();
    for (index, key) in keys.iter().enumerate() {
        if let Some(hit) = cache.get(key) {
            translated[index] = Some(hit);
        } else {
            uncached.push(index);
        }
    }
    if !uncached.is_empty() {
        let uncached_text: Vec<&str> = uncached
            .iter()
            .map(|&index| segments[index].as_str())
            .collect();
        let resolved = match translate_batch(client, settings, &uncached_text).await {
            Ok(resolved) => resolved,
            Err(TranslateError::BadResponse { .. }) => {
                let mut resolved = Vec::with_capacity(uncached.len());
                for &index in &uncached {
                    let segment = segments[index].as_str();
                    let single = translate_batch(client, settings, &[segment]).await?;
                    resolved.push(single.into_iter().next().ok_or_else(|| {
                        TranslateError::BadResponse {
                            detail: "per-segment translation returned no result".into(),
                        }
                    })?);
                }
                resolved
            }
            Err(error) => return Err(error),
        };
        for (position, &index) in uncached.iter().enumerate() {
            translated[index] = Some(resolved[position].clone());
        }
    }
    for (index, key) in keys.iter().enumerate() {
        if let Some(value) = translated[index].as_deref() {
            if let Err(error) = cache.store(key, value) {
                log::warn!("failed to cache translation for segment {index}: {error}");
            }
        }
    }
    Ok(translated
        .into_iter()
        .map(|value| value.expect("every segment was resolved"))
        .collect())
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
    // rustls requires a process-wide crypto provider before any Client is
    // built; installing the ring provider is idempotent across the app.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("failed to build HTTP client: {error}"))?;
    translate_segments_with_client(&client, &settings, &segments, &cache)
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
    fn chat_body_carries_model_prompt_and_segments_as_json() {
        let body = build_chat_body("m", "中文", &["a", "b"]);
        assert_eq!(body["model"], "m");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        let system = messages[0]["content"].as_str().unwrap();
        assert!(system.contains("中文"));
        assert!(system.contains("$...$"));
        assert!(system.contains("Markdown"));
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], r#"["a","b"]"#);
    }
}
