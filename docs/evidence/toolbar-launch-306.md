# Toolbar graph selection — Issue #306

The native action menu now uses **Graphs → Open → graph names**, with radio
items marking the persisted selection and **Graph Library** alongside **Open**.
This supersedes the separate launch/default controls described in
[Issue #267's historical evidence](toolbar-launch-267.md).

Open validates and commits the chosen stable ID to `assignments.live` through
the offscreen host and `GraphLibrary.change()` Web Lock before creating a window.
A stale/unrunnable choice or failed commit opens an actionable error window with
no graph ID; later focus/storage refreshes cannot enable Start for that failed
launch. Each successful launch keeps its own graph ID, invoking tab and session
ID, without automatically starting capture or following subsequent selections.

Toolbar reads recheck the current library under the same lock. If the selection
is unusable, they persist the first runnable top-level graph in name order. The
shared comparator matches Graph Library: `Intl.Collator('ja', { numeric: true })`
with stable ID ties. A valid selection survives renames/reordering. Conditional
changes explicitly return `false` when unchanged, avoiding revision writes and
notification loops. An empty runnable list produces disabled Open guidance while
keeping Graph Library accessible. The separate in-page microphone chooser and
its assignment rules are unchanged.

## Automated validation

Checks used this worktree's sources and isolated temporary browser profiles.
Browser fixtures exercise the production MV3 worker, offscreen host, storage,
native menu API, Library, editor and recorder. Model inference is controlled;
these checks require no production model downloads or real GPU inference.

- `npm test`: **953 passed**. Includes deterministic numeric/Latin/kana sorting,
  stable ties, multiple-candidate fallback, unchanged reads/repeated Open without
  writes, concurrent fallback/selection/editor changes, deletion before selection
  obtains its lock, failed saves, empty/unrunnable libraries, eligibility and
  dependency checks, menu hierarchy, serialized refresh storms, and error windows
  that cannot silently launch a different graph.
- `npx playwright test --config playwright.extension.config.js tests/extension/toolbar-launch.spec.js tests/extension/graph-library.spec.js tests/extension/web-voice.spec.js tests/extension/subgraphs.spec.js`:
  initial run **116 passed, 3 failed**. Two subgraph assertions still expected the
  superseded selection behavior and error text; these were updated and passed in
  the focused run below. The remaining failure was the Web microphone open-shadow
  Cancel case: it retained visible canceled-preparation feedback while expecting
  the control to hide. Its isolated rerun passed; no microphone behavior was
  changed. All **28 Graph Library** cases passed, including Japanese name ordering,
  autosave, concurrent edits and storage recovery.
- `npx playwright test --config playwright.extension.config.js tests/extension/toolbar-launch.spec.js tests/extension/subgraphs.spec.js tests/extension/graph-concurrent.spec.js tests/extension/extension.spec.js --grep 'toolbar|unset selection|three simultaneous|missing/deleted|no runnable|last Open|real toolbar|stale definition'`:
  **12 passed** after updating the subgraph assertions and adding the browser
  ordering case. Covers all seven toolbar cases, both shared-subgraph cases,
  independent real toolbar tab captures, invoking-tab activeTab field output,
  numeric/kana/tie fallback, persisted selection across browser/worker restart,
  repeated reads without revision changes, stale/invalid/empty choices, independent
  windows/snapshots and resource cleanup. Recording remains Idle until Start.
- `npx playwright test --config playwright.extension.config.js tests/extension/web-voice.spec.js --grep 'open-shadow modal keeps Cancel'`:
  **1 passed** on isolated rerun. The initial intermittent failure remains noted
  above; the broad run was not a clean single pass.
- `git diff --check`: passed.
- `npm run build:extension`: blocked by **missing local models**, reporting
  `Missing local models. Run npm run prepare:assets first.` No large model
  downloads were attempted. The unit packaging test and source-assembled browser
  extensions passed; a production model-bearing bundle was not built.

## Native-menu limits

Headless Chrome creates real `chrome.contextMenus` entries but has no visible
toolbar context menu. Tests inspect creation properties and invoke the registered
production menu listener with explicit tab arguments. Actual toolbar actions and
activeTab behavior are separately exercised through Chrome CDP. Physical menu
rendering, OS radio appearance and keyboard navigation, Chrome's built-in
extension-management entries, and activeTab grants from a physical right-click
Open selection still require a visible-browser manual check. No physical
microphone or production-model capacity verification is claimed.
