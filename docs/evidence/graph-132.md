# Pure Live snapshots and reusable TextAccumulator (#132)

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

- `npm test`: 512 passed, including migration/recovery, empty/duplicate/whitespace
  values, grouped and independent delivery, Stop/Cancel/fresh sessions, generic
  formatter fan-out, summary snapshots, translation revisions, TTS and focused text.
- All changed JavaScript parses with `node --check`; `git diff --check` is clean.
- Chromium browser regressions: nine passed across `text-display`, `text-contracts`
  and `extension-layout` (using `ASR_BASE_URL` for an isolated local source server).
- Focused MV3 Live regressions: nine passed, including v5 prototype-named display
  IDs, literal snapshots, repeated translation, immutable active labels, long
  selection/scroll, fresh sessions, palette Save/reload/profile restart, v9 migration
  and selection of earlier recovery copies.
- Broader MV3 suite: 170 distinct model-free cases passed across the broad run
  and corrected fixture rerun; 16 opt-in real-model cases were skipped. The broad
  run recorded 155 passes and stopped after ten fixture failures involving removed
  ports or old row selectors, leaving six cases unrun. After correcting those
  fixtures, a targeted run passed 29 cases (the ten corrected cases, five remaining
  model-free cases and 14 overlapping regressions), with the remaining real-model
  case skipped. No production-code failures remain in these checks.

The broad command was `playwright test --config playwright.extension.config.js
--grep-invert 'packaged extension initializes the real pinned' --max-failures=10`.
The final rerun selected the affected layout, native concurrent capture, Gemma
palette, both OPUS-MT directions, saved-direction/cache, and windowed translation
cases from their existing suites. It finished with **29 passed, 1 skipped**.

The installed Playwright package expected Chromium build 1243; this host already
had build 1248. Tests used an isolated temporary browser-path alias to that cached
Chromium, without downloading a browser. The extension fixture package copied the
repository's extension/web sources to ignored `dist/chrome-extension`; production
model files were not fabricated. Existing test fixtures supplied controlled model
Workers/runtimes and synthetic cache data. These runs validate browser integration
and ownership/lifecycle, not real-model accuracy or production asset readiness.

`npm run build:extension` was attempted and stops at "Missing local models".
The standalone real pinned ReazonSpeech/Silero MV3 check was attempted and fails
because its vendor worker runtime is absent; it is excluded from the model-free
suite. Opt-in real ASR/translation/summary/TTS smoke checks and WebKit were not run
(the required local assets/browser are unavailable). No asset preparation/download
was performed. No deployment-only verification is required.

## Resource measurements and limits

The correctness test retains 20,000 commits of 100 characters each, totaling
2,019,999 UTF-16 units with separators. The last full unit run measured 18.2 ms for
snapshot construction; earlier runs ranged up to 48.3 ms. The MV3 renderer test
performed 2,000 updates ending at 26,000 characters in 105.5 ms on a concurrent
browser run (an earlier run was 67.4 ms). These are local observations, not timing
thresholds: construction excludes consumer flattening/serialization, and the DOM
measurement excludes forced browser layout.

One committed string and segment count avoid item-array copies. Prefix sharing is
engine-dependent. Full TEXT inspection, serialization and layout cost O(total text),
so processing every growing snapshot can cost O(n²) over a session. The UI bounds
region height and DOM text-node size and updates only the changed suffix; prefix
comparison and text layout still scale. There is no silent truncation, transcript
cap or disk backing. Memory and JavaScript/browser string limits remain real limits.
