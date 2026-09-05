# Changelog

All notable changes to Opus are documented in this file.

## [0.1.15] - 2026-09-05

Document translation overhaul: much faster, much cheaper, and free-tier
friendly.

### Added

- Provider presets in the settings dialog: 智谱 GLM-4.7-Flash (free tier),
  腾讯混元 Hy-MT2-Lite (translation-dedicated, ~¥0.3/M tokens), and DeepSeek
  V4 Flash (cheap, context caching). A preset fills the verified endpoint,
  model, and a sane concurrency; every preset remembers its own API key, so
  switching providers never re-asks for one.
- Viewport-first translation: the screen you are reading is translated first,
  nearby content is prefetched, and the rest of the document finishes in the
  background; scrolling re-prioritizes live.

### Changed

- Batched provider requests: chunks are packed into a single chat completion
  (up to 8 chunks / 4000 characters) behind numbered delimiter lines with
  strict reply validation and per-segment fallback — an order of magnitude
  fewer round trips, and the system prompt is no longer re-sent per chunk.
- Chunks already written in the target language are skipped via a
  conservative script-ratio heuristic and never hit the provider.
- Slimmer system prompt, `temperature: 0`, and one asynchronous retry that
  honors a 429 `Retry-After` header.
- Reasoning is turned off where providers enable it by default (智谱 and
  DeepSeek get `thinking: disabled`; OpenAI reasoning models get
  `reasoning_effort: low`) — thinking tokens are billed as output and add
  seconds of latency per request.

### Fixed

- 智谱 GLM translations returning empty text: glm-4.7-flash reasons by
  default and could exhaust the whole completion budget on reasoning tokens.
- Viewport priority no longer skews when a document contains tall protected
  blocks (code fences, display math); priority now maps the visible character
  range instead of the pixel scroll fraction.
