# Issue #113 — English online Zipformer

This adds an opt-in third ASR node, not a replacement for the default. The
model-specific English node has `audio: MONO_16KHZ_PCM` and real incremental
`provisional: TEXT` / committed `final: TEXT`, with no language input. Graph
version 8, previous migrations, default ReazonSpeech routes, Number duration
configuration and final-only Whisper are retained.

## Reproduce

```sh
npm run setup:extension
npm test
npm run test:browser
python3 scripts/prepare-reazon-ja-en-fixtures.py
ZIPFORMER_SMOKE=1 WHISPER_SMOKE=1 npm run test:extension
```

The new real-model test needs no external deployment, runtime download or
manually granted capture permission. Fixture PCM replaces the capture source;
production graph assembly, core, online Worker, model, CPU SIMD WASM and Live
sinks run in the actual built MV3 extension under its unchanged CSP. Optional
translation/TTS weights are not required. See [model/runtime identity, license,
size and segmentation policy](../zipformer-node.md).

## Evidence

The saved [real model event trace](zipformer-113.json) records browser and model
revision, per-event wall time/audio fed, final strings, worker configuration and
heap sizes, source fixture identity, load/Stop timing, and HTTP request/error
lists. The two upstream speech WAVs are verified against
[scripts/zipformer-assets.json](../../scripts/zipformer-assets.json) before use.
`0.wav` is delivered in real-time 100 ms blocks. `1.wav` is delivered in
irregular accelerated blocks (13/3201/701/1600 samples with 5 ms yields), crosses
the exact 12-second cap, and commits a second tail on Stop. Silence (13 seconds),
empty audio and a repeated `0.wav` recording cover empty segments and fresh state.

The trace establishes changing nonempty partials before any final and before
all sustained speech has arrived; a new segment's partial has a fresh ID and
contains no prior committed prefix. Final segment IDs are ordered and unique,
and the final phrase includes the fixture's ending. Stop leaves no preview,
workers are terminated after every recording, and no HTTP requests or page
errors occur. Deterministic tests separately verify that every captured sample
is accepted exactly once across capped segments and the Stop tail, with no
padding fed into the next segment. The recognizer can still misrecognize or
omit words: output text is not a lossless representation of accepted PCM.

## Measured fixture behavior (2026-10-15)

Headless Chrome 153.0.0.0 on macOS, cross-origin isolated, 16 reported logical
CPUs; one inference thread. These are local observations, not latency bounds.
The WASM heap was 536,870,912 bytes (512 MiB) both at readiness and after drain
for every session; process RSS was not measured.

| Fixture/session | First nonempty partial wall time after feed starts | Audio fed by first partial | Model load | Stop to idle | Last final after Stop request |
| --- | ---: | ---: | ---: | ---: | ---: |
| `0.wav` (real time) | 2,367 ms | 2.400 s | 798 ms | 98 ms | 34 ms |
| `1.wav` (accelerated) | 108 ms | 1.580 s | 280 ms | 111 ms | 65 ms |
| 13 s silence (accelerated) | none | — | 285 ms | 91 ms | none |
| empty | none | — | 286 ms | 20 ms | none |
| `0.wav` repeat (real time) | 2,363 ms | 2.400 s | 284 ms | 97 ms | 41 ms |

The first `0.wav` partial was `THE YE`, followed by multiple changing hypotheses
before the single final. For `1.wav`, the cap final used ID 0 and subsequent
partials/final used ID 1. The tail final ends with `A BLESSED SOUL IN HEAVEN`.
The saved trace includes all complete recognized strings. The model omitted
opening words from the distributed references, and the forced cap caused an
error around the reference phrase about descent/mortals. The captured samples
were retained and decoded; do not interpret fixture keyword assertions as
verbatim correctness or an accuracy improvement over another recognizer.

## Validation status

No comparative WER/CER, real-world microphone/tab accuracy, accent/noise benchmark
or long-recording throughput claim is made. Optional real-model checks that were
not enabled are reported as skips, not passes.

- `npm test`: **318 passed**, no skips.
- Extension build: passed with pinned local assets, unchanged CSP and permissions.
- `npm run test:browser`: **233 passed, 18 opt-in skips**, one WebKit
  repository-prefix worklet observation failed on the parallel run; its focused
  retry passed (1/1). No production audio code was changed for that transient.
- The real Whisper English → Japanese → English packaged regression passed
  on a stable build (1/1). Its first full-suite attempt encountered ENOENT while
  copying `dist/chrome-extension/web/tts-assets`: the build was accidentally
  recreated concurrently. This was a test execution sequencing error; the retry
  used the complete package without changing Whisper or the test assertion.
- Dedicated new-node MV3 checks: **4 passed** (palette/typed routes/help,
  production Worker routing and Stop/repeat, Cancel before/during Stop, decode
  and missing-runtime cleanup). The final editor gesture check was also rerun
  after adding explicit audio/replace/append connection gestures: **1 passed**.
- Real English online model: **1 passed**, exercising five sessions; every
  enabled new-node acceptance check ran without an opt-in skip.
- Complete packaged MV3 run with `ZIPFORMER_SMOKE=1 WHISPER_SMOKE=1`: **134
  passed, 5 skipped, 1 staging-copy error**. The affected Whisper smoke passed
  its isolated retry above, so all 135 enabled tests passed across the run and
  retry. The five skips were optional real Supertonic3/Kokoro, native ASR-to-field
  smoke, and real OPUS-MT ja-en/en-ja smoke; deterministic coverage for those
  branches passed. No new English ASR acceptance test was skipped.

The 18 browser opt-in skips (nine per Chromium/WebKit project) cover correction
WebGPU, real ReazonSpeech/VAD, ja-en fixtures, threading benchmark, real translation
and real TTS smoke checks. They require their respective explicit environment
flags/models and were not counted as inference passes. Real new-node inference
and real Whisper regression were enabled in the packaged MV3 checks instead.

No required post-merge verification or manual deployment step remains.
