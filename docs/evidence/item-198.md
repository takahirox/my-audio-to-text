# Portable display verification (#198, #200)

The current graph uses KeyedTextPair.pair → KeyedPairedTextAccumulator.pair →
pairs → Display.input. KeyedTextPair exposes only its complete immutable pair;
its four independent NUMBER/TEXT inputs keep their ID-scoped association rules.
The accumulator appends new IDs and replaces existing IDs in first-seen order.
Display safely renders each supplied TEXT, pair or complete pair-list snapshot.

The [importable graph](item-198.json),
[executable fixture](../../tests/fixtures/item-graph.js), editor Help and
[contract documentation](../display-items.md) use this path. Removed display
Nodes, ports, DOM/VIEW contracts and migrations have no runtime or package path.
Unsupported saved graphs fail visibly; Reset or validated JSON Import and Save
provide explicit recovery. Reading preserves stored JSON, and invalid imports
preserve the draft. No legacy graph is silently rewritten.

Validation on 2026-11-03:

| Check | Result |
| --- | --- |
| `npm test` | 738 passed |
| Chromium/WebKit display, coalesce, sliding-window, translation-port, scrolling and editor-layout suites | 104 passed |
| Expanded controlled Chromium MV3 suites | 88 passed; one obsolete Whisper text assertion corrected and its case rerun successfully |
| `git diff --check`, changed Markdown fences/local links, package file existence | Passed |
| `npm run build:extension` | Blocked by missing prepared local model assets; requests `npm run prepare:assets` |

Unit coverage includes exact metadata/runtime ports, independent ID-first and
text-first delivery, immutable snapshot ownership, explicit ITEM compatibility,
producer-independent wiring, empty/repeated values, arrival-order replacements,
lifecycle, stale contexts and unsupported saved graphs. Generic TEXT processors
and translator ID snapshots retain dedicated tests.

Browser and MV3 checks cover provisional-to-final replacement without a blank
gap, interleaved utterances, late/reverse translation, stable row order, literal
HTML-like strings, accessible columns, Copy text, independent scroll position,
Stop/Cancel, restart, worker cleanup, editor connections, strict JSON Import and
Reset recovery. Summary TEXT reaches Display directly. Expanded MV3 coverage also
checks concurrent ASRs, Whisper, translation cache failures/offline reuse, TTS
fan-out and windowed TEXT processing through current displays.

MV3 validation uses an ignored fixture package copied from the production
builder's SHARED_FILES, extension sources, manifest and licenses. Owned temporary
test directories supply controlled model Workers/manifests. This verifies module
packaging, runtime composition and MV3 integration. It does not verify the full
model-bearing distribution, real inference quality, physical capture/playback or
a native renderer. No model assets were downloaded for this change.
