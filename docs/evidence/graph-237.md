# Issue #237: data before matching ID in the Graph Editor

The editor resolves explicit `inputOrder` / `outputOrder` metadata against each
instance definition. Canvas DOM order and Inspector port help use the same
helper; native keyboard tabs follow those DOM rows. Unknown, duplicate and
malformed order entries are ignored, and unspecified ports retain declaration
order. Numbered Display/TextFormatter inputs remain in numeric order when resized.

All five ASRs show final/finalId, followed by provisional/provisionalId where
supported. Committed-first matches the existing default graph's coalesce branch
1 (preferred final) and branch 2 (preview fallback). Both keyed consumers show
input1/id1 then input2/id2. All four translators show text/id before
provisional/provisionalId, with optional context last. Their outputs keep each
family together: text/id, source/error, then provisionalText/provisionalId and
provisionalSource/provisionalError. Source and error share the family's existing
ID; no new pairing or processing semantics are introduced.

Port contract objects, runtime output groups, producer/consumer delivery,
queue order, graph version 15, positions and named edge endpoints are unchanged.
No migration or rewiring is performed. The existing draw/ResizeObserver pipeline
measures the actual buttons after ordered DOM construction; coordinate changes
invalidate the wire routing signature.

## Geometry comparison

[Measured crossing counts at four zoom levels](graph-237-crossings.json) come
from the production Graph Editor in Chromium. The shared fixture also runs in
WebKit and the packaged MV3 editor. It uses the default transcription/translation
connections and adds preview translation-to-pair wires, plus disconnected
instances of every affected type and 12-input Display/TextFormatter nodes.
Fixture positions leave clear routing corridors, including a wider audio-to-ASR
gap than the default graph. Production graph positions are unchanged.

For each source/target corridor, the comparison measures rendered button row
centers. The legacy baseline assigns the same row slots in contract object-key
order; the new measurement uses actual named button positions. It counts pairs
of straight connections whose endpoint vertical order is reversed, forcing a
crossing or an extra detour. Node positions, edge identities and row slots are
held fixed. This measures crossings attributable to port order, rather than all
crossings chosen by the obstacle-aware router.

| Corridor | Before | After |
| --- | ---: | ---: |
| ASR → KeyedTextCoalesce (4 wires) | 6 | 0 |
| KeyedTextCoalesce → KeyedTextPair (2 wires) | 0 | 0 |
| Translator committed text/ID → KeyedTextPair (2 wires) | 1 | 0 |
| Translator provisional text/ID → KeyedTextPair (2 wires) | 1 | 0 |
| Total | 8 | 0 |

The counts are identical at 25%, 50%, 100% and 150% zoom. Separate geometry
assertions sample the actual routed SVGs, check obstacle clearance and verify
that every path's endpoints match its exact named output/input button (within
0.05 screen pixels), with identical hit/casing paths.

## Validation

Executed on 2026-11-07:

- `npm test`: 807 passed, including 14 new port-order tests. Existing runtime,
  grouped delivery, scheduling, storage and named-port validation tests pass.
- `GRAPH_PORT_ORDER_EVIDENCE=1 npx playwright test tests/browser/graph-port-order.spec.js tests/browser/graph-routing.spec.js tests/browser/graph-canvas-first.spec.js tests/browser/graph-quick-add.spec.js tests/browser/graph-traceability.spec.js tests/browser/extension-layout.spec.js --workers=1 --reporter=line --output=test-results/browser-final-237`:
  144 passed across Chromium and WebKit; 2 existing screenshot-only WebKit cases
  intentionally skipped. An earlier concurrent run hit the existing 250 ms dense
  routing budget at 271 ms; the final serial run passed without changing the budget.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-port-order.spec.js tests/extension/graph-canvas-first.spec.js tests/extension/graph-quick-add.spec.js --workers=1 --reporter=line --output=test-results/mv3-final-237`:
  3 passed, loading production editor sources with the real MV3 manifest in
  Chromium. Includes the new ordering/geometry/gesture checks and existing
  canvas-first and quick-add regressions.
- `node --check extension/graph.js`, `node --check extension/graph-editor.js` and
  `git diff --check`: passed.
- `npm run build:extension`: blocked by the existing prerequisite, "Missing local
  models. Run npm run prepare:assets first." The MV3 editor tests package the
  production modules with the real manifest without downloading inference assets.
  Real-model inference smoke tests were not run; runtime/model code is unchanged.

New browser/MV3 checks cover every affected Node's rows and Inspector help,
native keyboard reachability of every paired/dynamic port, unchanged saved JSON
through geometry-only operations, exact named wire attachments at four zooms,
output toggling, keyboard connection/replacement, native output drag/drop,
occupied-input reconnection, edge selection/disconnection, dynamic add/connect/
remove through input13, and Save/reload retaining the original nodes and named
connections. Existing editor suites broaden regression coverage to responsive
layout, zoom/Fit, touch, selection, quick-add, recovery, import/export, save
conflicts, routing, crossings, and focus restoration.

The keyboard fixture uses Safari's Option-Tab convention for buttons on macOS
WebKit. Native HTML drag/drop and subsequent pointer-capture reconnection are
separated by a reload after confirming the restored named connection: macOS
WebKit can retain its native drag session after Playwright's synthetic drop.
Both gestures are exercised against production handlers.

## Review fix: WebKit dense-routing performance

The review's isolated reproduction consistently exceeded the existing 250 ms
redraw budget: three runs peaked at 275, 270 and 268 ms. The router now caches
grid-edge visibility in a bounded byte array instead of a Map and visits A*
neighbors without allocating four tuples per expanded state. Neighbor order,
search budgets, scoring, lane reservations and port presentation are unchanged.
The performance assertion is unchanged.

Executed on 2026-11-07 after the fix:

- `npx playwright test tests/browser/graph-routing.spec.js --project=webkit --grep 'dense routes remain clear' --workers=1 --repeat-each=3`:
  3 passed; maximum redraw times were 187, 176 and 177 ms.
- `node --test tests/graph-wire-router.test.js`: 14 passed.
- `npm test`: 807 passed.
- `npx playwright test tests/browser/graph-port-order.spec.js tests/browser/graph-routing.spec.js tests/browser/graph-canvas-first.spec.js tests/browser/graph-quick-add.spec.js tests/browser/graph-traceability.spec.js tests/browser/extension-layout.spec.js --workers=1 --reporter=line --output=test-results/browser-routing-fix-237`:
  144 passed, 2 expected screenshot-only WebKit skips. Dense-routing maximums
  were 97.3 ms in Chromium and 181 ms in WebKit.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-port-order.spec.js tests/extension/graph-routing.spec.js tests/extension/graph-canvas-first.spec.js tests/extension/graph-quick-add.spec.js --workers=1 --reporter=line --output=test-results/mv3-routing-fix-237`:
  the 3 source-packaged MV3 editor tests passed. The 4 additional routing tests
  failed during fixture setup because `dist/chrome-extension` is absent; they
  require the full extension build and its local-model prerequisites described
  above. No routing assertion ran in those 4 tests.
- A one-off Node comparison loaded the pre-fix router from Git and compared
  complete route objects on 40/60-card dense fixtures, with ordinary, constrained
  and zero search budgets, including reused drag routes. All 12 snapshots
  (900 routes) matched exactly, including points, SVG paths and fallback/crowding
  metadata.
- `node --check extension/graph-wire-router.js` and `git diff --check`: passed.
