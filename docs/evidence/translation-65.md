# Issue #65 validation

Implementation worktree baseline: `6345864923932924c3be3d2d41a5de24437c5c48`.
Both independent Japanese → English processors and pages use the real Pipeline,
plain string ports and an owned module Worker. `web/pipeline.js` and the ASR
processing code are unchanged. Translation runtime assets are excluded from the
ASR-only extension package.

## Deterministic checks

- `npm ci`: passed (Playwright 1.63.0; no new npm dependencies).
- `npm test`: **112 passed**, including translation adapter cancellation during
  load/receive/drain, stale replies, empty/multiple outputs, order, errors,
  worker release, checksum staging and extension packaging separation.
- Full Chromium/WebKit browser suite: **134 passed, 10 skipped**. Skips were
  opt-in speech/translation real-model or benchmark checks, not deterministic
  regressions. A later targeted run of the final translation suite passed
  **26/26** (including both missing-WebGPU and missing-adapter branches).
- `npm run prepare:assets`: passed; staged pinned 90.8 MB ReazonSpeech/Silero.
- `npm run prepare:translation-assets`: passed; staged checksum-verified
  Transformers.js 4.0.0-next.3 + ONNX Runtime Web
  1.25.0-dev.20260212-1a71a5f46e asyncify runtime, **27,771,302 bytes**.
- `npm run build:extension`: passed; translation runtime excluded.
- `npm run test:extension`: **19 passed**, including native toolbar tab capture
  and real packaged ReazonSpeech/Silero initialization under MV3 CSP.
- Repository-prefix browser coverage: navigation, production graph types,
  repeated fresh workers/disposal and worker URLs under `/my-audio-to-text/`.
- `git diff --check`: passed.

Tests used a plain local server without isolation headers. The speech page
establishes its existing isolation policy; translation requires no new shared
isolation manager. For concurrent real/deterministic checks an ignored local
Playwright config reused the owned server (`webServer: undefined`) with the
same projects/test directory/base URL; all repository-prefix checks remained
active. Real smoke runs used separate output directories to preserve evidence.

## Real inference checks

Fixed Japanese fixture: `今日は良い天気です。`. These are initialization,
local inference, pipeline output and repeated-session checks, **not translation
quality evaluation**. Only the supported Japanese → English direction is exposed.

OPUS-MT: **passed**, Chromium 153.0.8010.12 on macOS, localhost, WASM one thread,
without cross-origin isolation. Two production-node runs returned
`It's a nice day today.`. Final cold loading/initialization was 87,281 ms (while
TranslateGemma was downloading), then 881 ms from the model cache; inference
and Pipeline drain took 133 ms and 128 ms. Timing includes model downloads and
is environment-specific. [Sanitized run evidence](translation-65-opus.json)
records fixture, output, browser, status and network summary. The final smoke
passed privacy assertions for every request: GET assets only, no request bodies,
no fixture in URL path/query, pinned Hugging Face resolution/metadata-cache
paths and Hugging Face CDN hosts. GPU probing was unnecessary for the WASM run.

TranslateGemma: **passed**, installed Chrome 154.0.8037.99 on macOS,
Apple `metal-3` WebGPU adapter, 64 GiB system RAM, localhost without
cross-origin isolation. Two production-node runs returned
`Today is a beautiful day.`. Final loading/initialization took **236,185 ms** and
**224,585 ms**; translation and Pipeline drain took **1,065 ms** and **551 ms**.
Repeated initialization remained expensive on this browser; a warm cache is not
guaranteed for multi-GB assets. [Sanitized run evidence](translation-65-gemma.json)
records device, fixture, outputs, status and network summary. The final corrected
smoke passed all asset-only/no-input network assertions for both real runs.

The default headless bundled Chromium exposed `navigator.gpu` but returned no
adapter. The production node reported an actionable unsupported-device error
before runtime/model downloads; this failed device check was not counted as
real inference success. Installed Chrome's hardware check used
`TRANSLATION_CHANNEL=chrome`, without unsafe flags or mocked inference.

An initial real-model check caught an incorrect legacy JSEP asset selection:
that loader lacks `webgpuInit` in the pinned runtime version. The staging script
and production loader now select the required matching **asyncify** MJS/WASM.
Both processors passed real inference and repeat with the corrected runtime.
The smoke request audit allows Hugging Face’s pinned `/api/resolve-cache/models/`
metadata GET redirects as asset downloads; it rejects unexpected hosts/Hub paths,
request bodies and input text in URLs. No device skips are counted as real
inference successes.

## Required post-merge verification

**Pending, not performed by this worktree node.** No push, PR, merge, deployment
or Issue comment is authorized here. Local model execution does not establish
that the merged revision is published.

After deployment, record the merged/deployed SHA, successful Pages workflow run
URL and verification time. Verify the index and both dedicated translation pages
are reachable, return links work and HTML/controller/modules/Worker/runtime
URLs retain `/my-audio-to-text/`. Run real model initialization and a supported
Japanese → English fixture on the deployed origin when fetch restrictions need
verification there. Keep any unperformed deployed real-model checks explicitly
pending. Do not close #65 until required verification is completed and recorded.
