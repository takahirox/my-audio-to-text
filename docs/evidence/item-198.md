# Issue #198 verification

Implemented portable `KEYED_PAIRED_TEXT` and `KEYED_PAIRED_TEXT_LIST` values,
the small directional ITEM compatibility rule, coherent KeyedTextPair.pair
snapshots, generic KeyedPairedTextAccumulator and one Display.input: ITEM sink.
The [recommended importable graph](item-198.json),
[executable fixture](../../tests/fixtures/item-graph.js), editor Help and
[contract documentation](../display-items.md) use the new path.

The accumulator owns ordered append/replace history in arrival order. Display
only renders complete TEXT/pair/list snapshots. No upstream DOM, stage priority,
producer restriction, new model or specialized display type was introduced.

Saved Display.view routes open a reviewed compatibility draft adding only
`legacyView: true` to the same sink. Every original node, ID, setting, position,
edge and literal value survives. Until Save the original bytes remain untouched;
Save retains those exact bytes in a numbered recovery copy without replacing
older copies. Reload executes the retained VIEW path. Legacy TextDisplay and
DOM routes retain their implementations and storage. Graph version remains 15.

Checks run on 2026-11-03:

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed; 43 packages installed; no audit vulnerabilities |
| `npm test` | 975 passed, no failures or skips |
| `npx playwright test tests/browser/view.spec.js tests/browser/keyed-text.spec.js tests/browser/text-display.spec.js tests/browser/keyed-dom.spec.js tests/browser/keyed-text-coalesce.spec.js --workers=1` | 26 passed in Chromium/WebKit |
| `npx playwright test tests/browser/view.spec.js --workers=1` | 4 passed after adding the explicit left-side empty-clear assertion |
| `npx playwright test --config playwright.extension.config.js tests/extension/item.spec.js tests/extension/view.spec.js tests/extension/keyed-text.spec.js tests/extension/keyed-dom.spec.js` | 7 passed in actual Chromium MV3 pages with controlled model Workers |
| `npm run build:extension` | Blocked by missing local model assets; requests `npm run prepare:assets` |
| `git diff --check` | Passed |
| Changed Markdown local link check | Passed |

Node coverage includes exact portable shapes, JSON/structured cloning, rejection
of extra fields/accessors/sparse or custom arrays/duplicate and nonfinite IDs,
empty strings and immutable copy ownership. A directional compatibility matrix
checks ITEM and strict unrelated contracts. Arbitrary producer/output names and
both edge orders work; structured outputs are snapshotted before queue/fan-out,
and values contradicting concrete declarations fail before any delivery.
Editor, saved graph and executable selection accept all three concrete streams
and reject unrelated types, multiple incoming edges and TEXT into the accumulator.

Pair/accumulator/display tests cover coherent snapshots, preservation of old
primitive outputs, appends, replacements in place, arrival-order replacement
without stage rules, empty and duplicate updates, retained independent snapshots,
Start clearing, Stop/Cancel, abort/disposal and stale contexts. Direct TEXT, pair
and full-list rendering is literal and has no hidden keyed history or input
mutation. Production runtime regressions exercise new ITEM and legacy VIEW/text
paths with all four translation adapters and transcription alone.

Browser tests exercise palette categories, keyboard connections, ITEM filtering,
strict accumulator inputs, Help, no Settings, Save/reload, direct text, equal
column widths, whitespace, accessible labels/focus and Live mounting. The
transcript graph tests provisional → final without a blank gap, simultaneous IDs,
reverse/late translation, right and left empty clears, duplicate updates, stable
row order, Cancel, late rejection and fresh display Start. MV3 tests cover actual
queued Worker replies, Stop/Cancel/session restart and cleanup, unchanged legacy
text/DOM/VIEW routes, reviewed migration, exact storage recovery and reload.

## Packaging and unperformed checks

The clean worktree has no prepared heavyweight model/runtime assets. The full
model-bearing builder was attempted and is blocked as reported above. MV3 tests
use an ignored code-only fixture package assembled from the production builder's
actual SHARED_FILES, extension directory and manifest, using the same procedure
recorded in [#196 verification](view-196.md#packaging-scope-and-unrun-checks).
The extension fixture supplies controlled model Workers/manifests in its owned
temporary directory and loads that package in Chromium. This verifies module
packaging and MV3 integration; it does not establish full model distribution
packaging. No model weights were downloaded for this processing/rendering change.

Real-model inference, real audio capture, native-host rendering and physical-device
checks were not performed. Native implementation is outside scope. Initial browser
launches were blocked by missing Playwright executables; installing Chromium and
WebKit resolved that setup issue, and the checks above then passed.

No push, pull request, merge or Issue comment was made. Deployment/publication
behavior is unchanged; this Issue adds no post-merge-only verification requirement.
