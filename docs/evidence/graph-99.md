# Graph-driven Live TEXT display (#99)

Local verification on 2026-10-14, macOS, Node v24.12.0 and Playwright 1.63.0.
The artifact is the repository worktree; the MV3 package is built under
`dist/chrome-extension/` using the prepared, pinned runtime assets.

## Implementation and compatibility

Version 6 uses generic `LiveTextDisplay` sinks and optional `TextFormatter`
processors. Their shared implementations in `web/text-nodes.js` have only
primitive TEXT ports and no Chrome, ASR or translation dependency. Live renders
sink regions in configured Node order with safe labels and plain text, from the
active graph snapshot. No fixed original/translated panels or one-display-per-
model restrictions remain. Field and audio outputs can run without Live text.

Every append commits a separate item and clears the replace preview, including
empty/repeated items. Append wins in a directly grouped replace/append update.
Replace can explicitly clear with an empty string. Mixed sinks clear previews
on Stop/Cancel; replace-only sinks retain their current value for copying.
A fresh session creates new state. Independent formatter emissions update latest
values immediately; directly grouped values format once, without cross-branch
matching. Templates are bounded and support numbered substitutions, literal
labels/newlines and doubled-brace escaping only.

Frozen v1–v5 descriptions test explicit migration. Plain legacy views become
generic sinks. Paired legacy views keep every primitive source/status/index/error
route through the narrow `PairedTextFormatter` compatibility processor, whose
whole-history TEXT replacements preserve indexed repeated sources, pending/error
updates, stale-preview suppression and canceled rows. Both translation directions
are tested, including independently configured original-display language and TEXT
fan-out. Malformed/incomplete bundles and size-limit recovery preserve the saved
JSON rather than silently dropping routes. Long/colliding IDs migrate safely.

## Checks

| Command | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm run prepare:assets` | Passed; pinned bundled ReazonSpeech/Silero runtimes/models staged |
| `npm run prepare:translation-assets` | Passed; pinned translation runtime staged |
| `npm run prepare:tts-assets` | Passed; pinned TTS runtimes/frontends/source staged |
| `npm run build:extension` | Passed |
| `npm test` | 271 passed, no skips |
| `npm run test:browser -- --workers=2` | 220 passed, 18 optional checks skipped; Chromium and WebKit |
| `npm run test:extension` | 107 passed, 5 optional real-model checks skipped |
| `npm run test:extension -- tests/extension/translation.spec.js tests/extension/live-text.spec.js` | 25 passed after final per-branch status reporting change |
| `git diff --check` | Passed |

Unit tests cover sink replacement/append ordering, empty values, immutable
snapshots, repeated emissions, fan-out/independent sinks, formatter escaping,
missing values, grouped/independent streams, valid/invalid graphs, persisted
migration, branch direction and independent runtime statuses, lifecycle and shared-destination
retention.

Packaged MV3 checks exercise multiple custom-labeled regions with TEXT from ASR,
translation and the real formatter, literal HTML-looking labels/content, missing
formatter inputs, direct grouped updates, Stop/Cancel and fresh sessions, editor
saves during capture, default/migrated graphs, profile restart, per-region Copy,
focused-field output and both TTS paths. An output-only TTS graph renders zero
text regions, drains audio and reports field skips without inventing a display.
Existing checks also cover microphone permission, selected media, native toolbar
and tab capture, window focus, page navigation/permission loss, model preparation,
eviction and branch-local errors. The standard packaged suite initializes the
real bundled ReazonSpeech/Silero Workers under MV3 CSP.

## Limits and skips

ASR/translation/TTS inference is simulated in the graph/target fixture tests;
these establish graph/runtime/UI integration, not model quality. Focused-field,
media, tab-capture, microphone permission and native playback tests use Chrome
browser APIs; microphone device audio is Chromium's fake device.

The 18 browser skips are the opt-in real correction, ASR and ASR-thread benchmark,
OPUS-MT/TranslateGemma and TTS checks in both browser projects. The 5 packaged
skips are real Supertonic3/Kokoro inference, real ASR-to-focused-field speech,
and real ASR/OPUS-MT inference in both directions. Their environment flags were
not enabled; none is claimed as run. The optional translation smoke observer was
updated to observe formatter state without relying on removed fixed panels.
Live external meeting sites, direct YouTube editing, physical microphone hardware
and external DRM/restricted frames were not manually verified. No post-merge
verification, publication or deployment is required for this Issue.
