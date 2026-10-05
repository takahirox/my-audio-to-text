# Issue #35 implementation and validation

The ReazonSpeech simulated mode now uses Silero VAD from the existing checksum-pinned
sherpa-onnx 1.13.2 archive. It retains 0.8 seconds of available idle pre-roll, makes
provisional snapshots eligible about every 0.5 seconds, finalizes after 0.35 seconds of
classified silence, and forces a disjoint boundary after 12 seconds from detected onset.
Finals include the full intended utterance and Stop flushes active speech and short tails.
Only one offline decode runs at a time; superseded previews are coalesced. Pending audio
and finals are capped at 30 seconds, including VAD work waiting behind synchronous ASR.
The original offline recognizer configuration and segmentation remain unchanged.

The staged VAD wrapper has a scope around its helper declarations because both upstream
ASR and VAD scripts declare `freeConfig` globally. The original ASR wrapper, model data,
and WASM binary are unchanged. Silero's MIT license and attribution are included.

## Checks (2026-10-05)

- `npm ci`: passed; audit reported zero vulnerabilities.
- `python3 scripts/prepare-assets.py`: passed checksum verification and staging for
  Moonshine and sherpa, including the scoped Silero wrapper from the same sherpa archive.
- `npm test`: 14 passed. Deterministic fixtures verify bounded silence/pre-roll, available
  pre-roll length/content, 0.5-second eligibility, coalescing, short-pause reset, exact
  0.35-second endpoints, complete final samples, exact 12-second forced splits without
  loss/duplication, final priority, Stop drainage and backlog accounting.
- `ASR_TEST_VAD=1 npm run test:browser -- --workers=2`: 60 passed across Chromium and
  WebKit; 34 skipped (30 optional real-model WAV checks without supplied audio, four
  existing WebKit import-interception fixtures). This includes the actual pinned Silero
  runtime initializing and processing deterministic silence through the page twice on
  each browser, with no committed utterances, pending audio or runtime errors.
- After tightening pre-roll accounting at the backlog limit,
  `ASR_TEST_VAD=1 npm run test:browser -- tests/browser/reazon-simulated.spec.js --workers=2`:
  all 18 policy/lifecycle checks passed again across Chromium and WebKit.
- `node --check web/app.js`, `node --check web/sherpa-worker.js`, and
  `git diff --check`: passed.

The controlled-worker browser fixtures retain the actual VAD framing, worker message,
recognition and stream-cleanup paths. They verify pre-roll, partial replacement, trailing
silence endpoints, final worklet/VAD tails, forced boundaries, ignored stale utterance
previews, held-inference coalescing/drainage, the 30-second cap, empty recognition/errors,
Cancel during capture/Stop, reload, repeat, backend switching, and stale VAD/text messages.
The existing suite passes for Moonshine, Japanese two-pass, offline ReazonSpeech and
Whisper, including generated Web Audio capture and resampling.

Silero decisions have 32 ms frame resolution and minimal onset/offset hold times. VAD
and ASR share the worker, so a slow offline decode delays speech detection as well as
visible provisional/final results. The source audio remains bounded while it waits.
See the [policy and reproducible commands](../asr-manual-testing.md#reazonspeech-simulated-streaming-comparison-33).

Japanese real-model recognition/accuracy, human microphone comparisons, physical mobile
performance, and deployment were not tested. A Japanese WAV integration test is available
through `ASR_TEST_WAV`; these optional observations do not block #35. Required post-merge
verification: none. No GitHub writes or publication were performed.
