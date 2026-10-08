# Issue #61 validation

Validated in the assigned worktree on October 8, 2026.

The extension connects `ExtensionTabAudioNode.audio` to the shared
`SpeechToTextNode.audio`, then routes provisional and final transcript ports to
`TranscriptOutputNode`. `TabSession` retains tab targeting, rendering, status
and user actions. The extension adapter reuses the existing audio node lifecycle
and `ExtensionTab` capture/resampling helpers. The shared pipeline, speech node,
ASR core, recognition workers, models, policy and manifest are unchanged.

Models preload before requesting capture. Stop, captured-tab close/navigation
and stream end drain capture, VAD/ASR and the transcript sink before completion.
The audio adapter can settle pending startup or stop before capture is requested.
Loading cancellation, teardown and errors dispose the graph; node abort signals
and session guards suppress stale audio and transcript output. Each retry uses a
fresh graph and workers, preserving existing extension behavior.

| Check | Result |
| --- | --- |
| `npm ci` | Passed; zero reported vulnerabilities. |
| `npx playwright install chromium webkit` | Passed. |
| `npm run prepare:assets` | Passed; pinned ja-en/Silero assets staged. |
| `npm run build:extension` | Passed; shared runtime/nodes included in the unpacked package. |
| `npm test` | **97 passed**, no failures/skips. |
| `npm run test:browser` | **108 passed, 6 existing opt-in tests skipped**, no failures; Chromium/WebKit. |
| `npm run test:extension` | **19 passed**, no failures/skips. |
| `git diff --check` | Passed. |

Unit checks exercise extension capture through the declared audio port at
16/44.1/48 kHz, exact mono resampling and tail delivery, one playback connection,
transcript ports, Stop/repeat, pending startup/end, failures and stale sessions.
Package checks verify byte-identical shared modules/models and the existing
minimum permissions.

The extension suite loads the actual packaged MV3 manifest under its CSP.
Controlled capture APIs use real stereo Web Audio and worklet/fallback processing
with deterministic worker transcripts. Graph observers verify the shared node
types and lifecycle. A delayed final sink keeps the UI finalizing and workers
alive until delivery; teardown aborts held output. Preload progress/cancellation,
worker failures/retry, permission errors, silence and capture cleanup also pass.

Native Chrome checks use the toolbar action on an active generated-audio tab,
without a sharing picker. A second invocation during capture retains the original
tab; Stop/repeat, navigation, retargeting, tab close and window teardown release
capture. An uninvoked tab is denied. Real pinned ReazonSpeech ja-en/Silero workers
load and drain a silent session through `TabSession`'s pipeline under MV3 CSP.

The six Web skips are the existing optional model smoke, bilingual speech and
thread benchmark checks. Fixture transcripts validate delivery and lifecycle;
no new speech-accuracy or subjective playback claim is made. No post-merge
verification is required by Issue #61. See the [extension guide](../chrome-extension.md).
