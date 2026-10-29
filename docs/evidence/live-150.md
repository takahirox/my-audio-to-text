# Original-column provisional tail (#150)

Verified the reported issue in Chromium **before changing presentation**, using
the production formatters, combiner and shared Live renderer/CSS. At 1440 px the
preview was 810.66 px wide below 405.33 px paired columns; at 390 px it was 328 px
below 164 px columns. The preview visibly crossed into the translation side.

- Before: [1440 px](live-150-before-1440.png), [390 px](live-150-before-390.png).
- After, browser: [1440 px](live-150-after-1440.png), [390 px](live-150-after-390.png).
- After, packaged MV3 graph: [1440 px](live-150-extension-1440.png),
  [390 px](live-150-extension-390.png).
- [Measured geometry](live-150-geometry.json) includes Chromium, WebKit and MV3.

The composition now explicitly selects `className: paired-text-tail` on its
TextToDOM. The Live stylesheet gives this class half the available width, the
same .6em inset as the Original cell, and italic text. Empty tails occupy no
space. The translation side remains empty until a completed pair arrives. There
are no new Live labels, status panels, modes or output Nodes.

`className` is an optional generic formatting setting: TextToDOM still emits
literal replacement snapshots and has no ASR, translation or history knowledge.
An omitted/empty class keeps the existing plain display behavior. Existing v11
graphs remain valid without migration, rewiring or a storage rewrite. The editor
supports editing and saving the setting. PairedTextToDOM, DOMAccumulator,
DOMCombiner, LiveTextDisplay and the shared renderer are unchanged.

## Validation (2026-10-29)

- `npm test`: **608 passed**. Includes generic formatter/combiner ownership,
  fan-out, safe literal text and class attributes, existing v11 settings,
  independent producers and streams, both edge orders, duplicate pairs,
  ASR-final clearing, delayed translation, errors, Stop/Cancel and new sessions.
- With this worktree served by
  `python3 -m http.server 8150 --directory web --bind 127.0.0.1`:
  `ASR_BASE_URL=http://127.0.0.1:8150 UPDATE_LIVE_SCREENSHOT=1 npx playwright test tests/browser/live-scroll.spec.js tests/browser/dom-display.spec.js tests/browser/text-display.spec.js tests/browser/text-contracts.spec.js tests/browser/text-window.spec.js --workers=2`:
  **24 passed** across Chromium and WebKit. Port 8000 was occupied; its server was
  left untouched.
- `UPDATE_LIVE_SCREENSHOT=1 npx playwright test --config playwright.extension.config.js tests/extension/live-text.spec.js`:
  **20 existing cases passed**. The added settings/layout case initially timed
  out because all seeded graph nodes overlapped, blocking pointer selection.
  Spacing the test fixture's nodes fixed selection. The final targeted invocation,
  `UPDATE_LIVE_SCREENSHOT=1 npx playwright test --config playwright.extension.config.js tests/extension/live-text.spec.js --grep 'persists explicit tail styling'`,
  **passed**. It saves/reloads the class through the editor and runs the complete
  Zipformer → translation → pair history + provisional → combiner → Live graph.
- Wide/narrow assertions check equal-height paired cells, left-column width and
  inset, an empty translation side, no horizontal overflow, exact whitespace and
  literal HTML, existing accessible names, pair hover/focus highlighting,
  keyboard Tab navigation, copy text and stable focus on the Live content
  container during replacement. The cleared tail has zero rendered height.
- Shared browser/MV3 scrolling tests now use the styled tail with actual
  overflowing paired history. They cover independent reading offsets, following
  within 24 px of the bottom, shrinking/empty/growing previews, wrapping and font
  changes, manual return to bottom and fresh content.
- The MV3 lifecycle case verifies immediate clearing at ASR final, preservation
  of newer speech after delayed success/error, duplicate-final suppression,
  repeated committed pairs, Stop draining, Cancel rejecting late results, and
  fresh sessions. The ASR/translation implementation is unchanged.
- `git diff --check`: passed.

## Asset-dependent checks

`npm run build:extension` is **blocked** with “Missing local models. Run npm run
prepare:assets first.” No production model/runtime bundle, real inference or
hardware smoke test is claimed, and no model assets were downloaded.

Packaged UI checks used an ignored, marked **source-only test fixture** at
`dist/chrome-extension`: `extension/`, its manifest at the package root, and the
57 `SHARED_FILES` from `scripts/build-extension.py` copied into `web/`.
`FIXTURE-ONLY.txt` marks it as non-deployable. The existing test harness provides
controlled Workers and tiny integrity-checked assets. These results establish
packaged UI/runtime composition behavior, not production asset readiness.

No post-merge verification is required by #150.
