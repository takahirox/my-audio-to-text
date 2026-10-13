# Issue #91: shared primitive-first text ports

Implemented in the assigned worktree on 2026-10-13. The
[contract audit](../port-contracts.md) distinguishes reusable data from ASR IDs,
Worker requests, scheduler versions and UI/session state. SpeechToText and
TranscriptOutput now use shared TEXT strings. TranslationScheduler accepts
TEXT and emits successful TEXT plus separate optional, atomic TEXT_RESULT
outputs for paired views. FinalText, TranslatedFinalText and
FinalTranscriptText extraction adapters are removed. Version 1–3 graphs migrate
explicitly to version 4, preserving final routes and every adapter fan-out.

Graph validation uses contract identity rather than producer identity, retains
cardinality/settings/required-input/cycle constraints, and permits omitted
interim/diagnostic branches. Captured PCM and synthesized audio retain distinct
contracts. Independent transcript and paired translation streams keep separate
source/result state and language labels. No plugin SDK, registry, coercion or
synchronization framework was added.

## Validation

Environment: macOS, Node v24.12.0, Playwright 1.63.0; bundled Chromium and WebKit.
Pinned asset preparation and packaging completed with the repository scripts.

| Command | Result |
| --- | --- |
| `npm ci` | Passed; 0 reported vulnerabilities |
| `npm run prepare:assets` | Passed; verified ReazonSpeech ja-en/Silero distribution staged |
| `npm run prepare:translation-assets` | Passed; pinned translation runtime staged |
| `npm run prepare:tts-assets` | Passed; pinned TTS runtimes/frontends/source staged |
| `npm test` | 245 passed, 0 failed/skipped (final run: 0.27 s) |
| `npm run test:browser` | 218 passed, 18 skipped, 0 failed (41.3 s) |
| `npm run build:extension` | Passed; unpacked MV3 package generated in `dist/chrome-extension` |
| `npm run test:extension` | 81 passed, 5 skipped, 0 failed (2.6 min; final package) |
| `git diff --check` | Passed |

Unit coverage includes direct strings from different producers, ASR final-only
fan-out, equal-string distinct utterances and duplicate worker IDs, optional
interim inputs, type-compatible edges and invalid types/cardinality/cycles,
scheduler ordering/coalescing/errors, branch isolation, graceful Stop and Cancel,
independent transcript/paired streams, persistent v1/v2/v3 migration and visible
recovery without overwriting an invalid stored graph.

Browser coverage includes the actual speech Playground, shared native Worker
boundaries, core lifecycle/Stop/Cancel/repeat and a direct ASR final TEXT →
correction → independent translation → two text sinks flow on Chromium/WebKit.
Packaged MV3 coverage includes the actual editor/storage/runtime, native
worklet/fallback/tab/media/microphone capture, direct final/translated field
insertion, TTS fan-out, paired pending/errors/cancellation, final drain,
independent translated transcript language/source alignment, and migration with
fan-out and visible recovery. The full extension suite also initializes the real
pinned ASR/Silero workers under MV3 CSP.

Initial MV3 runs exposed five outdated assertions/fixtures (transcript object
shape, old type label, duplicate finals reaching Live, and two tests reusing one
utterance ID for distinct finals). These were corrected to test the new producer
contract. No failure was accepted as flaky; test retries were not enabled.
An additional independent-direction unit test found that preferences still
inferred Japanese→English translation direction from TranscriptView; the concrete
translator now determines its own direction, independently of the view.

## Optional real-model inference

Not run. The 18 browser skips are opt-in real ASR, bilingual recognition,
thread benchmarks, OPUS-MT/TranslateGemma, Qwen correction and TTS checks (including
unsupported WebKit opt-ins). The 5 extension skips are opt-in real TTS (two),
ASR-to-field (one), and ASR-to-OPUS-MT (two). Deterministic inference fixtures are
not claimed as real-model quality/recognition verification. Real ASR/Silero
initialization in the mandatory packaged suite is reported separately above.

## Required post-merge verification — pending

If merge triggers Playground publishing, wait for deployment completion, verify
the published revision, load the updated list/speech/translation pages, and check
core text flows on the published origin. Local tests do not establish deployment.
Keep Issue #91 open until this evidence is recorded. No deployment, push, PR,
merge or GitHub comment was performed by this node. The unpacked extension is
validated before merge and needs no additional post-merge check.
