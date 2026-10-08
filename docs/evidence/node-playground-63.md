# Issue #63 validation

Validated in the assigned worktree on October 8, 2026.

`web/index.html` is now the Node Playground list. Its Speech-to-Text entry opens
`web/nodes/speech-to-text/index.html`, with a return link to the list. The moved
controller matches the previous controller except for shared module imports and
the root isolation-worker registration URL. It still constructs the real
microphone/tab source → `SpeechToTextNode` → `TranscriptOutputNode` pipeline.
Model identity, processing policy, workers and Node/Port implementation are
unchanged. Default worker/worklet URLs now resolve relative to the owning shared
modules so nested pages retain the correct asset directory.

| Check | Result |
| --- | --- |
| `npm ci` | Passed. |
| `npm test` | **97 passed**, no failures/skips. |
| `npm run test:browser -- --workers=2` | **110 passed, 6 opt-in tests skipped**, no failures; Chromium/WebKit. |
| Repository-prefix navigation/pipeline check | **2 passed** in Chromium/WebKit; index click, root worker scope, isolation, shared modules, native capture worklet, ASR/VAD worker URLs, provisional/final output, Stop/release and notices all retain `/my-audio-to-text/`. |
| `npm run prepare:assets` | Passed; checksum-pinned 90.8 MB runtime/model distribution staged. |
| `npm run build:extension` | Passed with prepared assets; packaging remains independent of Playground pages. |
| `npm run test:extension` | **19 passed**, including native toolbar/tab capture and actual pinned model initialization under MV3 CSP. |
| `ASR_TEST_VAD=1 npm run test:browser -- tests/browser/model-smoke.spec.js --project=chromium --workers=1` | **1 passed**; real ReazonSpeech/Silero assets load on the migrated page with service-worker isolation, silence, Stop and repeat. |
| `npm run test:reazon-ja-en` | **2 passed**; actual Japanese, English and mixed-speech recognition through the migrated page in Chromium/WebKit, including provisional/final output, silence endpoint, Stop, warm repeat, Cancel and reload. |
| `git diff --check`, controller syntax, relative documentation links | Passed. |

The first full browser run exposed a test observation issue: Chromium did not
surface native worklet responses through the page's response event, although
capture and transcript output completed. The prefix test now observes the native
`addModule()` call and verifies the asset response directly. Its targeted rerun
and the final full suite both passed.

Deterministic tests retain both real source helpers, native worklet/fallback
capture, the production speech node/core and transcript sink; only permission
APIs and heavyweight worker initialization/replies are controlled. They cover
model readiness/errors/retry, source permission and late-grant cleanup,
provisional/final display and empty-final fallback, Stop/drain, Cancel/release,
repeat, diagnostics, source switching, background tab capture and stale results.
The index has no recognition controller or model/configuration selector.

The six ordinary-suite skips are opt-in model smoke, real ja-en recognition and
threading benchmarks in each browser. Enabled real-model checks are recorded
separately above. Physical-device performance and the native Web sharing picker
were not manually tested; no new accuracy or performance claim is made.

## Required post-merge verification

**Pending. Keep Issue #63 open.** No push, PR, merge, comment or deployment was
performed in this implementation node. After merging and Pages deployment,
verify the successful deployment run's merged commit SHA, the canonical list
and Speech-to-Text navigation/direct page, isolation/model readiness, and all
required static assets under the repository prefix. Record the run URL, SHA,
timestamp and browser/network evidence following the
[verification instructions](../node-playground.md#required-post-merge-verification).
Local validation does not establish publication of the merged revision.
