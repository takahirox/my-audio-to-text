# Issue #162 — append-only text accumulation

TextAccumulator now exposes only append: TEXT → text: TEXT. It retains the exact
newline-separated history, including duplicate and empty events. Start emits an
empty snapshot; Stop/Cancel retain committed text without publishing another
snapshot. There is no provisional state or legacy display option in its runtime.

The default and legacy-preference layouts retain the original transcript and its
replaceable provisional tail through two TextToDOM branches and DOMCombiner.
The optional translation display still shows its separate latest completed pair.
TranslationCommit/windowed-translation fixtures and recipes use the same explicit
composition. No new node, port type or UI control was introduced. DOMCombiner's
inputs are independently optional for execution, matching its existing latest
snapshot behavior and allowing preview-only or final-only branches.

ASR finalization still emits a grouped empty provisional and final. Identified
partials for finalized utterances are now rejected alongside duplicate finals;
identical text with distinct final IDs still appends separately. ASR and
TranslationCommit clear their provisional output on Stop/Cancel. Pipeline Cancel
aborts ordinary work immediately, then drains cleanup in topological order before
closing each processor, so a clear can cross TextToDOM and DOMCombiner to all sinks.
The generic formatter, combiner and display contain no producer-specific logic.

## Saved graph behavior

Graph v13 requires reviewed Save for old accumulator preview routes. Supported
TextToDOM fan-out becomes explicit provisional DOM snapshots plus committed DOM
in a fixed-order combiner. Existing IDs, settings, positions, unrelated routes,
multiple displays and existing explicit compositions are preserved. Added IDs
are collision-safe. Legacy display metadata is removed during conversion.

Independent and preview-only sources are never correlated with an unrelated
append. Their reviewed draft keeps the latest snapshot until its producer clears
it; the warning explains the difference from the old append/Stop/Cancel cleanup.
Old accumulated TEXT fan-out and shared formatter inputs remain blocked with a
manual-repair explanation because an automatic DOM conversion cannot preserve
those TEXT values. The exact saved JSON and every original route remain in
Recovery. These graphs need a deliberate repair before execution.

Save first backs up the exact original to processing-graph-before-v13, allocating
numbered copies on collision and reusing identical originals. Existing recovery
copies, including before-v9 and before-v12, are preserved. Backup write failure
leaves the original saved graph untouched. Append-only v12 descriptions upgrade
without changing nodes or edges. Unit and MV3 tests verify blocked execution,
review, original JSON, Save/reload, profile persistence and ordinary later saves.

## Validation

- `npm test`: **630 passed**.
- Chromium and WebKit: `text-display.spec.js`, `text-window.spec.js`,
  `dom-display.spec.js`, `live-scroll.spec.js`: **14 cases per engine**, including
  new production-producer/explicit-composition Stop/Cancel tests. Chromium's two
  new cases were run in a subsequent four-case text-display run.
- `extension-layout.spec.js`: **58 passed** across Chromium and WebKit. Includes
  touch/keyboard/pointer connection editing, narrow/wide layouts, recovery copies,
  and literal DOM snapshot rendering/copy. Its old string-snapshot fixture now
  supplies actual DOM, and the touch assertion permits subpixel clipping.
- MV3 `live-text.spec.js`: **28 passed** in the final full run. Includes default
  history/provisional output, delayed translation, repeated/empty values,
  provisional clearing, two display outputs, both translation directions,
  narrow/wide layout, bottom-aware scrolling, old migrations and all three new
  v12 accumulator migration cases.
- MV3 `primitive-composition.spec.js` and `windowed-translation.spec.js`:
  **13 passed**. Four translators, explicit translation previews, immutable
  commits, generic TEXT fan-out, startup configuration and cancellation.
- MV3 `graph-interactions.spec.js`, `graph-whisper.spec.js`,
  `graph-zipformer.spec.js`, `graph.spec.js`: **54 cases passed across the initial
  run and corrected targeted reruns**. The initial run passed 45; five disconnect
  cases needed the new disconnected TextToDOM warning expectation, and four
  cases needed updated default counts/composition or an explicitly disconnected
  provisional ASR branch for a text-only fixture. All nine reruns passed.
- MV3 `graph-models.spec.js`: **10 passed**. Save/preparation isolation, parked
  nodes, unchanged current drafts, failure/retry and storage handling.
- `git diff --check`: passed.
- [Default graph screenshot](graph-162-default.png) was captured and inspected:
  seven standard Nodes, separate history/tail branches, no overlapping cards.

Browser checks used a worktree-local static server on port 8016 because port 8000
was already occupied. The repository-pinned Playwright Chromium 153 / WebKit 26.6
revisions were installed before the successful runs.

`npm run build:extension` stops at the expected missing-local-model check:
“Missing local models. Run npm run prepare:assets first.” MV3 checks used an
ignored source-only fixture package under dist/chrome-extension, marked
FIXTURE-ONLY.txt: extension/, its manifest, and exactly the builder's SHARED_FILES.
The existing test fixtures supply controlled Workers/assets. No real ASR,
translation or TTS inference, model readiness, or complete production package is
claimed. Opt-in real-model fixtures were rewired but could not be run without
those assets. No post-merge verification is required by #162.
