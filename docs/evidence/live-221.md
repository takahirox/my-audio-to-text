# Live content-only Display panes (#221)

Validated locally on November 5, 2026, on macOS with Playwright 1.63.0.

Live input panes now contain only their focusable content surface. The repeated
heading, header row, Copy text button, clipboard handler and copy-status region
are removed. Input tab labels, panel accessible names and tab associations remain.
Desktop and narrow layouts use a small content inset without header spacing.
Graph schema, input identity, runtime processing and Graph Actions are unchanged.

## Passed checks

- `npm test`: **785 passed**, including the packaging test with verified fixture
  assets and Display DOM/unit regressions.
- `npm run test:browser -- tests/browser/display-tabs.spec.js tests/browser/live-scroll.spec.js tests/browser/extension-layout.spec.js --workers=2`:
  **74 passed** across Chromium and WebKit.
- `npm run test:extension -- tests/extension/display-tabs.spec.js tests/extension/live-text.spec.js tests/extension/simple-layout.spec.js tests/extension/extension.spec.js tests/extension/item.spec.js tests/extension/graph-actions.spec.js`:
  **35 passed, 3 failed**, with the limitations below. All Display-tab, Live-text,
  Simple-layout, ITEM and Graph Actions cases passed.
- `git diff --check`: passed.

The shared browser/MV3 fixture checks absent headings, controls and status rows;
three independently updating input tabs; configured labels and ARIA association;
keyboard switching and focus; preserved selection and unchanged DOM during hidden
updates; independent scroll offsets and bottom-follow intent; safe TEXT/ITEM
rendering; empty snapshots; Stop/Cancel/Restart; runtime relabeling; and a named,
focusable single-input surface without a tab strip. Layout checks cover 1440,
390 and 280 CSS pixel widths. The packaged example also checks touch switching.

## Validation limits

The worktree had no prepared model/runtime assets. For controlled-worker MV3
checks, production extension files, manifest, shared modules and licenses were
staged in the same directory layout as the builder. Existing test fixtures then
supplied their controlled workers. This is source-level MV3 integration evidence,
not a completed production asset build or real inference validation.

Two existing `extension.spec.js` tests failed waiting for their delayed transcript
hook: “Stop waits for the final transcript port before completion and disposal”
and “teardown while the transcript sink drains discards held output and workers”.
Both failures were reproduced in an isolated staged package with the upstream
`live-text-regions.js` and `recorder.css` restored from commit `785c89c`.
Their hooks target `TranscriptOutputNode`/`TextAccumulatorNode`, while the current
default graph uses the keyed Display path; neither hook receives the held output.
The new shared fixture's Stop/Cancel/Restart checks passed.

The third failure, “packaged extension initializes the real pinned
ReazonSpeech/Silero workers under MV3 CSP”, could not load the absent
`web/vendor/sherpa-ja-en/sherpa-onnx-vad.js`.
`npm run build:extension` also stopped at its required local-model check
(“Missing local models”). Full asset packaging and real-model initialization
remain unverified; no model/runtime or unrelated test-hook changes are included.
