use markdown_edit_lib::translate::{
    list_translation_models_with_client, translate_segments_with_client, TranslationCache,
    TranslationSettings,
};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

/// Minimal HTTP server that records requests and answers each one with the
/// next queued response. Every response closes the connection, so the request
/// count is the connection count. Each captured request keeps its raw bytes
/// (head + body) so tests can assert on the request line and headers.
struct MockServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<Vec<u8>>>>,
    responses: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl MockServer {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let responses = Arc::new(Mutex::new(Vec::new()));
        let requests_thread = Arc::clone(&requests);
        let responses_thread = Arc::clone(&responses);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                requests_thread.lock().unwrap().push(request);
                let response = {
                    let mut queue = responses_thread.lock().unwrap();
                    if queue.is_empty() {
                        http_status(500, "unexpected request")
                    } else {
                        queue.remove(0)
                    }
                };
                let _ = stream.write_all(&response);
            }
        });
        Self {
            addr,
            requests,
            responses,
        }
    }

    fn endpoint(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    fn queue(&self, response: Vec<u8>) {
        self.responses.lock().unwrap().push(response);
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    fn request_line(&self, index: usize) -> String {
        let raw = &self.requests.lock().unwrap()[index];
        let (head, _) = split_request(raw);
        let line: Vec<u8> = head
            .iter()
            .take_while(|&&byte| byte != b'\r')
            .copied()
            .collect();
        String::from_utf8_lossy(&line).to_string()
    }

    fn request_header(&self, index: usize, name: &str) -> Option<String> {
        let raw = &self.requests.lock().unwrap()[index];
        let (head, _) = split_request(raw);
        let head = String::from_utf8_lossy(head);
        head.lines().find_map(|line| {
            let (header, value) = line.split_once(':')?;
            header
                .eq_ignore_ascii_case(name)
                .then_some(value.trim().to_string())
        })
    }

    fn request_body(&self, index: usize) -> Vec<u8> {
        let raw = &self.requests.lock().unwrap()[index];
        let (_, body) = split_request(raw);
        body.to_vec()
    }
}

/// Splits a captured raw request into (head, body) at the blank line.
fn split_request(raw: &[u8]) -> (&[u8], &[u8]) {
    let header_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("captured request ends its headers with a blank line")
        + 4;
    (&raw[..header_end], &raw[header_end..])
}

fn read_request(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let header_end = loop {
        match stream.read(&mut buffer) {
            Ok(0) => return None,
            Ok(n) => {
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(position) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break position + 4;
                }
                if bytes.len() > 1 << 20 {
                    return None;
                }
            }
            Err(_) => return None,
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let content_length: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    while bytes.len() < header_end + content_length {
        match stream.read(&mut buffer) {
            Ok(0) => return None,
            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
            Err(_) => return None,
        }
    }
    Some(bytes)
}

fn http_response(body: &str) -> Vec<u8> {
    let body = body.as_bytes();
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

fn http_status(status: u16, reason: &str) -> Vec<u8> {
    let body = reason.as_bytes();
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

/// A chat completions response whose content is the given translations array.
fn chat_response(translations: &[&str]) -> Vec<u8> {
    let content = serde_json::json!({ "translations": translations }).to_string();
    let payload = serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": content } }]
    });
    http_response(&payload.to_string())
}

fn settings(endpoint: &str) -> TranslationSettings {
    TranslationSettings {
        endpoint: endpoint.into(),
        api_key: "test-key".into(),
        model: "test-model".into(),
        target_language: "中文".into(),
    }
}

/// Installs the ring crypto provider (idempotent) and builds a client for
/// the mock server, mirroring what the Tauri command does.
fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::new()
}

fn segments(texts: &[&str]) -> Vec<String> {
    texts.iter().map(|text| text.to_string()).collect()
}

#[test]
fn cache_key_derivation_is_stable() {
    // Hardcoded value so an accidental change to the key derivation is caught.
    assert_eq!(
        TranslationCache::cache_key("gpt-4o-mini", "中文", "Hello **world**"),
        "196dd54dccac4334bb53b3925c9b8837c48ac17c5ce3b8e8cf30ebab7959a3f1"
    );
}

#[test]
fn cached_entries_round_trip_and_survive_a_store_restart() {
    let dir = tempfile::tempdir().unwrap();
    let cache_dir = dir.path().join("translation-cache");
    let key = TranslationCache::cache_key("test-model", "中文", "Hello");
    {
        let cache = TranslationCache::new(cache_dir.clone());
        assert_eq!(cache.get(&key), None);
        cache.store(&key, "你好").unwrap();
        assert_eq!(cache.get(&key).as_deref(), Some("你好"));
        // entries are one json file per segment, with no temp files behind
        let files: Vec<_> = std::fs::read_dir(cache.dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(files, vec![format!("{key}.json")]);
    }
    // a fresh store on the same directory sees the entry (restart persistence)
    let restarted = TranslationCache::new(cache_dir);
    assert_eq!(restarted.get(&key).as_deref(), Some("你好"));
}

#[test]
fn missing_and_corrupt_entries_are_cache_misses() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let key = TranslationCache::cache_key("test-model", "中文", "Hello");
    assert_eq!(cache.get(&key), None);
    std::fs::create_dir_all(cache.dir()).unwrap();
    let entry = cache.dir().join(format!("{key}.json"));
    std::fs::write(&entry, b"{not json").unwrap();
    assert_eq!(cache.get(&key), None);
    std::fs::write(&entry, b"").unwrap();
    assert_eq!(cache.get(&key), None);
}

#[tokio::test]
async fn full_cache_hit_never_touches_the_network() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    let texts = ["one", "two", "three"];
    let translations = ["一", "二", "三"];
    let keys: Vec<String> = texts
        .iter()
        .map(|text| TranslationCache::cache_key(&settings.model, &settings.target_language, text))
        .collect();
    for (key, translated) in keys.iter().zip(translations) {
        cache.store(key, translated).unwrap();
    }

    let client = client();
    let result = translate_segments_with_client(&client, &settings, &segments(&texts), &cache)
        .await
        .unwrap();
    assert_eq!(result, translations);
    assert_eq!(server.request_count(), 0);
}

#[tokio::test]
async fn uncached_segments_are_translated_in_one_request_and_then_cached() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    let texts = ["one", "two"];
    server.queue(chat_response(&["一", "二"]));

    let client = client();
    let result = translate_segments_with_client(&client, &settings, &segments(&texts), &cache)
        .await
        .unwrap();
    assert_eq!(result, ["一", "二"]);
    assert_eq!(server.request_count(), 1);

    let body: serde_json::Value = serde_json::from_slice(&server.request_body(0)).unwrap();
    assert_eq!(body["model"], "test-model");
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    let system = messages[0]["content"].as_str().unwrap();
    assert!(system.contains("中文"));
    assert!(system.contains("Markdown"));
    assert_eq!(messages[1]["content"], r#"["one","two"]"#);

    // a second run is served entirely from the cache
    let result = translate_segments_with_client(&client, &settings, &segments(&texts), &cache)
        .await
        .unwrap();
    assert_eq!(result, ["一", "二"]);
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn batch_parse_failure_falls_back_to_one_request_per_segment() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    let texts = ["one", "two"];
    server.queue(http_response("not json"));
    server.queue(chat_response(&["一"]));
    server.queue(chat_response(&["二"]));

    let client = client();
    let result = translate_segments_with_client(&client, &settings, &segments(&texts), &cache)
        .await
        .unwrap();
    assert_eq!(result, ["一", "二"]);
    assert_eq!(server.request_count(), 3);
    // per-segment requests carry a single-element array
    let body: serde_json::Value = serde_json::from_slice(&server.request_body(1)).unwrap();
    assert_eq!(body["messages"][1]["content"], r#"["one"]"#);
}

#[tokio::test]
async fn batch_length_mismatch_falls_back_to_one_request_per_segment() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    let texts = ["one", "two"];
    server.queue(chat_response(&["一", "二", "extra"]));
    server.queue(chat_response(&["一"]));
    server.queue(chat_response(&["二"]));

    let client = client();
    let result = translate_segments_with_client(&client, &settings, &segments(&texts), &cache)
        .await
        .unwrap();
    assert_eq!(result, ["一", "二"]);
    assert_eq!(server.request_count(), 3);
}

#[tokio::test]
async fn provider_http_errors_are_reported_and_not_retried_per_segment() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    server.queue(http_status(401, "Unauthorized"));

    let client = client();
    let error = translate_segments_with_client(&client, &settings, &segments(&["one"]), &cache)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("401"));
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn invalid_endpoints_are_rejected_before_any_request() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    let client = client();

    let insecure = TranslationSettings {
        endpoint: "http://example.com/v1".into(),
        ..settings.clone()
    };
    let error = translate_segments_with_client(&client, &insecure, &segments(&["one"]), &cache)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not allowed"));
    assert_eq!(server.request_count(), 0);
}

#[tokio::test]
async fn list_models_gets_the_models_path_with_bearer_auth_and_parses_ids_sorted() {
    let server = MockServer::spawn();
    // Out of order on purpose: the command must sort the ids for display.
    server.queue(http_response(
        &serde_json::json!({ "data": [{ "id": "gpt-4o-mini" }, { "id": "gpt-4o" }] }).to_string(),
    ));

    let client = client();
    let models = list_translation_models_with_client(&client, &server.endpoint(), "test-key")
        .await
        .unwrap();

    assert_eq!(models, ["gpt-4o", "gpt-4o-mini"]);
    assert_eq!(server.request_count(), 1);
    assert_eq!(server.request_line(0), "GET /v1/models HTTP/1.1");
    assert_eq!(
        server.request_header(0, "authorization"),
        Some("Bearer test-key".into())
    );
    assert_eq!(server.request_body(0), b"");
}

#[tokio::test]
async fn list_models_reports_provider_http_errors() {
    let server = MockServer::spawn();
    server.queue(http_status(401, "Unauthorized"));

    let client = client();
    let error = list_translation_models_with_client(&client, &server.endpoint(), "test-key")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("401"));
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn list_models_rejects_malformed_payloads() {
    // (payload, expected error fragment); each case needs its own server
    // because a queued response is consumed by exactly one request.
    let cases: &[(&str, &str)] = &[
        ("not json", "response JSON is invalid"),
        (r#"{"models": []}"#, "missing data array"),
        (r#"{"data": [{"id": 7}]}"#, "string id"),
    ];
    let client = client();
    for (payload, expected) in cases {
        let server = MockServer::spawn();
        server.queue(http_response(payload));
        let error = list_translation_models_with_client(&client, &server.endpoint(), "test-key")
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(expected),
            "payload {payload:?} must fail mentioning {expected:?}, got: {error}"
        );
        assert_eq!(server.request_count(), 1);
    }
}

#[tokio::test]
async fn list_models_rejects_insecure_endpoints_before_any_request() {
    let server = MockServer::spawn();
    let client = client();
    let error = list_translation_models_with_client(&client, "http://example.com/v1", "test-key")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not allowed"));
    assert_eq!(server.request_count(), 0);
}
