# Generic paired TEXT formatting (#158)

Historical record: Issue #169 supersedes the provisional-delivery rejection below;
PairedTextToDOM now formats provisional and committed atomic groups identically.

PairedTextToDOM now exposes only input1/input2: TEXT and dom: DOM. Each completed
Pipeline group containing input1 emits one literal pair; omitted input2 is blank,
input2-only groups emit nothing, and independent/mismatched/provisional deliveries
cannot create pairs. Both routes must belong to the same producer's group. Equal
texts and empty strings retain their positions. First text/Second text accessible
labels replace translation labels. Equal-height cells, linked hover/focus, safe
cloning, direct replacement, explicit DOM history and preview composition remain.

Translation examples wire source → input1 and text → input2. Specific failures
remain in existing translation diagnostics. Unit tests verify preparation/load,
inference, empty/malformed output and Worker failure reporting. The per-utterance
length check previously emitted only error TEXT; it now also reports through the
existing onState observer. MV3 tests verify missing/evicted assets, inference and
WebAssembly failures, and recovery after a too-long utterance, in both directions.
No formatter error port, replacement node or error UI is introduced.

Graph v12 offers a reviewed draft for v11 paired formatters: source/text inputs
become input1/input2 and any incoming formatter error route is explicitly listed
as removed in the draft. Other error fan-out and unrelated graph data remain.
The saved original is untouched until Save, then backed up verbatim under
processing-graph-before-v12 (numbered on collisions). Older backups remain
available. Invalid conversions require repair/reset rather than silent loss.
V11 graphs without paired formatters upgrade without review; earlier versions
continue their reviewed migrations. Unit and MV3 editor tests cover save/reload,
original export, old recovery copies and unrelated nodes/edges/settings; unit
tests also cover storage-write failure, collisions and invalid conversions.

## Validation

- `npm test`: 618 passed.
- Chromium and WebKit: 22 distinct tests passed across `dom-display.spec.js`,
  `translation-preset.spec.js` and `live-scroll.spec.js`. Covers arbitrary grouped
  producers, both edge orders, duplicates/empty values/omissions, independent and
  mismatched values, actual cell geometry, neutral accessibility, hover/focus,
  literal text, cloning, latest replacement and explicit history/preview layouts.
- MV3 `live-text.spec.js`: 25 distinct tests passed, including both translation
  directions, direct/explicit history, Stop/Cancel/restart, combined preview,
  editor port presentation, and v11 migration review/save/reload/recovery.
- MV3 `graph.spec.js`, `graph-interactions.spec.js`, `translategemma.spec.js`, and
  `windowed-translation.spec.js`: 47 distinct tests passed, covering older graph
  migration, field fan-out, editor save/reload, concurrent drafts and composition.
- MV3 `translation.spec.js`: 24 passed with the production OPUS Worker protocol
  and fixture inference, including both directions, missing/evicted assets,
  unavailable WebAssembly, inference and utterance-limit diagnostics, offline
  profile reuse, Stop/Cancel/restart and successful routing after a length error.
- `git diff --check`: passed.

Affected assertions were updated for neutral labels and blank failure cells;
those cases were rerun successfully. The new migration fixture supplies the
recorder's required toolbar tab context before checking that Start is enabled.
The MV3 tests use the existing deterministic model/asset fixtures with production
Pipeline, formatter, scheduler, graph/editor and extension UI code. Since prepared
models were absent, a source-layout fixture package was staged in ignored
`dist/chrome-extension` by copying extension/, web/ and the extension manifest;
this is not a validated production build.

## Blocked model-dependent checks

`npm run build:extension` stops with “Missing local models. Run npm run
prepare:assets first.” Prepared ASR/model/runtime assets are absent from this
worktree. The full production package build and real OPUS-MT/TranslateGemma
inference smoke checks were not completed. Fixture inference establishes wiring,
lifecycle and diagnostic behavior, not real model quality or GPU compatibility.
No usage reset, allowance purchase or model/provider switch was performed.

Required post-merge verification: none in Issue #158.
