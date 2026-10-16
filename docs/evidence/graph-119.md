# Issue #119 validation

Implemented in the assigned worktree on 2026-10-16. No push, pull request,
merge, comment, remote inference, or post-merge verification was performed.

## Resulting contracts

- Extension OPUS-MT Nodes accept committed `text: TEXT` and expose only
  `source`, `text`, `error`: TEXT. Each successful result is a direct atomic
  group; failure omits successful text. FIFO order distinguishes repeated
  phrases without public IDs, indices or status ports.
- Empty/whitespace input emits preserved source plus empty text/error without
  inference, even if preparation failed. Pending work emits nothing. Stop drains
  ASR tails and every committed translation; Cancel discards queued work and
  ignores late replies. Fresh Start creates fresh state and Workers.
- TextFormatter has independent `inputCount` settings, Add input / Remove last
  input controls, multi-digit numbered references, multiline literals and doubled
  brace escaping. Only the removed last input loses its wire. Invalid references
  and templates remain editable drafts and cannot overwrite the saved graph.
- Direct explicit groups replace only their producer's connected formatter
  inputs, clearing omitted siblings. Ordinary emits retain latest values;
  unrelated producers remain independent. This prevents source/error groups
  reusing old translation text without sending fake successful text to sinks.
  There is no cross-hop correlation or matching by string/timing.
- A generic formatter emits latest-result TEXT; LiveTextDisplay.append owns
  committed history. Repeated phrases append once per result; pending work adds
  no rows, failure can add one error result, and Cancel adds no canceled rows.
  Text substitution is literal data, including HTML-like strings and braces.

## Migration and recovery

Version 9 migrates versions 1–8, removing the paired formatter from supported
palette/runtime code. Affected saved graphs open an unsaved repair draft with a
visible report, retaining original storage until explicit Save. The report lists
removed status/index/provisional routes and the loss of indexed pending/history
updates. Source/text/error fan-out and unrelated labels, positions, wires and
literal content survive. Sole paired display replacement becomes per-result
append; shared/other output routes remain for deliberate review.

The original JSON is visible in Graph Editor before Save and retained under
`processing-graph-before-v9` afterwards. Backup quota failure prevents replacement
of the original graph. Later ordinary saves retain the recovery copy. Tests cover
all saved versions, both directions, long/colliding IDs, large positions, shared
sinks, field fan-out, generic formatter content, storage failures, review, Save
and reload. Chromium and WebKit exercise the visible v8 migration/recovery flow.

## Validation

- `npm test`: **337 passed**, no skips.
- Full Chromium/WebKit browser suite: **234 passed, 18 skipped**. Skips are the
  opt-in real-model, performance and benchmark suites, not formatter coverage.
- `tests/browser/extension-layout.spec.js` after adding v8 migration coverage:
  **14 passed** across Chromium/WebKit, including visible recovery/Save/reload.
- Full MV3 suite against the final production build: **148 passed, 8 skipped**
  in 5.0 minutes. This includes the unmocked pinned ReazonSpeech/Silero
  initialization/drain check under MV3 CSP and all graph, formatter, translation,
  target, display, cache, lifecycle and migration regressions.
- Focused fixture checks for graph interactions, model preparation, independent
  formatter counts/templates and both translation directions also passed
  **53/53**; the Whisper migration/lifecycle suite passed **8/8**.
- The browser test observer now retains WebKit's AudioWorklet JS wrapper;
  otherwise GC could lose the observer while the real module still loaded.
  A stale browser layout assertion was aligned with the existing saveable
  incomplete-draft policy. Full browser validation passed after these fixes.

`npm run build:extension`: **passed** after preparing the pinned ReazonSpeech,
translation runtime, Whisper, TTS frontend/runtime and Zipformer assets. The
packaged static module imports resolve and removed formatter modules are absent.
Generated model/runtime assets and dist output are ignored build inputs/outputs,
not committed source changes.

Fixture tests use production Pipeline, Nodes, Worker protocols, cache/preparation and UI while
replacing model inference/capture where declared by their fixtures. Such results
are not evidence of real model quality or physical microphone accuracy.

The eight MV3 skips and eighteen browser skips remain opt-in checks. Real OPUS-MT
weights/inference quality, physical microphone behavior and translation accuracy
were not exercised by this change. The unmocked packaged ASR check establishes
initialization/drain under CSP, not recognition or translation quality.

Required post-merge verification for #119: **none**.
