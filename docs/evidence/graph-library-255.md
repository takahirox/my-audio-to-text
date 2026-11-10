# Sidebar and paired Graph Library / Launch Settings panels (#255)

Historical validation record: #260 supersedes the sidebar, in-page navigation
and selected-card treatment described below. See the [current layout and
validation](graph-library-260.md). The images here preserve the #255 appearance;
current tests capture `library-260-*` evidence instead.

The desktop Library now has a persistent 200 px navigation sidebar and two
balanced panels: **Graph Library** and **Launch Settings**. Graphs and Launch
Settings focus their respective panels; Models uses the existing page-opening
infrastructure, and Live and Graph Editor remain accessible. There is no invented
Settings destination.

Graph cards show a name, up to two lines of description, selected styling and an
always-discoverable keyboard-operable ⋯ disclosure. Its commands open graph
details, edit, duplicate or export. Search remains visible; Filters & more
contains sort, filter and import. Recovery stays available through the existing
recovery panel, Needs recovery filter and detail view.

Selecting a graph opens a native modal dialog, keeping the library and launch
panels free of a permanent third column. It retains preview, graph editing,
name/description Save, duplication, export, model-file checks, saved metadata,
delete guards and recovery errors. Back or Escape closes it and restores focus
to the invoking graph row/menu (or the New Graph button). Closing preserves an
unsaved draft; selecting another graph still warns before discarding it. Reload
restores the draft and its original revision. Errors are also exposed inside the
dialog so conflicts and failed writes remain accessible while the background is
inert. Escape first closes an expanded More menu, then the dialog.

Launch Settings contains separate **Live Window** and **Web Page Microphone**
cards. Assignment remains independent of library selection and the ON/OFF
preference. Selectors retain validation and revision checks; full selected names
are available in native options and the selector title. Consent, permission
requests, native microphone capture, injection and session snapshots are
unchanged. No graph schema, migration, runtime or persistence code changed.

## Visual and accessibility evidence

Inspected screenshots from the production extension pages in headless Chromium:

- [1440 px sidebar and paired panels](library-255-1440.png)
- [390 px focused graph details](library-255-390.png)
- [390 px stacked panels and long choices](library-255-list-390.png)
- [320 px compact navigation and long choices](library-255-list-320.png)
- [390 px just-in-time website permission consent](library-255-consent-390.png)

Names in these images are browser-test fixtures, not production seed records.
Narrow layouts wrap navigation and stack both panels. Browser checks cover
keyboard row navigation, accessible labels, in-page navigation focus, actual
Models/Graph Editor destinations, row-menu export/duplicate/edit, modal focus
containment and return, dirty close/reopen, draft restoration, Escape handling,
long lists/names, menu bounds, 200% CSS zoom and forced colors. Screenshots and
assertions establish no horizontal document overflow at 390/320 px. Physical
devices and VoiceOver were not tested; CSS zoom is not a claim of testing the
browser's native zoom controls. The existing app uses a light color scheme.

## Validation (2026-11-10)

- `npm ci --ignore-scripts`: passed, no audit vulnerabilities.
- `node --test tests/graph-library.test.js tests/web-voice*.test.js`: **24 passed**.
- The browser command below: **51 passed** (about 1.5 minutes). It exercises
  Library management, import/export, migration/recovery, revisions, quota errors,
  multi-tab drafts, model cache inspection, Live snapshot/preload behavior,
  independent Web permission consent and OFF cleanup, microphone lifecycle and
  output insertion. Fixture inference avoids large model downloads.
- The final added restored-draft focus assertion was checked separately with
  `--grep 'metadata drafts survive'`: **1 passed**.
- `node --check` for the Library page and changed browser tests, and
  `git diff --check`: passed.

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-library.spec.js \
  tests/extension/web-voice.spec.js \
  tests/extension/graph-actions.spec.js \
  tests/extension/graph-concurrent.spec.js \
  tests/extension/graph-models.spec.js \
  tests/extension/live-ui.spec.js \
  tests/extension/shared-ui.spec.js \
  --grep-invert 'Live, Graph and Models' --reporter=line
```

## Validation limits

`npm run build:extension` was attempted and remains blocked by missing prepared
local model assets: `Missing local models. Run npm run prepare:assets first.`
No model assets were downloaded, production package built, or real-model/GPU
inference tested. The excluded shared-UI **Live, Graph and Models** test has the
unrelated Graph Editor inspector failure previously reproduced on untouched
upstream in [the #250 validation record](graph-library-250.md). It was not rerun.
No shared stylesheet, Graph Editor or Live implementation changed.

Chrome's native host-permission bubble is not automated. Existing browser
fixtures cover native installation grants and controlled permission denial with
exact origins and an active user gesture. Permission is requested only after
explicit ON and Continue.
