# Issue #105: Remove the Live instructional footer

Validated in the assigned worktree on 2026-10-14.

The entire static instructional footer is removed from `extension/recorder.html`
and the built MV3 page. Graph-configured display regions, recording and copy
controls, capture/processing status and actionable errors retain their existing
markup and behavior. Runtime JavaScript and shared styles are unchanged.

Detailed replace/append and session guidance remains in Graph Editor help and
`docs/extension-graph.md`; capture-window and copy-before-close guidance remains
in `docs/chrome-extension.md`. The checked-in [Live screenshot](ui-77-live.png)
was regenerated with the existing deterministic MV3 screenshot test.

| Check | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm run prepare:assets`, `prepare:translation-assets`, `prepare:tts-assets` | Passed; checksum-pinned assets staged |
| `npm run build:extension` | Passed |
| `npm test` | 289 passed; no failures/skips |
| `npm run test:browser -- --workers=2 --output=test-results/issue-105-browser` | 222 passed, 18 optional skips; no failures |
| `npm run test:extension -- --output=test-results/issue-105-extension` | 117 passed, 5 optional skips; no failures |
| `git diff --check` | Passed |

The new packaged MV3 regression checks footer/paragraph absence alongside a
configured display, Start/Stop/Cancel and Copy text controls, polite live regions,
active status, visible capture-retry errors and retained final output after Stop.
Existing copy, recording lifecycle, generic graph rendering, layout/accessibility
and real pinned ReazonSpeech/Silero initialization checks passed. An initial
focused run used a role selector for an empty alert hidden by existing CSS; the
assertion was corrected before the passing full suite.

Optional real speech-recognition, correction, translation and TTS inference
smokes and the thread benchmark were not enabled. The 5 MV3 skips cover real
ASR field fan-out, both OPUS-MT directions and both TTS models; the 18 browser
skips cover the opt-in model/benchmark cases on Chromium and WebKit. Fixture
inference validates UI and lifecycle behavior, not speech accuracy.

No push, PR, merge or Issue comment was performed. The Issue requires no
post-merge verification.
