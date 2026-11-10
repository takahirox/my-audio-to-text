# Graph Library without redundant navigation (#260)

The Library has one **Graph Library** page heading and a header **Models** link
using the existing `model-cache.html` route and page-opening behavior. **Graphs**
and **Launch Settings** remain side by side on desktop and stack in that order
at narrow widths. The sidebar, Local processing label, panel-focus navigation,
Live command and selection-dependent global Graph Editor link are removed.
This supersedes the navigation and selected-card treatment in [#255](graph-library-255.md).

Each graph card says **View details →**, has an accessible **Open details for
{name}** label and declares its dialog. Cards no longer present a persistent
pressed/selected state. The card menu and detail dialog retain graph-specific
editing, duplicate/export, preview, metadata, file checks, recovery and delete
guards. Internal detail identity and draft storage remain intact for conflict
handling and refresh recovery. Back/Escape restores the invoking row or menu.

Launch bindings, explicit Web ON/consent, eligibility checks, permission errors,
next-session snapshots and independent Live/Web execution retain their existing
implementation. No graph schema, runtime, model, shared navigation or other-page
implementation changed.

## Visual evidence

Inspected screenshots captured from production extension pages in Chromium:

- [1440 px header and paired panels](library-260-1440.png)
- [390 px focused details and Back action](library-260-390.png)
- [390 px stacked panels](library-260-list-390.png)
- [320 px stacked panels and long names](library-260-list-320.png)
- [390 px explicit website permission consent](library-260-consent-390.png)

Names are test fixtures; production still renders saved graphs. Browser checks
assert no sidebar or pseudo-navigation, a single page heading, header alignment,
use of the freed desktop width, stacked panel order, no horizontal overflow,
menu/dialog keyboard handling, focus return, 200% CSS zoom and forced colors.
A regression opens Graph A, changes both launch bindings to Graph B, edits A
from its detail link, returns to Library, then edits B from B's card menu while
A was the last opened graph. Both editor IDs and unchanged assignments/OFF
preference are verified. Models opens its actual destination.

## Validation (2026-11-10)

- `npm ci --ignore-scripts`: passed, zero reported vulnerabilities.
- `npm test`: **876 passed**, zero skipped or failed.
- Initial Library browser pass: **16 passed**. The broader final run below
  includes all **17 Library tests**, including the added graph-specific edit test.
- Broader browser command: **54 passed, 1 failed** (1.6 minutes). Passing checks
  cover Library import/export, filters, model checks, conflicts/draft recovery,
  launch bindings, permissions/denial, independent Live/Web sessions and cleanup.
- The failed `shared-ui.spec.js` test, **Live, Graph and Models share light
  controls with reachable narrow layouts and dense routes**, expects
  `Instance ID: previous` in the Graph Editor inspector at line 53 but gets
  `Select a node or connection.` A separate run against an unchanged archive of
  upstream commit `cc81cf1da972ae27fce138ddf7b086b7cb687edb` reproduced the same
  failure. This is also documented in the [#255 record](graph-library-255.md).
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
  tests/extension/shared-ui.spec.js --reporter=line
```

`npm run build:extension` was attempted and stopped at
`Missing local models. Run npm run prepare:assets first.` No model assets were
downloaded and no complete distribution build or real-model inference is
claimed. Inference in these browser checks uses controlled Workers. Physical
touch devices, screen readers and native browser zoom were not tested. Host
grants/denial use existing controlled fixtures; native host-permission bubble
clicks were not automated.
