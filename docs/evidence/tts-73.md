# Issue #73 validation

Worktree baseline: `78d5862b3c130d495069799aa03b0d0b260f25cb`.
Validation date: 2026-10-09 JST (2026-10-08 UTC).

Two independent production TTS Nodes and pages run plain string source → TTS
Worker → generated-audio sink/player through the existing Pipeline. Each owns
its model/frontend resources. Pipeline runtime, ASR/translation processors,
extension inference/packaging and native integration are unchanged. Runtime
preparation and Pages staging include pinned TTS assets in `web/tts-assets/`.

## Deterministic/build checks

- `npm ci`: passed; Playwright 1.63.0, no added npm dependencies.
- `npm test`: **180 passed**, including TTS ports/native rates/WAV, lifecycle,
  asynchronous sink drain, repeated input, cancellation during load/generation/
  drain, stale replies, errors and asset-cache eviction/quota/offline recovery.
- Full Chromium/WebKit browser regression suite: **184 passed, 16 skipped**,
  1.1 minutes; includes all **38 TTS fixture checks**. Skips are opt-in existing
  ASR/translation/TTS real-model or benchmark tests, not failed regressions.
- `npm run prepare:assets`: passed, pinned ReazonSpeech ja-en/Silero 90.8 MB.
- `npm run prepare:translation-assets`: passed, 27,771,302 bytes.
- `npm run prepare:tts-assets`: passed, checksum-verified 60,493,827 bytes;
  no model weights staged and no changes to existing extension asset selection.
- `npm run build:extension`: passed.
- `npm run test:extension`: **40 passed, 2 skipped** (opt-in real translation
  smoke tests); included native capture and real packaged ASR/VAD initialization.
- `git diff --check`: passed.

TTS browser coverage executes production Nodes, real module Worker entry points,
Pipeline connections and the audio player adapter under a Pages repository
prefix. Heavy model/WASM boundaries are replaced only for deterministic tests.
It covers both language settings, repeat, downloads only on explicit Generate,
WAV metadata, errors/retry, cancellation, missing WASM/SIMD/gzip and token limits.
Real inference results below establish actual model execution separately.

The initial fixture run had two failures because the delayed Supertonic fixture
required four two-second initialization waits on the retry. The retry fixture
was corrected. An attempted concurrent full-suite run reused the smoke runner's
temporary server, which stopped when smoke finished; resulting connection
failures were not product failures. The final full suite uses its own server.

## Real-model browser inference

`TTS_SMOKE=all npx playwright test tests/browser/tts-smoke.spec.js --project=chromium --workers=1`:
**2 passed**, 2.4 minutes. Native Chromium **153.0.8010.12**, macOS arm64,
Apple **M4 Max**, 16 logical browser cores. Localhost was secure but **not
cross-origin isolated**; both backends used single-thread WASM. Every run used
the actual production page/Node/Worker/graph; no mocked model, alternate test
inference, remote synthesis, prerecorded waveform or synthetic output.

Fixtures: Japanese `こんにちは。今日は良い天気です。`; English
`Hello. It is a beautiful day today.`. Each test runs Japanese, English and
repeat English with fresh graphs/Workers, using browser caching where available.

| Node / language | Load / initialization | Generation / drain | Waveform |
| --- | --- | --- | --- |
| Supertonic 3 Japanese, F1 | 107,976 ms | 1,584 ms | 125,952 samples, 44,100 Hz mono, 2.856 s |
| Supertonic 3 English, F1 | 523 ms | 1,610 ms | 132,096 samples, 44,100 Hz mono, 2.995 s |
| Supertonic 3 repeat English, F1 | 500 ms | 1,615 ms | 132,096 samples, 44,100 Hz mono, 2.995 s |
| Kokoro Japanese, jf_alpha | 12,822 ms | 4,704 ms | 67,800 samples, 24,000 Hz mono, 2.825 s |
| Kokoro English, af_heart | 1,843 ms | 4,610 ms | 66,600 samples, 24,000 Hz mono, 2.775 s |
| Kokoro repeat English, af_heart | 712 ms | 4,478 ms | 66,600 samples, 24,000 Hz mono, 2.775 s |

All samples were finite and nonempty; duration bounds and nonzero RMS passed.
Every run's WAV decoded with the native browser player; `play()` succeeded
and `currentTime` advanced. All observed network requests passed asset-only GET,
no-body, no-text-in-URL assertions. External traffic was limited to Hugging
Face checkpoint/metadata/CDN delivery; resolution paths used pinned revisions.
No page errors were recorded. Timing includes network/cache and initialization,
is device-specific and is not a performance guarantee. Listening evaluation
was not performed and is optional, not an acceptance gate.

Sanitized measured results: [Supertonic 3](tts-73-supertonic3.json),
[Kokoro](tts-73-kokoro.json). The recorded waveform stats/times are saved console
measurements from the successful smoke tests; signed query strings and raw
request lists are omitted. These tests establish Japanese/English browser
generation for the selected voices on this device, not general pronunciation
quality or mobile/Firefox/WebKit real-model performance.

The initial real smoke attempt generated/playback-tested Supertonic successfully
but failed a too-narrow assertion for Hugging Face's immutable metadata-cache
URL. Kokoro initially failed because the chosen `transformers.web.min.js`
requires unresolved bare package imports. Staging was corrected to the
standalone `transformers.min.js` bundle and its matching ORT artifacts;
the metadata assertion now accepts pinned resolve-cache URLs. Both corrected
tests passed. No initial failure is counted as a pass.

## Required post-merge verification

**Pending; not performed.** No push, PR, merge, comment, deployment or Issue
closure was performed by this node. Keep Issue #73 open until the successful
Pages deployment run for the merged SHA is recorded (run URL/SHA/time), then
verify both index links and all nested page/module/Worker/runtime/notices paths
under the repository prefix in a fresh deployed-origin browser. If model-fetch,
CORS or COEP behavior differs from local checks, record deployed-origin real
inference too. Local tests do not establish deployment of the merged revision.
