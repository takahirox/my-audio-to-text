# DOM composition and Live scrolling (#142)

DOMCombiner retains the latest independent first/second inert DOM snapshots and
emits their deep-cloned concatenation in fixed order. Empty inputs clear only
that side. Start resets both inputs; Stop drains and retains the latest output;
Cancel rejects stale deliveries. The typed catalog, Graph Editor palette, saved
graphs and runtime support it without a schema bump or migration.

ASRs exposing provisional/final now emit empty provisional and final TEXT in one
atomic finalization. This keeps TextAccumulator and direct translator scheduling
consistent, preserves causal identity for TranslationCommit, suppresses duplicate
worker finals before clearing, and never lets delayed translations clear newer
speech. Final-only ASRs keep their original contracts. The graph recipe in
`docs/extension-graph.md` composes completed bilingual history above literal ASR
preview in one Live region. Final English awaiting translation intentionally has
no pending row. No default wiring changes or preview/history modes were added.

The shared Live renderer measures each region before replacement, follows within
24 px of its bottom, restores older-content reading offsets, and resumes following
when the user returns to the bottom. ResizeObserver handles viewport and snapshot
layout changes; scroll-event handling distinguishes layout clamping from changed
reading position. Existing overflow-anchor:none CSS prevents browser anchoring
from fighting explicit restoration. No focus or smooth-scroll calls were added.

Validation (2026-10-29):

- `npm test`: **579 passed**. New coverage includes input arrival order, initial
  empty inputs, replacement, repeated and empty updates, retained/output/consumer
  ownership, inert CSS validation, fan-out, lifecycle, typed wiring and saved
  graphs. Real graph runtime/scheduler tests cover delayed translation, repeated
  finals, newer previews, failure, actual in-flight Cancel, stale callbacks and
  fresh sessions in both edge orders. ASR tests cover atomic clearing in Reazon,
  Zipformer and Moonshine and unchanged final-only Whisper/Parakeet outputs.
- A dedicated source server used
  `python3 -m http.server 8142 --directory web --bind 127.0.0.1` because port 8000
  was occupied. With `ASR_BASE_URL=http://127.0.0.1:8142`, running
  `npx playwright test tests/browser/live-scroll.spec.js tests/browser/dom-display.spec.js tests/browser/text-display.spec.js tests/browser/text-contracts.spec.js tests/browser/text-window.spec.js --workers=2`
  produced **16 passed**, across Chromium and WebKit. Scroll tests use actual
  overflowing paired history plus a provisional tail and verify near-bottom
  following, scrolled-up offsets, shrinking/empty/growing previews, wrapping
  changes, independent displays, manual return to bottom, focus and fresh content.
- Packaged MV3 tests, using `npx playwright test --config playwright.extension.config.js`:
  - `tests/extension/live-text.spec.js`: **17 passed**, including the complete
    Zipformer/translation/history/preview runtime, Graph Editor add/wire/save/reload
    and incompatible TEXT wiring, and the same actual-overflow scrolling checks.
  - `tests/extension/graph.spec.js tests/extension/translation.spec.js tests/extension/windowed-translation.spec.js tests/extension/graph-zipformer.spec.js`:
    **42 passed**. Includes saved graphs/migration, plain transcript, standalone
    pairs and explicit history, other translation paths, production Zipformer
    Worker with fixture recognizer, and focused-field/TTS routing fixtures.
  - `tests/extension/targets.spec.js --grep 'completed translations flow'`:
    **1 passed**, checking translated TEXT fan-out to a focused field and Live.
- `git diff --check`: passed.

Environment limitations:

`npm run build:extension` stops with “Missing local models. Run npm run
prepare:assets first.” Prepared production model/runtime assets are absent.
No production asset build, real-model inference, or hardware smoke result is
claimed. No models were downloaded for this change.

Packaged tests used an ignored **source-only fixture** at `dist/chrome-extension`,
created by copying `extension/`, its manifest to the package root, and exactly
SHARED_FILES from `scripts/build-extension.py` into `web/`, as in #140. A
FIXTURE-ONLY.txt marker identifies it. Existing fixtures supply controlled Workers,
recognizers/backends and integrity-checked tiny asset data. These tests establish
packaged application behavior, not production model asset readiness.

No post-merge verification is required by #142.
