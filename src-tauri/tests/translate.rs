use markdown_edit_lib::translate::{
    list_translation_models_with_client, shared_client, translate_segments_with_client,
    TranslationCache, TranslationSettings,
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

/// A 307 Temporary Redirect whose Location points elsewhere; a client that
/// follows redirects would make a second request against that target.
fn http_redirect(location: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

/// A chat completions response whose content is a plain-text translation.
fn chat_text_response(content: &str) -> Vec<u8> {
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

/// A plain client for protocol tests. The production commands share one
/// process-wide client via `shared_client()` (redirects disabled); that
/// production client is exercised by the redirect tests below.
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
async fn uncached_segments_are_translated_one_request_each_and_then_cached() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    let texts = ["one", "two"];
    server.queue(chat_text_response("一"));
    server.queue(chat_text_response("二"));

    let client = client();
    let result = translate_segments_with_client(&client, &settings, &segments(&texts), &cache)
        .await
        .unwrap();
    assert_eq!(result, ["一", "二"]);
    // One plain-text chat completion per uncached segment.
    assert_eq!(server.request_count(), 2);

    // The first request carries the new system prompt and the raw segment
    // text as the user message — no JSON array envelope.
    let first: serde_json::Value = serde_json::from_slice(&server.request_body(0)).unwrap();
    assert_eq!(first["model"], "test-model");
    let messages = first["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    let system = messages[0]["content"].as_str().unwrap();
    assert!(system.contains("中文"));
    assert!(system.contains("Markdown"));
    assert!(system.contains("inline code"));
    assert!(system.contains("$...$"));
    assert!(system.contains("HTML"));
    assert!(system.contains("no surrounding quotes"));
    assert_eq!(messages[1]["role"], "user");
    assert_eq!(messages[1]["content"], "one");
    let second: serde_json::Value = serde_json::from_slice(&server.request_body(1)).unwrap();
    assert_eq!(second["messages"][1]["content"], "two");

    // a second run is served entirely from the cache
    let result = translate_segments_with_client(&client, &settings, &segments(&texts), &cache)
        .await
        .unwrap();
    assert_eq!(result, ["一", "二"]);
    assert_eq!(server.request_count(), 2);
}

#[tokio::test]
async fn multi_sentence_output_for_a_single_segment_is_accepted_as_is() {
    // Models sometimes split one paragraph into several sentences or lines.
    // With the plain-text protocol there is no count to validate: the whole
    // response is the translation for the segment.
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    server.queue(chat_text_response("一、二、三"));

    let client = client();
    let result = translate_segments_with_client(&client, &settings, &segments(&["one"]), &cache)
        .await
        .unwrap();
    assert_eq!(result, ["一、二、三"]);
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn response_content_is_trimmed_to_strip_stray_whitespace() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    server.queue(chat_text_response("  \n你好，世界！\n  "));

    let client = client();
    let result = translate_segments_with_client(&client, &settings, &segments(&["one"]), &cache)
        .await
        .unwrap();
    assert_eq!(result, ["你好，世界！"]);
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn missing_choices_content_is_reported_as_a_bad_response() {
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let settings = settings(&server.endpoint());
    server.queue(http_response(r#"{"choices": []}"#));

    let client = client();
    let error = translate_segments_with_client(&client, &settings, &segments(&["one"]), &cache)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("missing choices[0].message.content"),
        "unexpected error: {error}"
    );
    assert_eq!(server.request_count(), 1);
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

#[tokio::test]
async fn redirects_are_never_followed_and_reported_as_errors() {
    // A loopback endpoint must not be able to use 307 to forward the request
    // (POST body with document text, bearer key) to an arbitrary host. The
    // shared production client disables redirects, so the 307 itself is
    // returned and reported as a non-success status instead of being followed.
    let dir = tempfile::tempdir().unwrap();
    let cache = TranslationCache::new(dir.path().join("translation-cache"));
    let server = MockServer::spawn();
    let forward_target = MockServer::spawn();
    let settings = settings(&server.endpoint());
    server.queue(http_redirect(&format!(
        "{}/evil",
        forward_target.endpoint()
    )));

    let client = shared_client().unwrap();
    let error = translate_segments_with_client(client, &settings, &segments(&["one"]), &cache)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("307"),
        "the 307 response itself must be reported, got: {error}"
    );
    // Exactly one request reached the origin; nothing hit the redirect target.
    assert_eq!(server.request_count(), 1);
    assert_eq!(forward_target.request_count(), 0);
}

#[tokio::test]
async fn list_models_redirects_are_reported_and_never_followed() {
    let server = MockServer::spawn();
    let forward_target = MockServer::spawn();
    server.queue(http_redirect(&format!(
        "{}/steal",
        forward_target.endpoint()
    )));

    let client = shared_client().unwrap();
    let error = list_translation_models_with_client(client, &server.endpoint(), "test-key")
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("307"),
        "the 307 response itself must be reported, got: {error}"
    );
    assert_eq!(server.request_count(), 1);
    assert_eq!(forward_target.request_count(), 0);
}

#[test]
fn prune_if_due_evicts_overflow_once_per_interval() {
    let dir = tempfile::tempdir().unwrap();
    let cache_dir = dir.path().join("translation-cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    // Fill past the cap with plain files; the sweep only looks at the `.json`
    // extension and the mtime, never the content.
    for i in 0..(markdown_edit_lib::translate::CACHE_ENTRY_LIMIT + 3) {
        std::fs::write(cache_dir.join(format!("{i}.json")), "x").unwrap();
    }
    let cache = TranslationCache::new(cache_dir.clone());

    // The first call scans and evicts the overflow back to the cap.
    cache.prune_if_due();
    assert_eq!(std::fs::read_dir(&cache_dir).unwrap().count(), 5000);

    // A second call within the interval is throttled: a fresh overflow stays
    // in place until the next sweep.
    for i in 0..2 {
        std::fs::write(cache_dir.join(format!("extra-{i}.json")), "x").unwrap();
    }
    cache.prune_if_due();
    assert_eq!(std::fs::read_dir(&cache_dir).unwrap().count(), 5002);
}
