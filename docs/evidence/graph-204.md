# Obstacle-aware Graph Editor wires (#204)

The editor now uses a local, dependency-free orthogonal router, isolated from
pipeline execution and graph storage. The [approach and tradeoffs](../extension-graph.md#automatic-wire-routing)
describe clearance, rounded corners, bounded A*, shared visibility caching,
frame scheduling, drag reuse and fallback behavior.

## Visual evidence

- [Before](graph-204-before.png): the previous fixed cubic, reconstructed with
  the same port endpoints and identical three-card fixture, disappears under
  the middle formatter.
- [After](graph-204-after.png): the actual rounded route detours below that card
  with clearance and remains attached to the same input/output.
- [Dense](graph-204-dense.png): 40 formatter cards / 60 edges after a node drag
  and Fit. Routes avoid cards; some wires still share segments.

All three screenshots were inspected locally. Regenerate with
`GRAPH_ROUTING_EVIDENCE=1 npx playwright test tests/browser/graph-routing.spec.js --workers=1`.
Without that environment variable screenshots go to Playwright's output folder.

## Executed validation

- `npm test`: **715 passed**, including nine new router tests. These cover
  horizontal/backward/upward/downward paths, staggered barriers, clearance,
  changing obstacles/ports, deterministic results, input immutability, drag
  cache invalidation, overlapping/blocked ports, grid and search budgets, and
  a 60-card / 90-edge fixture.
- `npx playwright test tests/browser/graph-routing.spec.js tests/browser/extension-layout.spec.js --grep-invert 'live regions render safe snapshots' --workers=2`:
  **77 passed, 1 skipped** across Chromium/WebKit against the final source.
  Includes all 64 existing layout/interaction checks and 13 new routing checks;
  the skip avoids duplicating screenshot evidence in WebKit.
- `GRAPH_ROUTING_EVIDENCE=1 npx playwright test tests/browser/graph-routing.spec.js --workers=1`:
  expanded routing suite **13 passed, 1 skipped** across Chromium/WebKit.
  Samples rendered SVG curves against actual unrelated DOM card rectangles,
  checks clearance and exact port attachment, and verifies the hit target has
  identical path data. Covers pointer/keyboard node movement, runtime card/port
  resizing, adding/removing formatter inputs, backward/vertical routes, zoom
  25–150%, scroll, Fit, dense dragging, fallback recovery and persistence.
  Dense dragging recorded **21 redraws, maximum 4.2 ms** in Chromium and
  **3 redraws, maximum 6.0 ms** in WebKit on this machine. These are fixture
  observations, not a guarantee for every device/layout.
- `npx playwright test tests/browser/graph-routing.spec.js --grep 'detour hit' --workers=1`:
  **2 passed** after additionally asserting that rerouting a focused, selected
  wire following a ResizeObserver update preserves focus. Tab/Shift+Tab,
  Delete, keyboard reconnection, Save and reload also pass.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-routing.spec.js tests/extension/graph-interactions.spec.js tests/extension/graph.spec.js`:
  **33 passed** against the final source. Covers packaged MV3 routing geometry,
  native touch detour selection and Disconnect, native drag-to-connect,
  import/Save/Load/reset/validation, existing pointer/touch/keyboard
  reconnect/detach/cancellation, fan-out, typed-port/cycle rejection, inspector
  interactions, active/saved session isolation and controlled Worker execution.
- `git diff --check`: passed.

## Continuation validation (2026-11-04)

Integrated main `9b8e8c6` (including #205, #207 and #210) without conflicts.
The SVG geometry helper now measures each path's total length once per
assertion. Clearance sampling remains every 2 pixels, the geometry assertion
timeout remains 2000 ms, and the dense drag/redraw budgets are unchanged.
The earlier standalone **13 passed, 1 skipped** routing result was inherited;
the following checks were freshly executed on the integrated source:

- `npm test`: **750 passed**.
- `npx playwright test tests/browser/graph-routing.spec.js tests/browser/extension-layout.spec.js --grep-invert 'live regions render safe snapshots' --workers=2`:
  **77 passed, 1 skipped** across Chromium/WebKit, including all routing cases.
  Dense dragging recorded **21 redraws, maximum 4.2 ms** in Chromium and
  **3 redraws, maximum 5.0 ms** in WebKit. Screenshots went to ignored test
  output; the corrected committed before/after evidence was preserved.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-routing.spec.js tests/extension/graph-interactions.spec.js tests/extension/graph.spec.js`:
  **34 passed**, using an ignored source-only MV3 fixture package made from
  this worktree and the builder's current shared-file list. Workers/assets
  remain controlled fixtures, not real model inference.
- `git diff --check`: passed. Runtime, pipeline, typed contracts and canonical
  example graphs match integrated main exactly; only visual editor code,
  routing tests and routing documentation/evidence differ from main.
- `npm run build:extension`: freshly attempted; stopped at the missing local
  models check. Production packaging and real inference remain unverified.

## Limitations

`npm run build:extension` was attempted and stops at “Missing local models.
Run npm run prepare:assets first.” Extension tests used an ignored, source-only
`dist/chrome-extension` package marked `FIXTURE-ONLY.txt`, containing extension/,
the manifest and the builder's shared web modules. Existing test fixtures supply
controlled Workers/assets. This establishes editor behavior under MV3, not
production asset readiness or real model inference. No model downloads were
needed for this visual change.

The existing `live regions render safe snapshots` browser layout case remains
excluded: it supplies strings to the DOM-only rendering API and fails with
“DOM expects an actual inert HTML Node or DocumentFragment.” This pre-existing
failure is documented in #160 evidence; this routing change does not claim to
fix it or to pass the entire browser suite.

No wire lane allocation/crossing optimization is implemented. At shared hit
areas, use keyboard focus to select obscured wires. Overlapping cards, ports
without room at the canvas boundary and budget-exhausting layouts use selectable
amber dashed fallback wires and a status message. Routing never changes logical
connections or moves nodes automatically.
