# Graph Library master/detail redesign (#250)

The Library now keeps graph selection on the left and one detail panel on the
right. Rows use flat button semantics, a visible selection pointer, keyboard
focus and compact Live/Web assignment markers. Search, sorting, assigned/recovery
filters and the empty state remain available. A long list scrolls independently
of the detail panel. At 760 px and below, selection opens the detail view and
**Back to graphs** returns focus to the selected row (or search if filtered out).

The detail panel groups a readable, scrollable graph preview, primary **Edit
graph**, Duplicate, editable name/description and **Use this graph for**. More
contains Export JSON, Check model files, Delete and Load saved details. Delete
retains its assignment/last-usable guards and confirmation. File-cache checks
open the model information disclosure without inference or weight downloads.
Incompatible Web assignment actions reveal the existing `webVoiceError` reason
and move keyboard focus to it. Selection never assigns a graph.

The separate global Web voice switch shows the assigned graph. Assignment does
not enable injection; OFF retains the assignment. ON opens an accessible consent
dialog with website scope, rationale, local processing, click-only microphone
capture and disable/revoke guidance. Only its Continue button calls Chrome's
permission request, synchronously within the user gesture. Cancel/Escape and
denial stay OFF. Help retains exact HTTP/HTTPS patterns, unsupported fields/pages
and permission-revocation instructions. Missing permissions and incompatible
assignments report targeted recovery.

Unsaved details remain intact through filtering, canceled selection, assignment,
cache updates and cross-tab changes. Per-tab sessionStorage retains the original
entry/revision and draft across refresh, including recovery/export after another
tab deletes the entry. Restored stale drafts still fail revision checks. Explicit
selection/discard, successful Save or Load saved details clears the draft. A
sessionStorage failure reports unavailable refresh recovery; navigation retains
the dirty warning. GraphLibrary's stored envelope, stable IDs, graph JSON,
locking/revisions, migrations and execution/session behavior are unchanged.

## Visual evidence

Inspected production extension pages in Chromium:

- [1440 px master/detail](library-250-1440.png)
- [390 px details](library-250-390.png)
- [390 px list](library-250-list-390.png)
- [320 px list / small viewport zoom equivalent](library-250-list-320.png)
- [390 px permission disclosure](library-250-consent-390.png)

The browser tests assert wide-pane geometry, independently scrolling long lists,
row borders/selection, keyboard selection and focus, menu bounds, narrow Back
navigation, wrapping names, preview contents and no document overflow.

## Validation (2026-11-09)

- `npm ci --ignore-scripts`: passed, 0 audit vulnerabilities.
- `npm test`: **863 passed**.
- Source-based MV3 browser regression command below: **44 passed**. Production
  extension pages/storage/runtime are exercised with controlled model replies.
  Coverage includes CRUD/import/export, recovery and corrupt storage, metadata
  conflicts across refresh and tabs, deleted-entry draft recovery, assignment
  eligibility/unassignment, running snapshots and preload cancellation, model
  cache inspection, global switch synchronization, consent cancellation,
  permission-denial recovery and the permission request's active user gesture.
  Web voice tests retain microphone lifecycle, sensitive-field, exactly-once
  output, session snapshot, permission removal and reload/navigation coverage.
- `node --check extension/graph-library-page.js` and `git diff --check`: passed.

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-library.spec.js \
  tests/extension/web-voice.spec.js \
  tests/extension/graph-actions.spec.js \
  tests/extension/graph-concurrent.spec.js \
  tests/extension/graph-models.spec.js \
  tests/extension/live-ui.spec.js \
  tests/extension/shared-ui.spec.js \
  --grep-invert 'Live, Graph and Models'
```

## Existing validation limits

`npm run build:extension` is blocked by missing prepared local model assets
(`Missing local models. Run npm run prepare:assets first.`). The separate
`targets.spec.js` suite requires `dist/chrome-extension`; all 23 cases fail fixture
setup because that production bundle is absent. No production package or real
model/GPU inference was validated or model assets downloaded for this UI change.

The excluded shared-UI test, **Live, Graph and Models share light controls with
reachable narrow layouts and dense routes**, fails because Enter on **Select
previous** leaves the Graph Editor inspector empty. The same exact assertion
fails on an isolated, untouched archive of upstream commit `0f8739b`. The other
shared-UI cache test passes. The Library redesign changes no Graph Editor files
or shared styles.

Native Chrome permission-bubble buttons are not automated. The Web voice grant
fixture seeds Chrome-native host grants before restoring the optional-only
manifest; denial controls only the permission API result. Tests verify no request
before Continue and the exact requested origins with an active user gesture.
