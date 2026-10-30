# Speaker output (#164)

SpeakerOutput is a separate Outputs palette entry with one SYNTHESIZED_AUDIO
input and no outputs/settings. Existing AudioOutput/manual player/WAV code and
saved graph version remain unchanged. The implementation uses one owned Web
Audio context per Speaker, initialized synchronously by Live's Start gesture,
and one source at a time. Playback happens only in the open Live extension UI.

The queue retains arrival order and snapshots accepted PCM. Limits include the
playing clip: 32 clips, 120 seconds or 32 MiB PCM, plus one browser AudioBuffer.
Overflow explicitly counts rejected clips, stops accepting new audio for that
session, and preserves accepted audio for Stop to drain. Enable speaker retries
blocked output without replaying completed clips. Cancel/close immediately halt
output, release source buffers and close contexts. Fresh Start owns fresh state.

Validation on 2026-10-30:

- `npm test`: 627 passed, including nine focused Speaker tests. These cover FIFO
  playback/no overlap or replay, native sample-rate preservation, copied PCM,
  Stop's upstream final delivery and playback drain, cancellation, blocked/pending
  resume, missing output, closed-context recovery instructions, all three queue
  bounds, both TTS graph contracts/Save/reload, unchanged old AudioOutput graphs,
  gesture timing, repeated sessions and cancellation before microphone permission.
- `npx playwright test tests/browser/speaker.spec.js --workers=2`: six passed
  across Chromium and WebKit. Uses native AudioContext/AudioBufferSourceNode with
  controlled 24 kHz clips. Observes source start/end order, PCM identity, browser
  playback time and closed contexts. Exercises activation failure/recovery during
  Stop, immediate Cancel, late end callbacks and repeated Start. Run here with
  `ASR_BASE_URL` pointing to a task-owned local server on an ephemeral port because
  the configured port 8000 was already in use.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-speaker.spec.js`:
  six passed. Exercises Outputs palette, connections, save/reload, production
  graph routing and TTS Workers under MV3 CSP, using controlled Supertonic3
  (44.1 kHz) and Kokoro (24 kHz) synthesis fixtures. Native Web Audio renders the
  resulting consecutive clips automatically. Covers blocked resume, missing
  output recovery, 34 generated clips with 32 accepted/two explicitly rejected,
  Stop drain, Cancel during pending synthesis, repeated Start and Live close.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph.spec.js --grep 'visual final-text/audio'`:
  two passed. Existing manual player/WAV tests for both TTS types cover explicit
  playback, repeated sessions, synthesis drain, cancellation and cache failures.
- `git diff --check`: passed.

`npm run build:extension` is blocked by absent prepared production model assets:
“Missing local models. Run npm run prepare:assets first.” The MV3 checks use an
ignored source-only package in `dist/chrome-extension`, marked FIXTURE-ONLY.txt,
containing extension/, its root manifest, and the builder's exact SHARED_FILES
under web/. Existing test fixtures provide controlled model assets/runtimes;
production graph, session, TTS Worker RPC and Speaker playback code are retained.
The unit packaging check also exercises the actual builder against fixture asset
manifests and verifies byte-identical shared files and unchanged permissions/CSP.

Real model inference, physical speaker audibility/default OS device selection,
and unplugging physical audio hardware were not validated. Autoplay rejection,
pending activation and missing output failures are controlled fixtures; native
browser output timing and resource closure are exercised in headless browsers.
No production model readiness or background playback is claimed.
