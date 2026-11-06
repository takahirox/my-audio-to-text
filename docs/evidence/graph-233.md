# Issue #233: quick-add starts without a selection

The Add Node list now opens with a null active type, every option marked
`aria-selected="false"`, and no search `aria-activedescendant`. Rendering or
changing categories clears selection. A nonempty search selects its first match;
clearing the query clears selection. Arrow Down/Up from no selection chooses the
first/last result, respectively. Enter requires an active result. Dismissal also
clears selection, and clicking or tapping an unselected option still adds it.

Validation on 2026-11-06:

- `npm test`: 793 passed.
- `npx playwright test tests/browser/graph-quick-add.spec.js --workers=1`:
  36 passed across Chromium and WebKit.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-quick-add.spec.js`:
  1 passed, loading production sources with the real MV3 manifest.
- `git diff --check`: passed.

Shared interaction checks cover 1440px and 390px layouts, empty-query Enter,
first/last navigation and wrapping, search selection and clearing (including
whitespace and no matches), category changes, hover, Escape/outside dismissal and
reopening, accessibility attributes, keyboard insertion, one-click insertion,
touch insertion, focus restoration, and explicit Save/reload. Existing placement
checks retain zoom, pan, transformed canvas, tall-card and responsive menu coverage.

Screenshots of initial open, with focus on search and no selected result:
[1440px](graph-233-1440.png), [390px](graph-233-390.png).

`npm run build:extension` could not package the extension because this worktree
lacks prepared local model assets (`Missing local models. Run npm run
prepare:assets first.`). The editor-only MV3 test does not require inference
assets. Runtime/model behavior and asset preparation are unchanged and real-model
checks were not run for this UI fix.
