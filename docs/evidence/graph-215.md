# Traceable Graph Editor connections (#215)

Connections now reserve separate visual lanes and use a narrow background
outline to make unavoidable crossings read as overpasses. Stable light colors
provide an additional cue. These are present without hover or selection.
Graph JSON, positions, port validation and execution are unchanged.

## Visual evidence

- [Before, 100% zoom](graph-215-before.png): the actual #204 router's paths on
  the seven-card fixture. Independent connections share the vertical corridors
  beside the formatters and long horizontal runs; intersections look like
  junctions.
- [After, 100% zoom](graph-215-after.png): the same nodes, ports and logical
  edges. The independent corridors are separated, crossing gaps distinguish
  continuation from branching, and the two Hold feedback paths stay separate.
  No wire is hovered or selected.

Both screenshots were inspected locally. The normal-scale fixture has ten
connections: two three-way output fan-outs, nearby numbered inputs, long
parallel routes, seven genuine interior crossings, backward/upward paths and a
valid Hold feedback loop. Its only exact shared segments are 31–41-pixel stems
from the **same** output, not unrelated edges sharing a corridor. It has no
fallback or crowded-lane warning. Tests additionally exercise four parallel
connections around an obstacle, both separate output ports and fan-out, a
40-card/60-edge DOM graph, and a 60-card/90-edge geometry graph.

`tests/fixtures/dense-routing.json` is the logical graph.
`tests/fixtures/dense-routing-before.json` records the measured card/port
snapshot and paths obtained from `extension/graph-wire-router.js` at upstream
commit `03a7f3aa7068c6394323799bed840fe8fd39579d`. It is a captured old-router
result, not hand-authored geometry. The evidence test verifies identical cards
and endpoints before temporarily applying these recorded paths and the old
single-color styling. It restores the current drawing in `finally` and checks
clearance and attachment in both states. This keeps the comparison reproducible
without retaining a second router implementation in production or tests.

Regenerate the evidence pair with:

```sh
GRAPH_ROUTING_EVIDENCE=1 npx playwright test tests/browser/graph-traceability.spec.js --project=chromium --workers=1
```

Without the environment variable, images go to Playwright's ignored output
folder. If port 8000 is occupied, serve `web/` on a free local port and set
`ASR_BASE_URL` accordingly. The tests intercept extension files from this
worktree. If fonts/card layout change, regenerate the recorded old-router
snapshot from its recorded revision before updating the screenshot baseline.

## Executed validation

- `npm test`: **765 passed**. Router tests cover deterministic lanes, invariance
  under edge-array reordering, input immutability, fan-out, nearby ports,
  node clearance, backwards/vertical paths, drag reservations, constrained
  escapes, budget exhaustion, visible crowding metadata and bounded detours.
  All existing graph/runtime unit tests pass.
- `ASR_BASE_URL=http://127.0.0.1:8095 npx playwright test tests/browser/graph-routing.spec.js tests/browser/graph-traceability.spec.js tests/browser/extension-layout.spec.js --grep-invert 'live regions render safe snapshots' --workers=2`:
  **84 passed, 2 skipped**, Chromium and WebKit. The skips avoid duplicate
  screenshot captures in WebKit. Tests check actual SVG attachment and card
  clearance, default unselected lanes/crossing styling, broad hit targets at
  exact crossings and on the interrupted underpass, correct inspector endpoints,
  keyboard deletion, pointer/keyboard node movement, dense card/port reflow,
  adding a nearby input, zoom, Fit, scroll, reload, persistence and fallback
  recovery. Crossing selection is checked at 50%, 100% and 150% zoom.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-routing.spec.js tests/extension/graph-interactions.spec.js tests/extension/graph.spec.js tests/extension/graph-hold-feedback.spec.js --output=.cache/mv3-results`:
  **36 passed**, packaged source-only MV3 in Chromium. Native CDP touch selects
  the overpass and the underpass continuation, Disconnect removes exactly that
  logical edge, and native drag-to-connect restores that input while preserving
  fan-out and nodes. Existing touch detach/reconnect/cancellation, keyboard,
  inspector, import/Save/Load/reset, validation and saved/active isolation tests
  pass. The Hold runtime test uses real production graph/node code and a
  controlled Worker to check feedback serialization, Stop, failure and Cancel.
- `git diff --check`: passed.

The geometry helper samples actual rendered SVG line/quadratic commands with
at most two canvas pixels between samples, including corners. It uses native
SVG measurement for endpoint checks. Analytical sampling avoids repeated
`getPointAtLength` calls becoming the dominant cost in WebKit on routes with
more bends; clearance thresholds and the two-second assertion budget were not
relaxed. Native hit tests independently exercise the rendered SVG paths.

In the final 40-card/60-edge drag check, Chromium recorded 22 redraws with a
144.2 ms maximum, and WebKit recorded three redraws with a 157.0 ms maximum.
The existing 250 ms redraw guard passed in both. Unchanged drag routes are
reused, but a full reroute on release can exceed a display frame; these fixture
timings are observations on this machine, not a frame-rate guarantee.

## Packaging and limits

`npm run build:extension` was attempted and stops at “Missing local models.
Run npm run prepare:assets first.” MV3 checks use an ignored source-only package
marked `FIXTURE-ONLY.txt`, made from `extension/`, the manifest and the builder's
shared-file list. Existing fixtures provide controlled Workers and assets.
Production model packaging, real inference and physical touch hardware were
not verified for this visual change. No model downloads were performed.

The source-only package can be recreated without changing the production build:

```sh
python3 - <<'PY'
from pathlib import Path
import runpy, shutil
spec = runpy.run_path('scripts/build-extension.py')
target = Path('dist/chrome-extension')
(target / 'web').mkdir(parents=True, exist_ok=True)
shutil.copytree('extension', target / 'extension', dirs_exist_ok=True)
shutil.copy2('extension/manifest.json', target / 'manifest.json')
for name in spec['SHARED_FILES']:
    shutil.copy2(Path('web') / name, target / 'web' / name)
(target / 'FIXTURE-ONLY.txt').write_text('Source-only MV3 fixture; no production models.\n')
PY
```

The pre-existing `live regions render safe snapshots` layout test remains
excluded, as documented in [#204 evidence](graph-204.md): it supplies strings to
an API requiring an actual inert DOM node. No claim is made about the complete
browser or extension/model test suites.

Lane routing is a bounded, deterministic greedy heuristic, not a global
planarity solver. Some layouts have insufficient room. After establishing clear
baselines, remaining work searches for separated lanes within a length cap;
otherwise routes retain those baselines. Crowded routes are dotted with a
notice. Blocked ports or exhausted baseline budgets remain amber dashed cubic
fallbacks. Both can be ambiguous; keyboard connection details identify the
actual endpoints, and moving cards apart can recover ordinary routing. No
missing wire, automatic node movement or fabricated graph junction is used.
The six colors repeat and are supplementary, not a color-only identity scheme.
At very low zoom, gaps/lanes shrink; Fit is an overview rather than a guarantee
that a screen can display an arbitrarily large graph at reading scale.
