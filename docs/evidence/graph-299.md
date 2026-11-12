# Graph Editor Auto Save and session history (#299)

Implemented regular graph and shared-definition editing with 100 memory-only
Undo transactions, grouped typing/IME/keyboard movement, one transaction per
pointer drag, and native field Undo/Redo. New edits clear Redo. Import, Reset,
settings, dynamic inputs, connections and exposed ports use the same transaction
boundary. Undo/Redo is persisted automatically. Undoing Create Subgraph restores
the parent graph without deleting the separately persisted shared definition.

The page coordinator checkpoints committed edits synchronously, debounces saves
by 300 ms and serializes revision-checked writes. Typing transactions settle after
450 ms or blur; composition waits for completion. Lifecycle events capture the
remaining transaction. Recovery records carry graph ID, session ID and base
revision outside the unchanged library schema. Newer drafts survive older save
acknowledgements, including Undo back to the previous saved document while a write
is pending. A conflict cannot be cleared by Undo or an obsolete acknowledgement.
A new-base checkpoint must succeed before its preceding recovery copy is removed.
No checkpoint serialization/storage runs per pointermove or input character.

App navigation awaits persistence, including changes made while that flush is
pending. Failures block app navigation and expose retry/export. Closing uses
synchronous checkpoints plus a best-effort flush; only unrecoverable changes
trigger an unload warning. Reopening offers explicit restoration against the
matching revision; stale or malformed records remain export-only. This is browser
storage recovery, not a guarantee against device/storage failure.

A lifetime `processing-graph-edit:<id>` Web Lock gives one graph editor exclusive
editing. Viewers retain inspection/export/navigation and explicitly acquire
editing after release, rereading persisted data and starting fresh history.
Unsupported coordination leaves the editor read-only. Library transactions keep
the existing separate lock and stale-revision/reference validation. Other graph
saves preserve composing fields and caret positions. External dependency changes
refresh the relevant graph without adding Undo steps.

Model preparation follows successful persistence asynchronously and retains
running/verified entries with equivalent model/voice requirements. Obsolete work
is canceled; returning to a requirement waits for its preceding run. Opening an
editor checks cache state, exposing explicit preparation/retry without restarting
downloads. Live's runtime ownership and immutable active snapshots remain intact.

## Validation

Installed repository dependencies with `npm ci --ignore-scripts`.

- `npm test`: **955 passed**, 0 failed.
- JavaScript syntax checks for changed modules/specs and `git diff --check`: passed.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-autosave.spec.js`: **8 passed**. Covers grouping, desktop/native shortcuts, IME, Undo/Redo persistence, identical-content revisions, close recovery, navigation flush/failure, quota/invalid values, stale-base recovery, exclusive editing/takeover, independent graphs and composing-field preservation.
- Core regression batch (`graph.spec.js`, `graph-models.spec.js`, `graph-actions.spec.js`, `graph-concurrent.spec.js`, `subgraphs.spec.js`, plus the then-seven Auto Save cases; `--workers=2`): **34 passed**.
- Library/interaction batch (`graph-canvas-first.spec.js`, `graph-quick-add.spec.js`, `graph-if-condition.spec.js`, `graph-library.spec.js`; `--workers=2`): **37 passed**.
- Chromium browser batch (`tests/browser/subgraphs.spec.js` and `tests/browser/graph-canvas-first.spec.js`; `ASR_BASE_URL=http://localhost:8765`, `--project=chromium --workers=1`): **25 passed**. These specs route production source modules locally. Includes 1440/390/320 px layouts, revision conflicts, parent navigation/deletion, subgraph compatibility safeguards, and persisted extraction Undo/Redo retaining shared definitions.
- Follow-up editor/ITEM/subgraph batch: **11 passed**; subsequent ITEM-only check: **2 passed**.
- Model/streaming follow-up (`graph-autosave.spec.js`, `graph-text-summary.spec.js`, `item.spec.js`, `layout.spec.js`, `streaming-tts.spec.js`, `translategemma.spec.js`; `--workers=2`): **28 passed, 2 failed, 2 skipped**. The ITEM recovery failure was subsequently corrected by explicitly selecting the recovered graph in Live and both ITEM cases passed. The remaining compact-Live layout case starts directly seeded optional translation models without usable runtime readiness; it is outside the editor persistence checks. Text-summary, Gemma and controlled streaming TTS cases passed. Skips require real model inference.

The broad `npm run test:extension -- --workers=2` attempt, before final fixture
migrations, produced **277 passed, 80 failed, 16 skipped**. This is **not** a passing
full-suite result. Many cases require absent `dist/chrome-extension` assets;
changed Save-dependent fixture assumptions were corrected and rerun in the
focused batches above. Other remaining fixture gaps include an empty optional-ASR
parallel graph setup and shared-UI assertions for older Live navigation/URL
behavior. No claim is made that the complete extension suite is green.

`npm run build:extension` cannot complete in this checkout:
`Missing local models. Run npm run prepare:assets first.` The generated model and
runtime bundles are not present. No model bundles were downloaded for this issue.
The passing model tests use controlled asset/inference fixtures with production
editor/library/preparation/runtime modules; they do not establish real model
quality, throughput or GPU compatibility. No benchmark was added or required.

## Main integration review fix

Integrated reviewed main commit `b6d47171d2cf62a67cda84e0650464f5eb138d7f`
to resolve the nine conflicting files. Preserved main's toolbar graph selection,
name-order fallback and removal of editor/Inspector help, together with Auto Save,
recovery, session history and single-writer editing. Shared keyboard/layout tests
now use Undo/Redo and distinguish undoing a setting from undoing node creation.

Validation after integration:

- `npm test`: **962 passed**, 0 failed.
- Syntax checks: **24 changed JavaScript files passed**; `git diff --cached --check`
  passed; no unresolved merge entries remain.
- Browser batch (`extension-layout.spec.js`, `graph-canvas-first.spec.js`,
  `graph-port-order.spec.js`, `subgraphs.spec.js`, `keyed-text-coalesce.spec.js`,
  `view.spec.js`; Chromium and WebKit, `--workers=2`): **124 passed, 2 failed**.
  Corrected the two Undo/keyboard assertions; rerunning
  `extension-layout.spec.js --grep 'canvas-first editor:'` in both engines:
  **2 passed**.
- MV3 batch (`graph-autosave.spec.js`, `graph-concurrent.spec.js`,
  `subgraphs.spec.js`, `toolbar-launch.spec.js`, `layout.spec.js`,
  `graph-models.spec.js`, `graph-optional-asr.spec.js`, `translategemma.spec.js`):
  **46 passed, 3 failed**. Corrected the stale Save-button focus assertion;
  `layout.spec.js --grep 'palette search/categories'`: **1 passed**.
- The remaining two MV3 failures reproduce at pre-integration commit `8b81449`
  in an isolated worktree: optional-ASR's parallel production case has an empty
  graph setup and accesses an absent Worker; compact Live layout times out with
  **Models unavailable**. Both were already recorded above and remain outside
  this merge-conflict fix. This is not a passing full-extension-suite result.
- Additional MV3 batch (`graph.spec.js`, `graph-actions.spec.js`,
  `graph-port-order.spec.js`, `shared-ui.spec.js`): **11 passed, 2 failed**.
  Both shared-UI failures also reproduce at `8b81449`: obsolete Live navigation
  and exact-URL assertions. No runtime/test changes were made to substitute for
  those existing failures.
