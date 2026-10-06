# Issue #43: Japanese ReazonSpeech baseline simplification

Validated locally on 2026-10-06 with Playwright Chromium 153.0.8010.12 and WebKit 26.6.

## Result

The page exposes only the Japanese ReazonSpeech simulated-streaming baseline. Backend/language/sensitivity selectors, the first-pass transcript, removed model workers/configuration, offline comparison segmentation, bilingual asset packaging/fixtures, and experiment-only tests are deleted. Microphone, VAD, provisional/final transcript, timing, thread, backlog, and error diagnostics remain.

The retained utterance controller and Silero worker are unchanged: 0.8-second pre-roll, 0.5-second provisional eligibility, 0.35-second trailing silence, 12-second maximum duration, separate ASR/VAD workers, one decode in flight, coalesced previews, prioritized finals, and a 30-second pending-audio limit. The evidence-based one-thread ASR default and capability checks are preserved.

Asset preparation uses only the checksum-pinned Japanese sherpa-onnx distribution. It rebuilds the generated vendor directory so assets left by earlier experiments cannot be packaged on subsequent preparations. The final manifest contains only `sherpa`; its directory contains five runtime/model files totaling **182,901,670 bytes**. No weights or generated runtime files are committed.

README and current testing instructions describe a replaceable development baseline. Historical comparison evidence remains; links to removed manual instructions now point to their preserved Git revision.

## Executed checks

| Check | Result |
| --- | --- |
| `npm ci` | Passed; three packages installed, audit reported zero vulnerabilities |
| `npm test` | 15 passed, including asset replacement/checksum failure, resampling, utterance policy, bounds, and evidence-based thread selection |
| `npm run test:browser -- --workers=2` | 44 passed across Chromium/WebKit; four opt-in smoke/benchmark cases skipped in this default run |
| `npm run prepare:assets` | Passed checksum verification and baseline-only staging; final manifest/file set verified |
| `ASR_TEST_VAD=1 npm run test:browser -- tests/browser/model-smoke.spec.js --workers=1` | Two passed; real runtime readiness, Silero silence classification, Stop, and repeat |
| `ASR_TEST_WAV="$PWD/.cache/reazon-ja-16k.wav" npm run test:browser -- tests/browser/model-smoke.spec.js --workers=1` | Two passed; real Japanese model/VAD readiness, nonempty provisional output, Japanese final text, Stop, and repeat |
| `git diff --check` | Passed |

Deterministic browser coverage includes readiness of both workers, microphone denial and pending permission cancellation, actual Web Audio capture/worklet flushing, mobile-sized layout, provisional/final timing, pre-roll, silence endpoints, forced duration boundaries, Stop draining, Cancel during recording/Stop, reload/repeat, stale callbacks/sessions, separate VAD progress during blocked ASR, coalescing, backlog errors, decode errors, and thread configuration reaching the recognizer.

The real speech check used the checksum-pinned upstream `ja.wav` from `scripts/prepare-reazon-benchmark.py` (SHA-256 `780f95a86ba6cc33a4431fcafeacd213417dfa0a6613f93e4400c18f4dd467b0`). Its 44.1 kHz mono PCM was resampled with `web/audio.js`'s `Resampler` to 16 kHz, rounded/clamped to 16-bit PCM, and written to the ignored development cache (8.16 seconds). Smoke tests inject those samples at the microphone callback boundary while retaining actual Silero, ASR, utterance policy, transfers, and session handling. No audio is uploaded.

These checks establish local automated behavior. They do not claim human recognition accuracy, physical-device performance, or a newly published deployment. The optional full threading benchmark was not rerun; its recorded evidence continues to justify the unchanged default. Issue #43 requires no post-merge verification.
