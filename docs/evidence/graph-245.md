# Graph Editor session status (#245)

Routine Live activity now appears as a green **Active** indicator beside the
editor's **Saved / Unsaved** state. Only the graph ID running in Live is marked
active. The capture tab ID is available in the indicator's title, without a
separate routine status row. One atomic status region announces draft/activity
changes; unchanged status text is not rewritten on every canvas redraw.

External-save conflicts and an older running snapshot retain their full,
actionable text in a conditional warning below the toolbar. Combined warnings
wrap without clipping, and a failed Save retains the existing error alert.
Idle and ordinary active states hide the warning element completely, including
its margins. At 320px, draft/activity labels stack inside the same 44px toolbar;
Add Node, Save, Graph actions and Help keep their full-sized controls.

## Measured layout

Chromium 153.0.8010.12, 900px viewport height, default graph, no exceptional
status warnings. Baseline is checkpoint `990204163ed6ddc2de924969b5f2a9125d0aebc2`.
The measurement loaded the baseline editor JS/CSS from Git and the final files
in isolated browser contexts, then sent the same matching-graph Live event with
synthetic tab ID `1476958582`. Exact idle/active geometry is retained in
[graph-245-layout.json](graph-245-layout.json).

| Width | Active toolbar height | Routine status row before → after | Canvas top before → after | Canvas height before → after |
| --- | --- | --- | --- | --- |
| 1440px | 44px | 19.125 → 0px | 154.375 → 125.5px | 744 → 760px |
| 390px | 44px | 19.125 → 0px | 191.875 → 163px | 558 → 588px |
| 320px | 44px | 19.125 → 0px | 191.875 → 163px | 558 → 588px |

The canvas starts 28.875px earlier during ordinary Live activity. Its CSS height
budget also increases: 16px on desktop and 30px at narrow widths. Within the final
layout, idle, active, unsaved-active and unrelated-graph states have identical
canvas geometry; no routine session row reserves space.

Screenshots show unsaved drafts with Active at [1440px](graph-245-1440.png),
[390px](graph-245-390.png), and [320px](graph-245-320.png), plus
[combined warnings and a rejected save at 320px](graph-245-warnings-320.png).

## Executed validation

Executed on 2026-11-07:

- `npm ci`: completed; no dependency changes.
- `npm test`: **858 passed**.
- `npx playwright install chromium webkit`: installed the pinned browsers after
  the first browser attempt stopped because the executables were absent.
- `UPDATE_GRAPH_STATUS_SCREENSHOTS=1 npx playwright test tests/browser/graph-canvas-first.spec.js tests/browser/extension-layout.spec.js tests/browser/graph-quick-add.spec.js tests/browser/graph-traceability.spec.js tests/browser/graph-routing.spec.js --workers=1 --reporter=line`:
  **140 passed, 6 failed, 2 skipped** initially. The six failures were stale
  graph-library test assumptions: Save advances envelope revisions/timestamps,
  and the editor heading now includes the graph name. Assertions now compare
  graph IDs/payloads across an unchanged Save and locate the named editor heading.
- `UPDATE_GRAPH_STATUS_SCREENSHOTS=1 npx playwright test tests/browser/extension-layout.spec.js tests/browser/graph-quick-add.spec.js tests/browser/graph-canvas-first.spec.js --grep 'canvas headings|touch selects|save conflicts' --workers=1 --reporter=line`:
  **8 passed**, covering all six corrected failures and both combined-warning
  cases. Across these runs, **146 distinct browser cases passed**. The two
  existing WebKit screenshot-only cases remain intentionally skipped.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-canvas-first.spec.js tests/extension/graph-quick-add.spec.js tests/extension/graph-library.spec.js --grep 'canvas-first|quick-add|toolbar activity|selected editor|Live assignment' --reporter=line`:
  **5 passed (12.9s)** against the real MV3 manifest and production modules.
  Earlier runs exposed an overly strict new spacing assertion (corrected to the
  existing idle-layout tolerance) and a quick-add reseeding timeout. Reseeding
  now explicitly accepts the graph-library unsaved-draft navigation prompt and
  removes that temporary handler after reload.
- `node --check extension/graph-editor.js`,
  `node --check tests/fixtures/graph-canvas-first.js`, and `git diff --check`:
  passed.
- `npm run build:extension`: stopped at the existing prerequisite,
  **Missing local models. Run npm run prepare:assets first.** Full inference
  packaging and real-model smoke tests were not run. The MV3 fixtures package
  the production editor without inference assets; the library integration uses
  actual storage/session boundaries with controlled model replies.

Coverage includes 1440px/390px/320px status geometry, hidden tab IDs, accessible
status semantics, dirty drafts, full combined warnings, conflict rejection and
Load saved recovery, identical graphs with distinct IDs, runtime lookup after
reload, newer saved snapshots during Live, assignment changes, Stop/restart,
multi-tab saves, zoom/Fit, Inspector, keyboard/touch navigation, quick-add,
import/export, and connection routing. Runtime/capture behavior retains the
existing unit coverage; no graph payload, execution, model-lifecycle or tab
selection logic changed.

No post-merge-only verification is required by this issue.
