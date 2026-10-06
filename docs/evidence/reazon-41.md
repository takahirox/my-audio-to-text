# ReazonSpeech ja-en comparison acceptance (#41)

Validated locally on 2026-10-05 (Asia/Tokyo), using Chromium 153.0.8010.12 and
WebKit 26.6 on macOS. No publication, physical-device test, or human quality
comparison is claimed. Required post-merge verification: none.

## Implementation and model identity

The selector retains Japanese offline and simulated-streaming choices and adds
`sherpa-ja-en-simulated`. All simulated modes use the existing `ReazonSimulation`
and `silero-worker.js` unchanged: 0.8-second pre-roll, 0.5-second provisional
eligibility, 0.35-second trailing silence, 12-second speech cap, one decode in flight,
coalesced previews and bounded buffering. The bilingual mode uses the same selected
one-thread policy. Two-pass continues to use the Japanese model.

Bilingual weights are the epoch-35 ReazonSpeech ja-en int8 encoder/joiner, fp32
decoder, and tokens at mirror revision `12b44671ff48b9aed622551d64e02fea9a2cf870`.
Model/fixture source URLs and SHA-256 pins are in
[`scripts/reazon-ja-en-assets.json`](../../scripts/reazon-ja-en-assets.json).
The separate generated preload data has SHA-256
`900bca64640c969acdae920b4e797094a9169c5dffa780a3941e1c2659eabea7`.
Staging produced 90,814,718 bytes for `sherpa-ja-en`, 182,901,670 for the unchanged
Japanese bundle, and 13,739,044 for Moonshine. All are ignored generated assets;
the existing Pages preparation command recreates them.

## Automated results

| Check | Result |
| --- | --- |
| `npm test` | 18 passed: audio, shared simulated policy, model and thread selection |
| `npm run test:browser` | 106 passed across Chromium/WebKit; 40 opt-in fixture/benchmark tests skipped without their flags |
| `npm run test:reazon-ja-en` | 2 passed, one complete real-page acceptance test per browser, each exercising Japanese, English, and mixed speech |
| Existing real Japanese smoke tests, both browsers | 8 passed: Moonshine, Japanese ReazonSpeech, Whisper and two-pass |
| `npm run prepare:assets` | Source checksums verified; bilingual staging succeeded |
| `git diff --check` | Passed |

Ordinary tests exercise both simulated selector choices and the actual worker load
configuration with native initialization replaced. They cover readiness of both
workers, VAD/pre-roll/timing, coalescing during blocked inference, final worklet tails,
Stop, Cancel during recording/Stop, reload, repeat, switching, stale worker/session
callbacks, errors, teardown and the original Japanese offline segmentation.

The real ja-en acceptance test verifies each model's hash in the generated preload
table, generated data/manifest identity, byte-identical WASM and ASR wrappers, and
loader equality after removing only the preload table. It uses the actual page,
VAD/controller and recognizer with only the microphone source replaced by WAV
samples. It requires provisional text, nonempty final transcripts, Japanese/Latin
script as appropriate, a drained Stop, three repeated recordings with a single
bilingual model load, unchanged language setting, Cancel clearing diagnostics/results,
and switching back to the Japanese model with the correct diagnostic.

Raw real-inference outputs are saved in
[`reazon-41-chromium.json`](reazon-41-chromium.json) and
[`reazon-41-webkit.json`](reazon-41-webkit.json). Both browsers produced the same
transcripts in this run. The Japanese fixture is 13 seconds, English is about
12.19 seconds, and the upstream mixed fixture is 16 seconds. The mixed transcript
contains both English and Japanese without a language change. These are executable
pipeline checks, not a claim of transcript-quality superiority.

The existing real smoke check used the same pinned Japanese fixture, normalized
to 16 kHz mono PCM16 with `web/audio.js`'s `Resampler`, supplied as `ASR_TEST_WAV`:

```sh
ASR_TEST_WAV="$PWD/.cache/reazon-ja-16k.wav" ASR_BENCHMARK=1 \
  npx playwright test tests/browser/model-smoke.spec.js \
  --grep 'real Japanese inference' --workers=1
```

## Reproduction and limits

Follow the [setup and acceptance commands](https://github.com/takahirox/my-audio-to-text/blob/a05dc1558318c9b3ca0ba6c7c5fc8fded1e18e64/docs/asr-manual-testing.md#reazonspeech-ja-en-comparison-41).
Evaluation WAVs remain only in `.cache/` and are not part of the Pages artifact.
The real checks use the existing header-enabled loopback server for WebKit's nested
pthread workers. Ordinary lifecycle tests use the existing service-worker isolation
path. This does not establish real inference on Pages Safari or physical phones.
The VAD worker still loads the Japanese/Silero combined bundle in its own WASM
instance; memory cost remains substantial. Optional microphone/code-switching
quality and device measurements remain unperformed and do not block #41.
