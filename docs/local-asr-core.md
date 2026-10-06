# Local ASR core boundary

`web/local-asr-core.js` exports `LocalAsrCore`: normalized **mono 16 kHz
Float32Array PCM blocks** in, recognition events out. It has no microphone,
permission, resampling, Web Audio, or DOM dependency. The browser implementation
uses ReazonSpeech **ja-en**, sherpa-onnx and Silero in separate workers, retaining
the hayamimi-inspired utterance policy. A future native implementation can
reproduce this behavioral contract with a platform-appropriate runtime; this
boundary does not require sharing browser WASM across platforms.

## Operations

```js
import { LocalAsrCore } from './local-asr-core.js';

const core = new LocalAsrCore(event => {
  // Handle ready, transcript, lifecycle, diagnostics and error events here.
});
core.load();               // Asynchronously load both workers.
// After the ready event:
core.start();              // Begin a fresh recognition session.
core.push(pcm);            // One mono 16 kHz Float32Array, of any block length.
// Stop the audio source and push its final PCM tail before calling:
core.stop();               // Flush VAD, finalize speech, then drain inference.
// After stopped, start() may begin another session without reloading models.
core.release();            // Cancel immediately and terminate both workers.
```

The source owns device capture and conversion to the input format. Sample rate
and channel layout are a caller precondition; a typed array contains no metadata
with which to detect an incorrect rate or interleaved channels. The core copies
input before transfer so callers retain their arrays, including subarray views.
Empty blocks have no effect. Blocks outside a running session are ignored.
`start()` requires readiness and `load()` requires release; invalid lifecycle
calls throw. `stop()` and `release()` are idempotent. Release discards pending
work and rejects callbacks from terminated workers. `load()` can reuse a released
core. Worker/pipeline errors release both workers before emitting `error`.

Stop accepts no more PCM after the call, suppresses pending provisional results,
waits for VAD's final short frame, and emits `stopped` only after all finals drain.
The browser app first stops/flushes its microphone, then calls `core.stop()`.
The app suppresses provisional display while the source is flushing. Cancel and
page teardown call `release()` immediately, then release capture separately.
Capture callbacks carry their own session guard so a canceled source cannot feed
a new recognition session. Recognition generation and utterance filtering are
owned by the core.

## Events

One callback receives small objects with a `type` field; there is no event bus.

| Type | Fields / meaning |
| --- | --- |
| `progress` | `message`: runtime loading/status text |
| `configuration` | `model`, `modelName`, `numThreads`: active recognizer diagnostic |
| `ready` | Both VAD and ASR initialized; `start()` is allowed |
| `speech` | `event` is `started` or `completed`; `id` identifies the utterance within this session |
| `partial` | `text`, `id`: provisional replacement for an active utterance; may be empty |
| `final` | `text`, `id`: committed utterance result; may be empty |
| `diagnostics` | `pendingSamples`: VAD input plus active/queued utterance audio and final inference in flight |
| `stopped` | VAD and recognition drained; another `start()` is allowed |
| `error` | `message`: released pipeline failure; load again to retry |

`speech.completed` marks an audio endpoint, before its final inference result.
A forced duration endpoint starts a new utterance if speech continues. Transcript
IDs match speech IDs and restart with each session. Empty transcripts still
represent completed recognition work; the UI counts only nonempty text.
Idle pre-roll is bounded separately and excluded from `pendingSamples`. Pending
previews are coalesced rather than queued. Stale sessions, results for an ended
utterance preview, and messages from old workers never reach the event callback.

## Retained configuration and implementation

[`web/local-asr-config.js`](../web/local-asr-config.js) owns the model identity,
input rate, 0.8 s pre-roll, 0.5 s provisional interval, 0.35 s trailing silence,
12 s maximum utterance duration (excluding pre-roll), 30 s pending-audio limit,
and Silero settings (threshold 0.5, 512-sample windows, one thread). These describe
the retained baseline, not a new runtime-selectable tuning API.
[`web/reazon-config.js`](../web/reazon-config.js) retains the evidence-based
one-thread default and capability-aware selection within the four-thread runtime
cap. Explicit 1/2/4-thread requests remain limited to the existing benchmark.

`LocalAsrCore` owns worker creation, protocol messages, readiness, session
isolation, input backpressure, Stop/draining, and release/error handling.
`ReazonSimulation` is its internal utterance policy: finals take priority over
the latest eligible preview, with one decode in flight. The workers own only
runtime loading, VAD classification, and individual offline decodes.
`web/app.js` owns source lifetime, UI state, microphone signal and elapsed-time
diagnostics, and rendering the recognition events.

## Executable verification

```sh
npm ci
npm test
npm run test:browser -- --workers=2
```

`tests/local-asr-core.test.js` drives PCM and independent worker fixtures without
browser globals or a microphone. It covers readiness, input ownership, pre-roll,
provisional/final/speech events, coalescing, duration limits, Stop including a VAD
tail, empty output, release during inference/draining, stale generations, bounded
backpressure and worker/pipeline errors. Existing policy tests and Chromium/WebKit
browser tests cover the retained worker paths and actual capture/resampling
lifecycle. Real-model checks remain available via the commands in
[setup and testing](asr-manual-testing.md); fixture checks do not measure speech
accuracy. No post-merge verification is required for Issue #47.
