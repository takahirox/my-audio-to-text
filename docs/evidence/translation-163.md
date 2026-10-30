# Separate committed and provisional translation outputs (#163)

All four extension translators now expose two atomic TEXT families:
source/text/error for committed input and
provisionalSource/provisionalText/provisionalError for provisional input. Both
TranslateGemma directions and both OPUS-MT directions use the same scheduler
contract; preserving mixed OPUS outputs would require a second adapter contract
and duplicate preview routing. Standalone web translation Nodes are unchanged.
Each extension Node still owns exactly one translation Worker/model runtime.

Committed FIFO, committed priority, one latest pending preview, the existing
queue/character limits, stale-preview suppression and request-ID isolation are
preserved. Final acceptance immediately clears the explicit preview family,
without waiting for obsolete inference. Stop clears previews and drains finals;
Cancel sends an empty preview cleanup group and invalidates late completions.
Bare dispose publishes nothing. Empty/whitespace input preserves its source and
returns empty translated text without inference. Failed groups omit translated
text within their own family and retain existing translation diagnostics.

Pipeline snapshots a Node's optional outputGroups declaration so omission clears
only siblings in the emitted atomic family. Other producers keep their existing
single-family behavior. Generic formatters, PairedTextToDOM, accumulators,
DOMCombiner and displays have no translator-specific rules. Committed text feeds
history/fields/TTS directly. Preview text takes an explicit replacement display
branch, including empty clears. No new Node, data type, Worker/model manager or
accumulator preview state was introduced.

TranslationCommit no longer routes unclosed results as previews. It retains
causal delivery, exact-source and FIFO boundary verification, failure-source
fallback and unresolved-boundary errors. Its existing provisional output emits
only empty boundary/final clears for compatibility. The revisable-window fixture
routes translator.provisionalText directly to its own TextToDOM/display, while
committed results retain causal window checks and append-only history routing.

Graph v14 requires review for older graphs with any provisional translator input
or TranslationCommit Node, including inactive drafts and graphs already saved at
v13. The translation repair draft retains every Node, setting and route; it never
guesses preview wiring. Older accumulator preview routes also receive the v13
append-only conversion and its lifecycle warning in the same reviewed draft. Older
DOM/paired-port migrations retain their existing review paths and add the new
warning where applicable. Committed-only graphs without TranslationCommit
upgrade without route changes. Save preserves original JSON bytes under
processing-graph-before-v14, numbered on collision, with older copies retained.
Read/execute blocking, deliberate route repair, Save/reload, storage-write failure,
CRLF Copy/Download integrity and older recovery copies are covered.

Validation before integration with #165 on 2026-10-30:

- `npm test`: 678 passed, none skipped. Includes both translation directions and
  relevant OPUS users, atomic success/empty/failure groups, diagnostic reporting,
  shared-formatter omission scope, slow/out-of-order/duplicate replies, priority,
  coalescing, queue bounds, Stop, Cancel during preparation/load/inference, fresh
  sessions, causal commits and graph recovery.
- `npx playwright test tests/browser/translation-ports.spec.js tests/browser/translation-preset.spec.js tests/browser/text-window.spec.js tests/browser/dom-display.spec.js tests/browser/extension-layout.spec.js --grep-invert 'live regions render safe snapshots' --workers=2`:
  86 passed across Chromium and WebKit. Direct ports use real module Workers with
  controlled inference. Includes exact recovery export, reviewed Save/reload,
  one Worker per translator, separate preview clearing and committed history.
  The excluded pre-existing renderer test supplies strings to a DOM-only API;
  it was already documented as failing by #160 and remains outside this change.
- `npx playwright test --config playwright.extension.config.js tests/extension/translation-ports.spec.js tests/extension/graph.spec.js tests/extension/live-text.spec.js tests/extension/translation.spec.js tests/extension/graph-interactions.spec.js`:
  99 passed. Covers older migrations, recovery controls, direct composition,
  optional preview routing, cache/inference errors and lifecycle isolation.
- Final focused MV3 run after the migration audit:
  `npx playwright test --config playwright.extension.config.js tests/extension/translation-ports.spec.js tests/extension/windowed-translation.spec.js tests/extension/primitive-composition.spec.js tests/extension/translategemma.spec.js`:
  31 passed (8 overlap with the broader run). Production graph/runtime,
  scheduler, Pipeline, Worker protocol, editor and DOM Nodes execute; model
  inference and model assets are deterministic fixtures.
- `git diff --check`: passed.

`npm run build:extension` stops with “Missing local models. Run npm run
prepare:assets first.” Prepared production ASR/runtime/model assets are absent.
MV3 checks use an ignored source-layout package in dist/chrome-extension marked
FIXTURE-ONLY.txt: extension/, its root manifest, and the builder's SHARED_FILES
under web/. This is not a verified production build. Real OPUS-MT/TranslateGemma
inference and GPU/model quality are unverified; deterministic checks establish
contracts, ownership, routing and lifecycle only. The opt-in real windowed-model
smoke was updated to observe the separate preview display but was not run.

Required post-merge verification: none specified by #163.


## Integration with main's v13 accumulator migration (#165)

Local history was rebased onto b2202a39f80b0705df334ea670431c0a72a37c2a.
The accumulator review remains v13; translation output review is v14. Saved v13
preview-enabled graphs are blocked for deliberate repair, while committed-only
v13 graphs upgrade without route changes. Older graphs needing both migrations
receive both warnings and a combined repair draft. Current recovery copies use
processing-graph-before-v14; existing v13 and earlier copies remain intact.
TranslationCommit retains input-failure and lifecycle cleanup, and Pipeline
retains ordered cancellation cleanup through generic consumers.

Validation after integration on 2026-10-30:

- `npm test`: 723 passed. Includes v12/v13 translation review for all four
  translators, combined accumulator/translator migration, recovery collisions,
  exact original bytes, Save/reload, backup-write failure, composition and lifecycle.
- Browser suite: 98 passed across Chromium and WebKit, running
  `translation-ports.spec.js`, `text-window.spec.js`, `text-display.spec.js`,
  `dom-display.spec.js`, `extension-layout.spec.js` and `speaker.spec.js` with
  `--workers=2`. An isolated local server used the existing PagesHandler and
  ASR_BASE_URL on a free port. No tests were excluded.
- Packaged MV3 fixture suite: 81 passed, running `translation-ports.spec.js`,
  `windowed-translation.spec.js`, `primitive-composition.spec.js`,
  `translategemma.spec.js`, `live-text.spec.js`, `graph-models.spec.js` and
  `graph.spec.js` with `playwright.extension.config.js`. Includes reviewed v13
  repair and old recovery copies, append-only accumulator migration, direct
  preview routing, optional retranslation, Stop/Cancel and restart.
- `git diff --check`: passed. Main is an ancestor of the reconciled local history.

`npm run build:extension` still stops at missing local models. MV3 tests used a
fresh source-layout fixture package with the current builder's shared source
list, explicitly marked FIXTURE-ONLY.txt. Production packaging and real model
inference remain unverified; no production assets were downloaded.
