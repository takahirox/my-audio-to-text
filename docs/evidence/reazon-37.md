# Issue #37 implementation and validation

Silero classification now runs in `web/silero-worker.js`, independently of the
ReazonSpeech worker's serialized offline decoding. The page routes microphone audio
and the VAD Stop barrier to Silero, then passes classified frames to the unchanged
`ReazonSimulation` policy. ASR snapshots still go to `web/sherpa-worker.js` with at
most one decode active, no provisional queue, and completed utterances taking priority.
The recognizer configuration, model, thread count, VAD configuration and #35 timing
constants are unchanged.

Start waits for both workers. Stop flushes microphone/VAD tails, resets VAD after
classification, and drains completed/active utterances before allowing repeat recording.
ASR streams are freed after decoding. Models remain loaded for repeat recording;
Cancel, configuration changes, errors, and page teardown terminate both workers and
invalidate capture callbacks and worker results. Worker identity and recording generation
checks protect both paths from stale events. The existing 30-second backlog cap remains.

The split uses the existing checksum-pinned sherpa distribution, without adding a model
or a runtime version. Each worker initializes a separate WASM instance. Because the
upstream runtime bundles VAD and ASR model data, that data is loaded in both instances;
this increases memory use. A VAD-only asset distribution and worker pool are outside
this change.

## Checks (2026-10-05)

- `npm ci`: passed; audit reported zero vulnerabilities.
- `npm test`: all 14 passed. Existing fixtures verify exact pre-roll, provisional
  eligibility, trailing-silence endpoints, pause resets, maximum duration, final audio
  continuity, coalescing, Stop drainage and backlog accounting.
- `npm run test:browser -- --workers=2`: 64 passed across Chromium and WebKit;
  36 skipped (32 opt-in real-model/audio checks without their environment variables,
  four existing WebKit import-interception fixtures). Existing Moonshine, Japanese
  two-pass, offline ReazonSpeech, Whisper, and Web Audio capture/resampling tests pass.
- After strengthening the fixture to exercise the actual Silero initialization
  configuration, `npm run test:browser -- tests/browser/reazon-simulated.spec.js
  --workers=2`: all 24 passed across Chromium and WebKit.
- `python3 scripts/prepare-assets.py`: passed checksum verification and staging for
  the unchanged pinned Moonshine and sherpa archives (sherpa SHA-256:
  `49c26de5550b2e1fec3e322b1fa909331ff027a4c0c76954f6d793102a4f4204`).
- `ASR_TEST_VAD=1 npm run test:browser -- tests/browser/model-smoke.spec.js
  --grep 'ReazonSpeech simulated' --workers=2`: both passed. The real Silero and
  ReazonSpeech workers initialize independently, classify generated silence, and drain
  Stop twice on Chromium and WebKit, without utterances, pending audio or runtime errors.
  These exercise two of the full suite's opt-in skips; 34 checks remain unperformed
  (30 optional WAV/model evaluations and four existing WebKit interception fixtures).
- Syntax checks for `web/app.js`, both workers and the revised browser fixture, plus
  `git diff --check`: passed.

The controlled browser fixture holds a decode inside the actual ASR message sequence.
A probe posted behind it cannot complete until the test releases decoding. Meanwhile,
Silero classifies eight additional speech blocks, with only one ASR request active;
release schedules exactly the latest eligible snapshot. A silence endpoint and subsequent
speech detected during the next held preview are retained, its ended preview is ignored,
and final decoding takes priority. Stop drains both intended utterances once. Additional
checks cover readiness in both load orders, short capture/VAD tails, empty recognition,
errors, repeat, Cancel during recording/Stop, backend switching, page teardown, and stale
VAD/ASR events from both replaced workers and earlier recording generations. The
fixtures replace heavyweight inference while retaining worker messaging, VAD framing,
the complete Silero configuration, ASR stream cleanup, and page scheduling.

Japanese recognition/accuracy, subjective latency, physical devices and deployment were
not tested. Those observations are optional for #37. Required post-merge verification:
none. No GitHub writes or publication were performed.
