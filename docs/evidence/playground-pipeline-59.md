# Issue #59 validation

Validated in the assigned worktree on October 7, 2026.

The Web playground now connects `MicrophoneAudioNode` or `BrowserTabAudioNode`
to one `SpeechToTextNode` and a `TranscriptOutputNode` through audio,
provisional and final ports. UI observers retain source signal/RMS and core
configuration, progress, pending-audio and speech diagnostics. Transcript
presentation uses only sink inputs. The generic runtime, capture helpers,
recognition policy, workers, model specifications and Chrome extension source
are unchanged.

Stop drains the whole pipeline before Ready. Repeat creates a fresh graph and
explicitly transfers the successfully drained speech node's sole ownership of
its warm core, retaining one model load and the same two workers. Cancel,
source change, reload, error and teardown dispose the graph and invalidate UI
observers. Source nodes settle ended capture setup without waiting for late
permission/worklet completion. Microphone stop-on-hide lives in its source node;
tab capture continues in the background.

| Check | Result |
| --- | --- |
| `npm ci` | Passed. |
| `npm test` | **92 passed**, no failures/skips. |
| `npm run test:browser -- --workers=2` | **104 passed, 6 opt-in tests skipped**, no failures; Chromium/WebKit. |
| `npm run test:browser -- tests/browser/playground.spec.js tests/browser/tab-audio.spec.js --grep 'pipeline (drain\|cancel)\|hiding while' --workers=2` | **12 passed**, no failures/skips; final adapter and gesture assertions. |
| `npm run test:browser -- tests/browser/reazon-simulated.spec.js --grep 'preload' --workers=2` | **4 passed**, no failures/skips; Cancel, stale readiness, load errors and retry in Chromium/WebKit. |
| `npm run prepare:assets` | Passed; checksum-pinned runtime/models staged. |
| `npm run build:extension` | Passed with the prepared assets. |
| `npm run test:extension` | **13 capture/lifecycle checks passed** with source-only fixture staging; the remaining model check required prepared assets (below). |
| `npm run test:extension -- --grep 'real pinned'` | **1 passed** after asset preparation/build; actual pinned workers initialize and drain under MV3 CSP. All 14 extension cases passed across these checks. |
| `npm run test:reazon-ja-en` | **2 passed**; real-model Japanese, English and mixed speech in Chromium/WebKit through one model load and repeated pipeline sessions. |
| `git diff --check` | Passed. |

Unit coverage includes real microphone/tab capture and resampling at
16/44.1/48 kHz, capture tail draining, warm-core handoff, no model reload,
worker ownership/release and stale outputs across fresh graphs. Browser checks
observe the production graph types and lifecycle hooks for both sources. A
held transcript sink proves Ready waits for output drain and cancellation can
interrupt it without stale text in a replacement session. Native worklet and
fallback capture, model readiness, provisional/final fallback, diagnostics,
Stop, repeat, pending permission, visibility, sharing end, source change,
worker errors and teardown continue to pass.

The full browser suite preceded the final already-resolved preload promise
cleanup and microphone gesture assertions; all unit tests and the focused
pipeline browser checks were rerun after those changes. Added preload
cancellation/error recovery checks also passed in both browsers.

The real-model checks separately execute the ja-en tests skipped by the
ordinary browser suite. Optional silence/WAV smoke and threading benchmarks
were not enabled. No native sharing-picker, physical-device performance or new
recognition accuracy claim is made. No post-merge verification is required by Issue #59.
