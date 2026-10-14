# Issue #103: Number-configured speech segment duration

Validated in the assigned worktree on 2026-10-14. No push, PR, merge or Issue
comment was performed. No post-merge verification is required by the Issue.

## Implemented behavior

- Generic `NumberNode` / Graph Editor Number emits a bare finite `NUMBER` from
  `value`; consumers define units and limits.
- Optional `SpeechToText.maxDuration` defaults to 6 seconds. A connected Number
  is delivered from the validated graph snapshot before Node startup, outside
  the streaming audio routes. Only Number constants support this configuration
  port. Saves during loading/capture apply at the next session.
- Duration accepts finite numeric 1–12 seconds, including fractions, rounded
  down to whole 16 kHz samples. Explicit invalid values fail before Workers or
  capture; no clamp or fallback. The lower bound accommodates 0.8 s pre-roll,
  and the upper bound preserves the existing ASR policy / pending-audio limits.
- VAD endpoint or the cap finalizes the whole audio segment, including pre-roll
  and silence. Splits own disjoint adjacent samples, and ongoing speech resumes
  without repeating pre-roll. Serialized finals, per-ID provisional fallback,
  Stop tails, Cancel and 30-second backlog protection remain intact.
- ReazonSpeech ja-en still uses simulated streaming / offline inference. A cap
  does not bound final-result latency, and mid-sentence cuts can reduce accuracy.
- Existing version 6 graphs require no migration; versions 1–5 retain their
  existing migrations, default ports and audio/display routes.

## Automated evidence

- `npm test`: **289 passed**, no failures/skips. Includes generic Number reuse,
  strict numeric validation, default/connected caps, save/reload, editor type
  checks, saved edits during load/capture, warm-core handoff with a different
  next-session value, exact sample continuity for 1 / 1.234567 / 6 / 12 seconds,
  VAD ending sooner, consecutive long utterances, FIFO/final-once delivery,
  stale-preview rejection, per-segment fallback reset, pending VAD tail drain,
  Cancel at a boundary / final inference / Stop drain, and backlog protection.
- `npm run build:extension`: **passed** after preparing checksum-pinned ASR,
  translation and TTS runtimes. Packages `number-node.js` with shared Nodes.
- `npm run test:extension -- --output=test-results/extension-final`: **116 passed,
  5 optional skips, no failures** in the final full MV3 suite. Includes real
  pinned ReazonSpeech/Silero initialization under MV3 CSP, existing saved graph
  migrations, native capture, Number configuration, output routing, lifecycle,
  field sinks and translation regression checks.
- `npm run test:browser -- --workers=2`: **221 passed, 18 optional skips, 1
  transient failure** in existing WebKit tab-picker cancellation, waiting for
  an AudioContext to close. `npm run test:browser -- tests/browser/tab-audio.spec.js
  --project=webkit --workers=1`: **25 passed**, including that test; no production
  capture changes were needed.
- `npm run test:browser -- tests/browser/reazon-simulated.spec.js --workers=2
  --output=test-results/segmentation-rerun`: **30 passed** on Chromium/WebKit
  with the final source. Uses production VAD framing/worker paths with fixture
  model initialization/inference; default continuous caps and exact concatenated
  audio, previews, endpoints, Stop, Cancel and worker isolation are covered.
- `npm run test:extension -- tests/extension/graph-number.spec.js
  --output=test-results/number-rerun`: **3 passed** against the rebuilt MV3 package.
  Covers real graph/storage/editor/core/display Nodes, Number → configuration,
  ChromeTabAudio → PCM, provisional → replace / final → append, cap-before-capture,
  editor errors/save/reload, unchanged active value and changed next-session
  value, sample continuity, tail drain and cancellation of pending capped finals.
  Capture, VAD classification and ASR inference are fixture seams. Initial packaged tests
  used an incorrect Cancel selector; it was fixed before this passing rerun.

## Optional checks

Real-model speech recognition/accuracy smoke, bilingual fixtures and thread
benchmark were **not enabled**. Optional real correction, translation and TTS
inference checks were also not enabled (18 browser skips; 5 MV3 skips cover real
ASR field fan-out, both translation directions and both TTS models). Fixture
inference establishes lifecycle/audio ownership, not
recognition quality or a final-result latency SLA. The standard packaged suite's
real pinned ASR/Silero initialization under MV3 CSP is enabled.
