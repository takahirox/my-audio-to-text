# Issue #78: optional local Qwen3 correction

Implementation adds a production `SpeechTranscriptCorrectionNode`, its owned
module Worker, an explicit final-transcript text adapter and a standalone
original/candidate Playground. No default ASR/translation/TTS/extension graph
is changed. The existing public TEXT/TRANSCRIPT exports retain their identities
via a small shared contract module; extension packaging includes that module
but excludes the correction Worker, runtime, page and weights.

## Pre-merge validation

Local checks on 2026-10-09:

| Check | Result |
| --- | --- |
| Read GitHub Issue #78 (open, no comments) | Complete |
| Checkpoint/tokenizer metadata, sizes and SHA-256 review | All 5 assets verified |
| `npm test` | 220 passed |
| `npm run test:browser -- --workers=2` | 214 passed, 18 opt-in tests skipped |
| Final correction-specific browser checks | 30 passed, Chromium and WebKit |
| `npm run prepare:assets` | Passed |
| `npm run prepare:translation-assets` | Passed |
| `npm run prepare:tts-assets` | Passed |
| `npm run prepare:correction-assets` | Passed, 27,771,302 runtime bytes |
| `npm run build:extension` | Passed |
| `npm run test:extension` | 45 passed, 4 opt-in tests skipped |
| `npm run test:correction-real` | Passed runtime/privacy smoke; quality failures below |
| `git diff --check` | Passed |

Deterministic correction coverage uses the genuine native production Worker
with only heavy inference/capability mocked. It covers pinned options, prompt
and decoding bounds, typed ports/adapter, separate originals, ordering/drain,
empty/long input, oversized prompt, malformed/numeric/truncated candidates,
load/inference/communication failures, Cancel during load/generation/drain,
late replies, repeat, error recovery, explicit disabled/error bypass, no
on-import model downloads, cache hit/miss/quota warning and repository-prefix
navigation. Browser CacheStorage persistence is exercised separately. Existing
ASR/translation/TTS and extension regressions pass; opt-in real-model checks
for those unrelated processors were not rerun.

## Actual browser/model execution

See [bounded machine-readable evidence](correction-78.json) for fixture inputs,
reference texts, actual outputs, per-input times, cache events and sanitized
request URLs (signed query parameters omitted). No personal transcript data was
used. The final smoke completed at **2026-10-09T08:43:48.061Z**.

- Chrome **154.0.8037.99**, headless macOS; Apple `metal-3` WebGPU adapter,
  `shader-f16`, secure localhost, no cross-origin isolation.
- Qwen3 **0.6B**, `q4f16`, immutable revision
  `1e0a4a196ecabdf9a879664110574563d3f372d3`.
- Transformers.js **4.0.0-next.3**, ORT Web
  **1.25.0-dev.20260212-1a71a5f46e**, production Worker and Pipeline.
- Cold load/initialization: **69,150 ms**. Fifteen ordered batch generations
  (14 distinct fixtures plus repeat), **93–236 ms** each, then drain/dispose.
- Separate real Playground Generate using Japanese selection: **67,524 ms**
  load/initialization, **218 ms** generation/drain, usable original/candidate
  display and visible cache warning. This exposed a quality regression below.
- **33 GET requests**, no bodies or transcript-bearing URLs; only localhost
  runtime/page modules and immutable Hugging Face model/metadata/CDN asset
  paths. Runtime JS/MJS/WASM resolved locally. There was no network inference.
- Config, tokenizer config, generation config and tokenizer persisted in
  CacheStorage and were reused by the fresh Playground Worker. The 570 MB
  weight cache write failed with a browser `Cache.put` internal error, visibly
  reported; the new Worker fetched those weights again. This is not proof of
  cached/offline weight availability. Deterministic cache persistence/quota
  tests pass, but real large-weight caching remains device/quota dependent.

The pre-implementation probe also ran this pinned checkpoint/runtime in a
native Worker, returning the exact English negation/date/time transcript
`I will not attend on October 9, 2026 at 14:30.` with EOS token `151645`.
This verified compatibility before implementing the processor.

## Quality results — no demonstrated correction benefit

The batch used `language: 'auto'` and the final conservative plain-user-text
prompt, thinking disabled, greedy decoding and a 256-token output bound.
All **10 distinct correct fixtures**, the repeated Japanese correct fixture,
and dates, figures, names and negations were exact copies. All **4 intended
error cases were missed**. No successful correction was observed. These are
synthetic text-only examples, not recordings or an ASR error-rate benchmark.

| Fixture | Actual candidate | Result |
| --- | --- | --- |
| Japanese correct | `今日は良い天気です。` | Exact copy |
| English correct | `There is a cat on the table.` | Exact copy |
| Japanese intended homophone error | `今日は良い転機です。` | Missed intended `天気` correction; context can be ambiguous |
| English intended homophone error | `Their is a cat on the table.` | Missed `There` correction |
| Japanese intended lexical error | `明日の天気予法を確認します。` | Missed `予報` correction |
| English intended lexical error | `I parked my car in the barking lot.` | Missed `parking` correction |
| Japanese date/time | `会議は2026年10月9日の14:30です。` | Exact copy |
| English date/time | `The meeting is on October 9, 2026 at 14:30.` | Exact copy |
| Japanese figures | `料金は3,500円で、人数は12人です。` | Exact copy |
| English figures | `The price is $3,500.50 for 12 people.` | Exact copy |
| Japanese names | `渡辺さんと田中さんは新宿で会います。` | Exact copy |
| English names | `Takahiro Watanabe works with ReazonSpeech in Shinjuku.` | Exact copy |
| Japanese negation | `私は明日の会議に出席しません。` | Exact copy |
| English negation | `I will not attend the meeting tomorrow.` | Exact copy |

**Actual final-prompt regression:** the separate Playground run selected
`language: 'ja'`. Given `今日は良い天気です。`, its candidate was
`良い天気です。`, dropping “today.” The structural guards accepted this
plain string; they cannot verify meaning. The original remained separately
visible, and the changed-span display exposed the deletion. The language hint
can affect outputs. Runtime smoke success is not a quality pass.

An earlier JSON-quoted-input prompt experiment is preserved in the JSON evidence
at **2026-10-09T08:34:16.534Z**. It emitted five regressions on correct text and
two other incorrect changes, mostly JSON/quote wrappers, before the numeric
safeguard rejected the English figure case and stopped that experiment. Examples:

- Correct `今日は良い天気です。` became `"良い天気です。"` (lost “today” and added quotes).
- Correct English sentence became a JSON object with invented speaker `A`.
- Correct Japanese date/time became `{"meeting": "2026年10月9日 14:30"}`.

The final prompt removes JSON wrapping, and validation now rejects newly
introduced JSON/quote wrappers. These changes improve response format on the
recorded batch, but do not establish a correction benefit or prevent semantic
regressions, as the final Japanese UI run shows. Keep this Node optional; use
the original/bypass rather than treating fluent candidates as trusted truth.
No larger model, recognizer coupling or extension default was added.

## Required post-merge verification

**Performed 2026-10-09T09:35:57Z.** PR #80 merged as
`58000ca292f33b27251a9dc4b954e429ad0e18ae`; its Pages deployment succeeded.
Fresh deployed-origin browser checks, 15 deterministic browser regressions and
real Japanese/English production Worker inference completed. The intended
corrections were still missed, the Japanese UI regression reproduced, and
weight caching failed visibly. See the [post-merge record](correction-78-postmerge.md)
for the deployment run URL, SHA, check time, published-file hashes, prefix/asset
checks, actual outputs and sanitized traffic. These checks establish deployment
and runtime behavior, not correction quality improvement.
