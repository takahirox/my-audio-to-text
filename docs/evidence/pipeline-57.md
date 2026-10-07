# Issue #57 validation

Validated in the assigned worktree on October 7, 2026.

## Implemented scope

The generic runtime provides shared port-contract identities, named inputs and
outputs, explicit validated acyclic connections, asynchronous fan-out with
independent serial node queues, consumer-first startup, producer-first graceful
draining, immediate cancellation and stale-emitter rejection. Input/background
errors isolate the failing node and are reported to the caller. Startup failures
release the graph; disposal attempts every node's resource cleanup.

The executable integration is `createTabTranscriptionPipeline()` in
`web/transcription-nodes.js`. It connects the real `BrowserTab` source to one
`LocalAsrCore` adapter and an async transcript sink through both provisional and
final ports. See the [contract and executable example](../pipeline-runtime.md).
The existing playground and extension integrations remain in place. No ASR,
VAD, worker, model or hayamimi policy implementation was modified.

## Checks

| Check | Result |
| --- | --- |
| `npm ci` | Passed; installed the pinned development dependencies. |
| `npm test` (final runtime) | **88 passed**, no failures/skips. |
| `npm run test:browser -- --workers=2` | **92 passed, 6 opt-in tests skipped**, no failures; Chromium and WebKit. Includes the new pipeline's native worklet/fallback capture checks. |
| `npm run test:browser -- tests/browser/tab-audio.spec.js --grep 'composable tab pipeline' --workers=2` (final runtime and added pending-permission cancellation test) | **6 passed**, no failures/skips; Chromium and WebKit. |
| `npm run prepare:assets` | Passed; checksum-pinned ReazonSpeech ja-en/Silero assets staged. |
| `npm run build:extension` | Passed. |
| `npm run test:extension` | **14 passed**, including real toolbar/tab capture and real pinned worker initialization under MV3 CSP. |
| `npm run test:reazon-ja-en` | **2 passed**, real-model Japanese, English and mixed speech in Chromium/WebKit. This separately executes the ja-en test skipped by the ordinary browser command. |
| `git diff --check` | Passed. |

The full browser suite preceded the final disposal-state guards and the added
pending-permission graph cancellation test. All graph-specific browser checks
and all unit tests were rerun after those changes. No existing playground or
extension code changed between checks.

Deterministic tests cover unknown/incompatible ports, contract identity,
duplicate/cyclic graphs, multiple inputs and outputs, asynchronous fan-out,
independent slow branches, async initialization/input/flush/disposal, final
capture tails, ordered draining, failure isolation, startup cleanup, unknown
output errors, and cancellation during loading/input/drain. Adapter tests use
the real ASR core with controlled transferable worker messages and verify
unchanged provisional fallback. Real capture/resampling graph tests check
16/44.1/48 kHz stereo input, mono conversion, every final tail sample, and
worker/track/context cleanup. Native browser graph tests verify both capture
implementations plus disposal before a delayed permission grant.

The ordinary browser suite's optional real-runtime smoke and threading benchmark
checks were not enabled. Real-model ja-en transcription and extension model
initialization were verified separately as listed above. No native sharing picker,
physical-device performance or new recognition-accuracy claim is made.

No post-merge verification is required by Issue #57.
