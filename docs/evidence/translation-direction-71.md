# Issue #71 translation direction validation

Verified locally on **2026-10-08**, macOS, Chrome-for-Testing **153.0.8010.12**.
This evidence covers the assigned worktree and unpacked MV3 extension. Nothing
was pushed, published, merged or commented on GitHub.

## Model investigation before implementation

The actual checkpoint is **`Xenova/opus-mt-en-jap`**, not an invented symmetric
`onnx-community/opus-mt-en-ja`. Immutable revision:
`9d418190be3aa945eae5bab1bd96bc5e349ad784`.

- [Pinned conversion card](https://huggingface.co/Xenova/opus-mt-en-jap/blob/9d418190be3aa945eae5bab1bd96bc5e349ad784/README.md)
  identifies the Helsinki-NLP base model and Transformers.js ONNX compatibility.
- [Pinned base model card](https://huggingface.co/Helsinki-NLP/opus-mt-en-jap/blob/a863894cdd2b80f3bc1c5966734aee9ffec207d1/README.md)
  declares English input, Japanese (`jap`) output and **Apache 2.0**. The conversion
  card has no additional license declaration. Public anonymous asset delivery is
  ungated; retain upstream terms/attribution/notices when redistributing derivatives.
- Config declares MarianMTModel; tokenizer config declares `source_lang: en`,
  `target_lang: jap`. No reverse-direction inference is assumed.
- Downloaded files were checked against the pinned Hugging Face API metadata
  sizes and LFS SHA-256s, then whole-file and 1 MiB chunk hashes were recorded in
  [the independent manifest](../../extension/opus-mt-en-ja-assets.json).
  Seven required files total **98,933,843 bytes**; no weights are committed/bundled.
- Before adding the production Node, an isolated browser probe ran these exact
  bytes with the existing Transformers.js 4.0.0-next.3 / ONNX Runtime Web
  1.25.0-dev.20260212-1a71a5f46e, `q8`, single-thread WASM runtime. It produced
  Japanese output. The later production page and extension smokes below used
  real network delivery and inference without model/runtime mocks.
- `python3 scripts/review-opus-mt-en-ja-assets.py` passed metadata, byte size,
  whole-file SHA-256 and every chunk check against the committed manifest.

The model's documented benchmark is Bible text. A greeting probe and general
speech produced poor/unrelated Japanese. This is an explicit model limitation,
not a claim of general translation quality. The Playground and recorder disclose
it. The in-domain production page fixture below produced a sensible translation.

## Implementation and deterministic tests

The exclusive direction select defaults to Japanese → English, independently
of the default-off checkbox. Both preferences use extension-origin localStorage,
restored before toolbar-driven session startup; no storage permission was added.
Direction changes during capture affect the next session. The immutable graph,
current/last-session display and paired final rows retain their captured direction.

English → Japanese owns `EnglishToJapaneseOpusMtTranslationNode` and
`opus-mt-en-ja-worker.js`; Japanese → English retains its existing Node/Worker.
The shared scheduler only adapts transcript ports: one in flight, latest pending
provisional, FIFO finals, versioned stale-output suppression and final drain.
Each direction has its own immutable manifest/cache keys. Preparation inspects
and explicitly downloads only the selection, with progress/cancel/retry and
independent readiness. Cache-only inference verifies the corresponding asset set
and disables remote-model fallback. Chrome capture permissions/CSP are unchanged.
The original copyable final transcript and transcription-only graph are preserved.

- `npm test`: **163 passed**. Production nodes, both-direction scheduling,
  coalescing, ordered pairing/drain, errors, cancellation, repeat sessions,
  selected worker and manifest, preference defaults/persistence/fallback.
- `npm run test:browser -- --workers=2`: **146 passed, 12 opt-in skipped**,
  Chromium and WebKit. Production pages and native Workers with deterministic
  model-runtime fixtures; includes the new independent page/index entry,
  repository-prefix URLs, cancellation, retry, repeat and prior page regressions.
- `npm run test:extension`: **40 passed, 2 real-smoke opt-in skipped**.
  Both-direction production recorder, scheduler, native Worker/cache access with
  small hashed assets and deterministic inference. Includes preference/profile
  restart, change during a running session, retained-row labels, separate cache
  preparation/readiness, offline reuse, eviction, network/quota/load/inference
  failures, download cancellation, teardown and transcription-only repeat.
- `npm run build:extension` and `git diff --check`: passed.

These deterministic tests do **not** establish real inference. The initial
focused browser command encountered the local investigation server on port 8000;
that owned server was stopped before the successful suite. No product change was
needed for that test setup conflict.

## Real English → Japanese inference — passed

```sh
TRANSLATION_SMOKE=opus-en-ja npm run test:browser -- tests/browser/translation-smoke.spec.js --project=chromium --workers=1
python3 scripts/prepare-reazon-ja-en-fixtures.py
EXTENSION_OPUS_SMOKE=en-ja npm run test:extension -- tests/extension/translation-smoke.spec.js
```

The standalone production page passed two fresh Node/Worker runs. Input:
`In the beginning God created the heavens and the earth.` Output on both runs:
`はじめに神は天と地とを創造された.` First load **10399 ms**, repeat load
**623 ms**; exact captured timings/capabilities/time are in
[real browser evidence](translation-direction-71-browser.json).

The real MV3 smoke passed in **59.1 seconds**. It used the actual toolbar action
and native tab capture on the checksum-pinned upstream **English** WAV, real
ReazonSpeech/Silero, explicit remote model preparation, production translation
Node/Worker and the unchanged MV3 CSP/COEP. No capture, ASR, cache, runtime or
inference mocks were installed. Both online and recreated-window offline runs
produced matching-original completed provisional output and ordered final pairs.
Cache readiness was Ready; there were no page errors. All requests were GETs
without bodies. Remote traffic was only model asset delivery during explicit
preparation; inference and offline repeat made no remote requests.

See [sanitized real extension evidence](translation-direction-71-extension.json)
for UTC time, fixture checksum, capabilities, all captured pairs and request counts.
The out-of-domain translation is poor/unrelated, so Japanese-script output proves
local execution only. The bilingual ASR also produced a short Japanese tail after
the English audio; its original stays visible and is translated in the explicitly
selected direction without language detection.

An initial real extension run failed a test-only assertion requiring **every**
ASR final to contain English characters, because of that bilingual tail. The
assertion now requires English-source provisional and at least one English final,
nonempty originals for every final, and completed Japanese translation for every
pair; Japanese → English keeps its original Japanese-source check. The corrected
online/offline real smoke passed. Default-suite skipped smokes were run explicitly
as recorded here; unrelated real Gemma/ASR benchmarks were not requested/run.

## Existing Japanese → English real regression

The explicit regression command
`EXTENSION_OPUS_SMOKE=1 npm run test:extension -- tests/extension/translation-smoke.spec.js`
**passed in 1.1 minutes** with real Japanese tab audio, completed provisional
English and ordered final pairs online and after recorder recreation offline.
No page errors or remote inference requests occurred. See
[sanitized real Japanese → English evidence](translation-direction-71-ja-en.json)
for time/capabilities/fixture/pairs and request counts. Both-direction deterministic
tests above also passed.

## Required post-merge GitHub Pages verification

**Pending.** This worktree has not been merged/deployed. Do not close #71 before
recording the required verification. The unpacked extension has no deployment gate.

| Required record | Current result |
| --- | --- |
| Successful Pages workflow run URL | Pending after merge |
| Merged and deployed SHA | Pending after merge |
| Verification UTC time | Pending after merge |
| Canonical `https://takahirox.github.io/my-audio-to-text/nodes/opus-mt-en-ja/` loads from index | Pending after merge |
| Page script, shared modules, new Worker and runtime URLs keep `/my-audio-to-text/` | Pending after merge |
| Immutable model URLs valid on deployed origin | Pending after merge |

Run the opt-in page smoke with
`ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/` and
`TRANSLATION_SMOKE=opus-en-ja` when appropriate; record results plus the Pages run
URL/SHA/time here. Local repository-prefix tests prove routing logic, not that a
merged revision was published.
