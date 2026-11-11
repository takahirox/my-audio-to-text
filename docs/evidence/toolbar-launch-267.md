# Toolbar launch and Graph Library — Issue #267

Implemented against the selected upstream for [Issue #267](https://github.com/takahirox/my-audio-to-text/issues/267).

The toolbar uses one native `contexts: ['action']` submenu with separate **Open**
commands and **Default for left-click** radio choices. Only `contextMenus` was
added to required permissions. The existing `assignments.live` stable ID now
serves as the persisted toolbar default. Each launch creates a new popup URL
containing its graph ID, invocation tab and independent session ID; it does not
capture automatically. Windows never follow later default changes. Missing or
invalid graphs block Start; the sole runnable graph can become the default when
there is exactly one candidate. Deleting defaults clears their IDs explicitly.

The service worker reads/writes the existing localStorage library through the
existing offscreen DOM host, under the existing library Web Lock. Library reads
and default writes participate in the same serialized host lifecycle as Web
sessions, without closing active owners or introducing a second storage mirror.
Editor activity aggregates independent Live session IDs. A failed or closed
window cannot clear another window's activity indicator.

Launch Settings, both assignment dropdowns and the assignment-only filter are
removed. Graph details, search, recovery, import/export, Models and draft conflict
handling remain. Web microphone consent is a compact control above the list,
starts OFF, and remains revocable even with corrupt graph storage. The page mic
has a compatible-default context menu with keyboard support, so removing the
old Web dropdown leaves an actionable selection path. Its default and active
snapshot remain independent of Live. Parent graphs resolve shared definitions
through the canonical #265 library resolver before launch validation and each
Start. Reusable definitions are excluded from launch choices; running sessions
retain their expanded snapshots when definitions are edited.

## Validation

All checks used the current worktree sources and isolated temporary browser
profiles. The Chrome extension tests load the real MV3 worker, offscreen host,
recorder, Library, editor, storage, Pipeline and DOM. Model inference is controlled
with fixture Workers; no downloaded production weights or real GPU inference are
claimed.

- `npm test`: **894 passed**. Includes launch/default validation, lossless migration,
  recovery, missing/invalid defaults, sole-candidate fallback, incomplete-draft
  repair, Web compatibility and the offscreen library-request/capture lifecycle.
- `npx playwright test --config playwright.extension.config.js tests/extension/toolbar-launch.spec.js tests/extension/graph-library.spec.js tests/extension/web-voice.spec.js`:
  **51 passed**. Covers native menu definitions and registered
  action/menu handlers, default persistence across a full browser/worker restart,
  graph+tab+session per popup, three independent graph sessions, workers, snapshots,
  Stop/failure/close/deletion, multiple activity badges, actual action activeTab
  field authorization despite focus changes, consent/denial/revocation, page-mic
  right-click/Shift+F10 and empty menus, corrupted-storage OFF, concurrent Live/Web
  ownership, and Library CRUD/conflicts/recovery/responsive keyboard access.
- `npx playwright test --config playwright.extension.config.js tests/extension/extension.spec.js --grep 'real toolbar'`:
  **1 passed**. Uses Chrome's actual `Extensions.triggerAction` and native
  `tabCapture` on three separate tabs playing controlled browser audio. All three
  capture simultaneously; one Stop, window close, or target navigation/close
  preserves the other owners. Repeat launch creates another distinct window.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-concurrent.spec.js tests/extension/graph.spec.js tests/extension/graph-whisper.spec.js tests/extension/simple-layout.spec.js tests/extension/graph-actions.spec.js tests/extension/graph-model-failures.spec.js tests/extension/graph-speaker.spec.js tests/extension/graph-zipformer.spec.js tests/extension/graph-if-condition.spec.js`
  covers concurrent audio paths,
  ASR, actions, model failures, speakers, display layouts and conditions; final
  result: **51 passed**. Retired global `invoke` test calls now supply the tab in
  each window's launch URL. Existing assertions were updated for the current
  four Zipformer text/ID ports, Library navigation order, explicit model asset
  preparation, and immutable window graph IDs after recovery-as-new.
- `git diff --check`: passed.
- `npm run build:extension`: **blocked by missing local models**, reporting
  `Missing local models. Run npm run prepare:assets first.` No large production
  model downloads were attempted. Source-assembled extension tests and the unit
  packaging test ran; a production model-bearing bundle was not built.

## Manual-browser limits

Headless Chrome has no visible native toolbar context menu. Tests create actual
Chrome menu items and invoke the production registered menu listener with explicit
event tabs; they do not click OS menu rows. Real toolbar action invocations and
activeTab field injection are separately exercised through Chrome CDP. Physical
right-click menu rendering, Chrome's built-in management entries and native
keyboard access, and activeTab grants from a physical context-menu selection
remain manual checks. Native site/microphone permission-bubble buttons are not
clicked by automation: tests control the permission decision or seed a host grant
in an isolated profile, then exercise production consent and revocation. Device
microphone tests use Chrome's fake audio device; no physical microphone/device
contention, real-model RAM/GPU capacity or platform-specific capture limit is
claimed.

Chrome API references: [native contextMenus](https://developer.chrome.com/docs/extensions/reference/api/contextMenus),
[activeTab invocation grants](https://developer.chrome.com/docs/extensions/get-started/tutorial/scripts-activetab).

## Screenshots

- [Wide graph workspace](library-267-1440.png)
- [Narrow graph details](library-267-390.png)
- [390px graph list](library-267-list-390.png)
- [320px graph list](library-267-list-320.png)

## Integration with merged #266

Resolved the conflicts with `main` at
`77e28cc7eb15e75ca884b8f1ffce189312134ec1`. The merged page-mic picker keeps
its separate persisted default, compatible-graph filtering, caret preservation,
and Preparing/Recording/Stopping selection guards. Toolbar requests share the
offscreen lifecycle while using a separate pending-request map, so catalog reads
and cleanup preserve independent Web sessions. The graph-only workspace keeps
its compact consent switch and zero-compatible-graph guidance.

Checks run against the combined implementation:

- `npm test`: **896 passed**.
- `npx playwright test --config playwright.extension.config.js tests/extension/toolbar-launch.spec.js tests/extension/graph-library.spec.js tests/extension/web-voice.spec.js tests/extension/graph-concurrent.spec.js`:
  **59 passed**, including corrupt-storage microphone revocation.
- `npx playwright test --config playwright.extension.config.js tests/extension/extension.spec.js --grep 'real toolbar'`:
  **1 passed**, including three simultaneous native tab captures.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-library.spec.js --grep 'Library manages independent'`:
  **1 passed** after adding the zero-compatible-graph guidance assertion.
- `git diff --check` and `git diff --cached --check`: passed.

The manual-browser and production-model limitations above still apply. No
physical menu, hardware-capacity or production model-bundle verification was
performed during this integration.

## Integration with merged #265

Integrated `main` at `32824e54fe7d8df593caf1b2ebba3cd5e726acd2` and
resolved the Library conflicts while preserving the graph-only workspace,
revocable microphone control, reusable-subgraph filters, previews, editing,
bundle import/export and reference-protected deletion.

Toolbar validation and default selection now resolve saved parents through the
canonical library. Reusable definitions cannot run directly. Selected windows
resolve their own parent and current definitions at each Start, without following
later default changes. Definition edits leave running snapshots intact, and
incomplete or missing dependencies keep Start disabled with a recovery error.

Checks run against these combined sources:

- `npm test`: **920 passed**.
- `npx playwright test --config playwright.extension.config.js tests/extension/toolbar-launch.spec.js tests/extension/subgraphs.spec.js tests/extension/graph-library.spec.js tests/extension/web-voice.spec.js tests/extension/graph-concurrent.spec.js`:
  **61 passed**. Includes two independent toolbar-launched parent windows sharing
  one definition: each retains its active snapshot until its own next Start,
  and changing the default/reloading/closing one preserves the other's graph.
- `npx playwright test --config playwright.extension.config.js tests/extension/subgraphs.spec.js --grep 'stale definition'`:
  **1 passed**, added after the suite above. Covers incomplete parent, direct
  definition and missing-dependency selections with no model workers or Start.
- `npx playwright test tests/browser/subgraphs.spec.js --project=chromium`:
  **11 passed**, including Library type filters, dependency bundles, reference
  deletion safeguards, editor extraction, concurrent saves and draft recovery.
- `npx playwright test --config playwright.extension.config.js tests/extension/extension.spec.js --grep 'real toolbar'`:
  **1 passed**, including three simultaneous native tab captures and scoped cleanup.
- `git diff --check` and `git diff --cached --check`: passed.

The native menu and permission-dialog questions remain for human review.
The headless automation limitations above still apply; no physical menu,
permission-bubble, hardware or production-model verification is claimed here.
