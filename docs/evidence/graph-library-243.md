# Graph Library (#243) validation

Implemented independent named library entries, ID/revision-based editor context,
Live/Web voice target assignments, recoverable migration, and the compact Library
layout. Web page voice typing remains explicitly unavailable. No second execution
session or in-page microphone was added.

The executable graph stays at version 15. The library envelope and assignments
are separate. Migration preserves the legacy key, original source object and
invalid source bytes. One atomic localStorage envelope plus the existing Web Lock
serializes changes; per-entry revisions preserve independent edits and reject
conflicting drafts. Older-page legacy changes require explicit recovery as a new
entry. Invalid graph data cannot overwrite valid entries or its corrupt original.

Live resolves the saved assignment by ID, prepares only executable instances,
and owns a separate preparation identity even for identical graphs with different
IDs. Reassignment cancels idle/preparing owners. Active graph/ID/name remain
unchanged through assignment changes or deletion of their now-unassigned library
entry; Stop/Cancel prepares the next assigned graph. An unavailable next
assignment blocks stale preparation and Start.

Screenshots inspected: [1440 px](library-243-1440.png),
[390 px](library-243-390.png). The compact rows stay within the viewport; target
assignments precede selected graph details on narrow windows. The schematic uses
real saved node positions, types and edges, without editor routing/inference.

## Checks actually run (2026-11-07)

- `npm ci --ignore-scripts`: successful.
- `npm test`: **858 passed**. New storage coverage includes concurrent/idempotent
  and lossless migration, malformed/unsupported legacy sources, interrupted/quota
  writes, migration revision conflicts, CRUD/import/export, duplicate IDs, edit
  isolation, assignment validation, last-usable/assigned deletion guards,
  legacy-change recovery, unsupported locks and explicit compatibility APIs.
  Session checks include ID-separated preparation, active ID/name immutability,
  Stop/Cancel transitions and unavailable next assignments.
- MV3 regression command below: **71 passed**. Uses production extension pages,
  storage, editor, session/runtime and file-cache code with controlled inference
  replies. Checks Library search/sort/filter, keyboard selection, responsive rows,
  portable downloads, malformed imports, target persistence, delete confirmation,
  cross-tab editor/metadata conflicts, dirty navigation, concurrent migration,
  quota errors, original-storage export, preload cancellation, parked models,
  active-session preservation, graph actions, file preparation/deduplication,
  import recovery, displays, numeric configuration and pointer/zoom behavior.
- Focused rerun after the final recovery guards:
  `npx playwright test --config playwright.extension.config.js tests/extension/graph-library.spec.js tests/extension/live-model-preparation.spec.js`:
  **7 passed**, including retained metadata/export after deletion in another tab.
- `npx playwright test tests/browser/graph-canvas-first.spec.js tests/browser/graph-zoom.spec.js --project=chromium`:
  **22 passed**, using browser-served source, keyboard/touch controls and fractional
  zoom. WebKit was not run.
- JavaScript syntax checks and `git diff --check`: passed.
- `npm run build:extension`: **blocked**, reports
  `Missing local models. Run npm run prepare:assets first.` This checkout has no
  prepared `web/vendor` model bundle. Production packaging and opt-in real model /
  GPU inference were not validated. Deterministic MV3 fixtures package source
  directly; real inference fixtures still require the prepared production build.

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-library.spec.js \
  tests/extension/live-model-preparation.spec.js \
  tests/extension/graph-models.spec.js \
  tests/extension/graph-actions.spec.js \
  tests/extension/graph-number.spec.js \
  tests/extension/graph-interactions.spec.js \
  tests/extension/live-text.spec.js \
  tests/extension/graph.spec.js \
  tests/extension/item.spec.js \
  tests/extension/graph-text-summary.spec.js \
  tests/extension/display-tabs.spec.js \
  tests/extension/graph-canvas-first.spec.js
```

The library initializes model-bearing rows to Unknown. Explicit file inspection
reports Needs preparation / Error / verified cached files without starting
Workers or downloading weights. Cache notifications/focus invalidate observations.
Packaged-model readiness remains Unknown until Live verifies it. A regression
saves two distinct graph IDs with the same optional model and observes only one
set of model-file requests; the second Save leaves the first entry unchanged.
