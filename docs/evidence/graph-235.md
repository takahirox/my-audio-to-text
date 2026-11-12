# Issue #235: canvas-first Graph Editor

The primary toolbar now stays on one 44px row, with Saved / Unsaved, Add Node,
Save and the Graph actions overflow (…). The global Help button was later removed
in #300. Saving is announced through
the status indicator without widening the Save button. Active-session details,
earlier-active-graph warnings, conflicting saves, validation and preparation
errors remain available. The existing native disclosure retains its commands,
confirmations, keyboard access and rejected-JSON recovery.

Canvas navigation floats outside the scrolling/transformed graph: −, the native
zoom chooser, +, and Fit. All six presets and custom Fit scales remain available;
choosing 100% restores the editing target's focus. Fit, insertion bounds and scroll
extents reserve 72 screen pixels below content so ports remain reachable above
the controls. Quick-add still follows its toolbar anchor and preserves zoom/pan.

The Inspector places Remove Node beside Settings, shows the type and Instance ID,
and keeps actual settings and collapsed Node help and ports. It has no Clear
selection button or empty-settings message. Pointer, touch, Enter and Space
toggle heading selection; Escape and blank canvas clear it. Dragging selects and
moves the node without toggling it off, and pointer focus commits pending field
edits before selection changes. Connection selection retains only its details
and Disconnect action.

## Layout measurements

Measured in Chromium at 900px viewport height, with the default graph and no
warning notices. Exact before/after geometry is in
[graph-235-layout.json](graph-235-layout.json).

| Width | Toolbar before → after | Canvas top before → after | Canvas height before → after |
| --- | --- | --- | --- |
| 1440px | 44 → 44px | 177 → 125.5px | 690 → 744px |
| 390px | 95.5 → 44px | 224.75 → 121.75px | 558 → 558px |

The desktop canvas gains 54px in height. On narrow screens, the same-height canvas
starts 103px earlier, bringing the Inspector closer as well. All toolbar actions
also fit on one row at 320px. Tests verify that floating controls do not move when
the graph scrolls or zooms, and that the final ports can scroll above them.

Screenshots use a small Text → Hold → Display graph and show the no-settings Hold
Inspector: [1440px](graph-235-1440.png), [390px](graph-235-390.png).

## Validation

Executed on 2026-11-06:

- `npm test`: 793 passed.
- `UPDATE_CANVAS_FIRST_SCREENSHOTS=1 npx playwright test tests/browser/graph-canvas-first.spec.js tests/browser/extension-layout.spec.js tests/browser/graph-quick-add.spec.js tests/browser/graph-traceability.spec.js tests/browser/graph-routing.spec.js --workers=1 --reporter=line`: 140 passed across Chromium and WebKit; 2 screenshot-only cases intentionally skipped.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-canvas-first.spec.js tests/extension/graph-quick-add.spec.js --reporter=line`: 2 passed. These editor-only tests package the production modules with the real MV3 manifest and load them in Chromium, without inference assets.
- `node --check extension/graph-editor.js` and `git diff --check`: passed.

Coverage includes 1440px/390px/320px toolbar geometry and accessible names,
pointer/keyboard/touch selection, settings blur before deselection/removal,
viewport-fixed controls, presets and tiny Fit, focus recovery, last-row ports,
edge disconnection, input detach/reconnect/cancellation, routing/crossings,
quick-add placement/dismissal, import/export, discard confirmations, optional
warnings, conflicting saves, active-earlier-graph notices, and invalid saved-JSON
recovery. Two WebKit screenshot-only cases are intentionally skipped by the
existing routing suites to keep one evidence image per state.

`npm run build:extension` stopped at its existing asset prerequisite: "Missing
local models. Run npm run prepare:assets first." Full inference packaging and
real-model smoke tests were not run; no runtime or model changes were made.
