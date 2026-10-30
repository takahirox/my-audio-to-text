# Explicit DOM history (#140)

Historical record: Issue #169 supersedes the provisional-delivery rejection below;
PairedTextToDOM now formats provisional and committed atomic groups identically.

PairedTextToDOM now emits one completed pair per correlated grouped delivery and
retains no translation history. Direct v11 formatter → display routes show only
the latest pair; their saved wiring is unchanged. LiveTextDisplay and the Live
renderer remain replacement-only sinks.

The optional DOMAccumulator processor has only append: DOM and dom: DOM. It
validates/clones incoming snapshots, owns its retained tree, and emits independent
complete snapshots. Start clears it, Stop drains and retains history, and Cancel
rejects stale work. Each paired snapshot uses a headerless two-cell table with
accessible cell labels, aligned heights, literal text, and per-pair hover/focus
highlighting. The accumulator contains no translation or table-specific logic.

Validation:

- `npm test`: 569 passed. Coverage includes both graph paths, alternate grouped
  producers and edge orders, mismatched/independent input groups, actual scheduler
  provisional success/empty/failure rejection, duplicates, empty results, errors,
  Stop drain, Cancel, stale replies, fresh Start, saved v11 wiring, type validation,
  generic DOM safety, and independent input/retained/output/fan-out ownership.
- With a dedicated local HTTP server serving `web/` on port 8140:
  `ASR_BASE_URL=http://127.0.0.1:8140 npx playwright test tests/browser/dom-display.spec.js tests/browser/text-display.spec.js tests/browser/text-contracts.spec.js --workers=2`:
  12 passed across Chromium and WebKit. After the final accessible-cell-label
  adjustment, all 6 DOM browser cases passed again. Tests check actual geometry,
  computed hover/focus styles, literal content and replacement versus history.
- Packaged MV3 source fixtures: 50 distinct cases passed across
  `tests/extension/live-text.spec.js` (15), `tests/extension/graph.spec.js` (12),
  `tests/extension/translation.spec.js` (22), and the `completed translations flow`
  case in `tests/extension/targets.spec.js` (1). Commands use
  `npx playwright test --config playwright.extension.config.js` with those files
  (and `--grep 'completed translations flow'` for targets). Both graph variants
  exercise alignment, highlighting, duplicate/error/empty results, retention,
  stale cancellation and restart through the production session/runtime/renderer.
  Graph Editor adds, wires, saves and reloads DOMAccumulator and rejects TEXT →
  DOM. Older tests expecting implicit history or an initial empty table were
  corrected; the full translation suite was rerun. The two graph cases and editor
  case also passed again after the final cell-label adjustment.
- `git diff --check` passed.

Environment limitations:

`npm run build:extension` stops with “Missing local models. Run npm run
prepare:assets first.” This worktree has no prepared model/runtime assets.
Real-model/hardware smoke tests and a distributable production asset build were
not performed; no model-inference result is claimed. Inference code is unchanged.

As documented in the #138 validation record, deterministic MV3 testing used an
ignored source-only package under `dist/chrome-extension`: copy `extension/`, its
manifest to the package root, and exactly `SHARED_FILES` from
`scripts/build-extension.py` into `web/`. `FIXTURE-ONLY.txt` identifies the package.
Existing fixtures supply controlled Workers/backends and tiny integrity-checked
assets. These results verify packaged application behavior, not production model
asset readiness. No post-merge verification is required by #140.
