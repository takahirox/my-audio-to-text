# Pure Live snapshots and reusable TextAccumulator (#132)

Historical evidence; producer restrictions and cancellation/startup behavior are superseded by the [Issue #134 audit](composition-134.md).

LiveTextDisplay now accepts only `content: TEXT`. TextAccumulator owns newline-
separated committed segments and the optional preview tail; every accepted update
emits a whole TEXT snapshot. Direct Text/formatter/summary snapshots need no stateful
intermediate Node. No model, model asset or generic Pipeline code was changed.

## Compatibility and visible behavior

Graph v10 inserts one accumulator for each v9 display with append wiring, maps
replace to preview on that processor, and connects text to content. Replace-only
and disconnected display drafts keep their settings and connect directly when wired.
Original Node IDs, positions, language/labels, independent branches and producer
fan-out survive. Versions 1–8 still use their existing translation review/recovery
workflow before v10 migration. Exact original JSON is retained before writing the
new graph; existing v9 and v10 recovery copies are never overwritten. Graph Editor
can select earlier recovery copies, including numbered copies from later imports.

Migrated accumulators retain `legacyDisplay: true` metadata through Save/reload.
When the saved append source is an inactive draft, the executable processor keeps
the latest replacement on Stop/Cancel, matching the old replace-only lifecycle.
The saved draft route remains intact; completing that branch enables normal
append/preview cleanup on the next session. New preview-only accumulators still
clear their uncommitted tail. Unit tests cover both lifecycle operations, recovery,
reload and draft activation; an MV3 regression exercises the real Live controls.

Committed segments preserve empty values, whitespace, order and duplicate strings.
Grouped append takes precedence over preview. Stop clears an uncommitted tail and
drains the resulting committed snapshot. Cancel publishes no processor work; the
session restores directly connected views to committed text. Indirect consumers
retain their last accepted snapshot. Fresh sessions begin empty. Source final-ID
filtering remains upstream, and TTS/focused-field/translator fan-out continues to
receive original segments unless the user explicitly connects growing snapshots.

The visible surface is one scrollable plain-text region. Old row borders and the
separate dashed Preview block are replaced by newline boundaries in the snapshot.
Labels/language remain per display; literal HTML-looking input is never executed.
Incremental suffix edits keep unchanged text nodes, selection and reader scroll.
Unicode surrogate pairs stay together at the 4,096-code-unit DOM chunk boundary.
Copy text copies exactly the snapshot, without rendering labels or added row marks.

## Validation

- `npm test`: 514 passed, including migration/recovery, empty/duplicate/whitespace
  values, grouped and independent delivery, Stop/Cancel/fresh sessions, generic
  formatter fan-out, summary snapshots, translation revisions, TTS and focused text.
- All changed JavaScript parses with `node --check`; `git diff --check` is clean.
- Chromium browser regressions: nine passed across `text-display`, `text-contracts`
  and `extension-layout` (using `ASR_BASE_URL` for an isolated local source server).
- Focused MV3 suite: 13 passed (ten Live regressions, two native capture regressions
  and the real packaged ReazonSpeech/Silero baseline), including v5 displays with
  prototype-named IDs, literal snapshots, repeated translation, immutable active labels, long
  selection/scroll, fresh sessions, palette Save/reload/profile restart, v9 migration
  and selection of earlier recovery copies, and the inactive append draft lifecycle.
- Earlier review baseline: 170 distinct model-free MV3 cases passed across the
  broad source-fixture run and corrected fixture rerun; 16 opt-in real-model cases
  were skipped. The broader suite was not repeated after this lifecycle fix.

The focused revision command was `playwright test --config
playwright.extension.config.js tests/extension/live-text.spec.js
tests/extension/extension.spec.js --grep 'MV3|packaged extension initializes the real pinned'`.

`npm run build:extension`: **passed** for the revised source, with the normal
production builder and all its pinned runtime/model checks. Existing local prepared
ASR/translation/optional-ASR/TTS assets were copied into ignored asset directories.
The missing meeting-summary runtime was prepared from existing npm cache archives;
`prepare:meeting-summary-assets` verified both archive and extracted-file pins.
ReazonSpeech/Silero assets were independently reconstructed from the existing
checksum-verified runtime archive and pinned model cache, then compared byte for
byte with every packaged source file. No new assets or browsers were downloaded.

The installed Playwright package expected Chromium build 1243; this host already
had build 1248. Tests used an isolated temporary browser-path alias to that cached
Chromium. The real packaged baseline loaded the unmodified production build under
MV3 CSP, initialized both pinned Workers, checked the ReazonSpeech configuration,
and drained Stop successfully. This establishes packaging/initialization, not
speech accuracy. Other MV3 tests copied that build into isolated fixtures with
controlled model Workers/runtimes and synthetic cache data. Opt-in real
ASR/translation/summary/TTS inference checks and WebKit were not run in this
revision. No deployment-only verification is required.

## Resource measurements and limits

The correctness test retains 20,000 commits of 100 characters each, totaling
2,019,999 UTF-16 units with separators. The last full unit run measured 14.5 ms for
snapshot construction; earlier runs ranged up to 48.3 ms. The MV3 renderer test
performed 2,000 updates ending at 26,000 characters in 102.9 ms in the final
focused run (earlier runs ranged from 67.4 to 112.9 ms). These are local observations, not timing
thresholds: construction excludes consumer flattening/serialization, and the DOM
measurement excludes forced browser layout.

One committed string and segment count avoid item-array copies. Prefix sharing is
engine-dependent. Full TEXT inspection, serialization and layout cost O(total text),
so processing every growing snapshot can cost O(n²) over a session. The UI bounds
region height and DOM text-node size and updates only the changed suffix; prefix
comparison and text layout still scale. There is no silent truncation, transcript
cap or disk backing. Memory and JavaScript/browser string limits remain real limits.
