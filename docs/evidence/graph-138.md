# DOM-only Live display and composable formatters (#138)

LiveTextDisplay now has only `dom: DOM`. TextToDOM renders literal TEXT snapshots;
PairedTextToDOM owns committed translation history, table alignment, hover/focus
CSS and failure rows. DOM nodes stay on the page main thread; inference RPCs stay
TEXT. The sink validates/clones snapshots and the Live surface mounts its own copy.

Graph v11 blocks old TEXT display graphs until a user reviews and Saves the
conversion draft (or resets and Saves). Conversion inserts TextToDOM, preserves
unrelated Nodes/settings/routes, and retains exact original JSON under
`processing-graph-before-v11`, including numbered collision copies and all older
backups. Invalid current-version originals are also backed up before replacement.
No legacy TEXT display port or new output type exists.

Paired formatting validates grouped delivery at the consumer, accepting any
producer's completed atomic source/text and optional error values. The scheduler
marks actual preview results with internal provisional provenance; the consumer
rejects those deliveries before committing a pair. Compatible incomplete drafts
remain saveable, and inactive optional branches do not block execution.
Retranslation remains available through TranslationCommit → TextAccumulator →
TextToDOM. Errors with an omitted error wire still create a generic failure row,
with no stale successful text.

Initial implementation validation (before the review correction below):

- `npm test`: 546 unit tests passed, including actual DOM cloning/ownership with
  LinkeDOM, typed validation, grouped delivery, production scheduler integration,
  exact repeated/empty text, cancellation, summary graphs and reviewed recovery.
- Chromium and WebKit: 10 browser tests passed across `dom-display.spec.js`,
  `text-display.spec.js`, and `text-contracts.spec.js`. They check actual cell
  geometry and computed hover/focus styles, literal text, whitespace and fan-out.
  Run with `ASR_BASE_URL=http://127.0.0.1:8138 npx playwright test
  tests/browser/dom-display.spec.js tests/browser/text-display.spec.js
  tests/browser/text-contracts.spec.js` and a local server serving `web/` on 8138.
- Packaged MV3 fixtures: 189 distinct deterministic cases passed across the broad
  run and focused correction reruns. The broad run initially reported 158 passes,
  16 opt-in skips and 30 failures; 29 failures were corrected fixture assumptions
  or test setup and then passed in focused reruns. Two additional new UI cases
  passed as well. The remaining real-worker failure is the missing-asset check
  described below. Packaged fixtures exercise the production graph/editor/session/rendering
  modules and production scheduler with controlled inference Workers. Coverage
  includes default transcription, repeated pairs, empty translations, failure
  rows, hover/focus, stale Cancel results, new sessions, summary snapshots,
  clipboard output, v10 review/blocking, original recovery, responsive layout,
  typed editor wiring, fields, concurrent branches and model preparation.
- Final focused reruns: 23 field/capture cases passed together, the remaining
  translated-field case passed after updating its empty-table assertion, and all
  10 selected display/editor/capture cases passed across the focused run and its
  one palette correction rerun. Commands used:

  ```sh
  npx playwright test --config playwright.extension.config.js tests/extension/targets.spec.js
  UPDATE_DOM_SCREENSHOT=1 npx playwright test --config playwright.extension.config.js tests/extension/live-text.spec.js tests/extension/graph-interactions.spec.js tests/extension/extension.spec.js tests/extension/translategemma.spec.js --grep 'loadable MV3|0.5 zoom|native touch|MV3 literal snapshot|committed translation pairs|v10 TEXT display|editor adds|summary TEXT snapshots|palette, Save and reload'
  npx playwright test --config playwright.extension.config.js tests/extension/targets.spec.js tests/extension/translategemma.spec.js --grep 'completed translations flow|palette, Save and reload'
  ```

- JavaScript syntax and `git diff --check` passed.

[Paired display screenshot](graph-138-paired.png): the focused cell and its source
cell share one highlight; repeated identical sources remain separate rows. Error
markup is literal text. The screenshot uses deterministic inference, not model
accuracy evidence.

Environment limitations:

`npm run build:extension` stops with “Missing local models. Run npm run
prepare:assets first.” This worktree has no prepared model/runtime assets. No real
model inference result is claimed. The unconditional real ReazonSpeech/Silero
initialization test likewise cannot load `web/vendor/sherpa-ja-en/sherpa-onnx-vad.js`.
Opt-in hardware/model smoke tests were not enabled. These asset-dependent checks
remain unverified; production model loading and inference code were not changed.

For deterministic MV3 tests, a **source-only fixture package** was staged under
ignored `dist/chrome-extension`: copy `extension/`, copy its manifest to the package
root, and copy exactly `SHARED_FILES` from `scripts/build-extension.py` into `web/`.
A `FIXTURE-ONLY.txt` marker identifies it. Existing extension fixtures replace
heavyweight Workers or inference backends and use tiny integrity-checked model
fixtures. This exercises packaged code/CSP/interaction without representing a
successful production asset build. Run the normal production build with prepared
assets for a distributable extension.

## Review correction: producer-independent pairing

Removed producer allowlists, fixed upstream output names and provisional-wiring
inspection from current graph validation. The paired consumer checks all connected
inputs against delivery-local group provenance, including optional error inputs,
and rejects actual provisional deliveries. Provisional provenance follows the
receive context through async forwarding; primitive TEXT payloads are unchanged.

Validation after this correction:

- `npm test`: all 565 tests passed. Added coverage for alternate producers and
  output names, both edge orders, saveable incomplete drafts, editor connections,
  inactive optional branches, mismatched producers (including a separate error
  producer), separate emissions, success/empty/failure previews, independent
  fan-out, async provenance, Stop and Cancel.
- Chromium and WebKit: all 10 selected browser tests passed:
  `ASR_BASE_URL=http://127.0.0.1:64387 npx playwright test tests/browser/dom-display.spec.js tests/browser/text-display.spec.js tests/browser/text-contracts.spec.js --workers=2`,
  using a dedicated local server because the default port was occupied.
- Both focused source-fixture MV3 tests passed:
  `npx playwright test --config playwright.extension.config.js tests/extension/live-text.spec.js --grep 'committed translation pairs|editor adds both DOM processors'`.
  The ignored fixture package was staged from current source as described above;
  it is not a production asset build.
- `git diff --check` passed. `npm run build:extension` remains blocked by missing
  local models. Real-model and opt-in hardware checks were not run.
