# Issue #107 implementation and validation

Recorded October 15, 2026 JST. The implementation adds explicit ReazonSpeech
and multilingual Whisper tiny graph types, version 7 lossless ASR renaming,
generic Text constants and startup-bound en/ja language configuration. The
default remains ChromeTabAudio → ReazonSpeech → one LiveTextDisplay. Whisper
emits finals only and uses the existing bounded Silero segment/drain queue.

## Completed checks

| Check | Result |
| --- | --- |
| `npm test` | **302 passed**, no skips; existing suites plus 11 Whisper/graph and two preparation/pin tests |
| Pinned preparation | ReazonSpeech/Silero, translation runtime, Whisper tiny q8 and TTS runtime/frontend prepared successfully; model sizes/checksums verified |
| `npm run build:extension` | Passed; packaged model checksums and shared files validated; unit packaging test checks MV3 CSP, permissions and byte identity |
| `npm run test:extension -- tests/extension/graph-whisper.spec.js` | **5 passed** under packaged MV3 CSP, using real production graph/core/Whisper Worker with deterministic inference/VAD fixtures |
| `npm run test:whisper-real` | **1 passed**: real English → Japanese → English inference, real Silero, Stop/repeat, resource disposal, zero HTTP requests |
| General browser suite | **219 passed, 18 opt-in skips, 3 WebKit failures** in the initial full run; all Chromium cases passed |
| Initial full extension regression run | First **31 passed**, including native worklet/fallback/tab capture, actual ReazonSpeech/Silero MV3 initialization and graph interaction cases; later migration assertions still expected version 6 and were corrected to version 7 |

Real-model output, timings and browser identity are saved in
[whisper-107.json](whisper-107.json). English was 195,040 mono 16 kHz samples;
Japanese was 208,000 normalized samples after production resampling/flush from
48 kHz. The English fixture produced two finals containing “transformer” on
both English sessions. Japanese produced four completed Japanese-script results.
Whisper's provisional output remained empty. Each new Worker received the saved
language; the test waits for graph persistence before starting a new session.

The fixtures come from the existing checksum-pinned ReazonSpeech mirror revision
and fixture manifest in `scripts/reazon-ja-en-assets.json`. They remain in the
ignored cache, not the extension or this evidence. Capture hardware alone is
replaced with fixture PCM at the production source output in the real smoke;
Whisper, ONNX WASM, Silero, segment policy, language-conditioned inference,
graph and sinks are actual packaged implementations. Deterministic/mocked tests
are not recognition accuracy evidence. No WER/CER, comparative model quality,
accent/noise, mixed-language or sustained real-time throughput claim is made.

## Validation still required before merge

The later fix node reports a successful full extension regression run:
**122 passed, 6 optional real-model smoke skips**, with no failures. Commit
`e33194d1a74317eab08736d000041f133b41e598` fixes the Text persistence test's
Save/reload race by waiting for Save completion and checking the exact stored
literal before reloading. That node also reports successful pinned asset
preparation, extension build, syntax and whitespace checks. The optional smoke
checks were not rerun; the earlier passing Whisper real-model smoke above is
separate evidence. Publication did not rerun these suites.

This successful run supersedes the initial extension registration/setup/teardown
timeouts described in the original PR. The initial-run counts above remain as
historical evidence; the extension regression check is now complete.

Two initial WebKit failures (Pages-prefix worklet instrumentation and microphone
permission instrumentation) passed on an isolated rerun. The WebKit tab-picker
switch test continued to time out waiting for AudioContext closure. An upstream
comparison passed once, so this record does **not** claim a conclusively
pre-existing failure. Resolve or obtain a clean repeat of the broad browser
suite before treating that check as passing. WebKit does not support this MV3
extension; the Whisper support claim and real inference evidence are Chrome-only.

The default suites explicitly skipped opt-in real correction/translation/TTS,
ReazonSpeech benchmark/fixture and optional focused-field smoke environments.
Those unrelated real-model runs were not enabled here. The new mandatory
Whisper real-model smoke was enabled and passed before this checkpoint.
There is no required deployment or manual post-merge verification. The remaining
automated pre-merge regression checks above must not be reported as completed.
