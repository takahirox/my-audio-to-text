# Issue #186 validation

Implemented optional atomic NUMBER IDs on ASR, translation and paired DOM
formatting, plus generic `KeyedDOMAccumulator` history. The [wiring
contract](../keyed-dom-history.md) documents the concrete graph and precedence.
No default graph rewiring, graph version bump, translation prompt/model changes,
new Settings or timers are included.

## Deterministic coverage

- `npm test`: **857 passed**. Includes production graph construction with both
  OPUS-MT directions, both TranslateGemma directions, direct ASR and final-only
  Whisper. Covers interleaved producer IDs, identical utterances, empty values,
  FIFO IDs, error/communication failure IDs, retained source, independent preview
  families, Cancel and late replies, Start reset, ownership, malformed grouping,
  save/reload/recovery and half-wired optional branches.
- New branch tests hold preview/final formatter work independently, including a
  translation that completes first. Lower-precedence late work cannot replace a
  higher-precedence row. A held final branch keeps the previous preview visible
  through the simultaneous ID-bearing final/preview-clear delivery.
- Chromium and WebKit: `dom-display`, `keyed-dom`, `text-display`,
  `text-contracts`, `translation-ports`, and `translation` browser specs exercised
  native DOM, module Workers, grouped/independent delivery, display continuity,
  duplicate rows, errors, Stop and storage recovery. The initial matrix passed
  66 cases and found eight stale migration expectations for version 14. Those
  fixture expectations now use `GRAPH_VERSION` (already 15 before this change).
  The focused `translation-ports` + `keyed-dom` recheck passed **20/20**.
- MV3: `keyed-dom`, `live-text`, `translation-ports`, `translategemma`,
  `windowed-translation`, `graph-whisper`, and `graph-concurrent` specs exercised
  packaged imports, real extension pages/Workers, saved graphs, UI, migration,
  diagnostics, concurrency and lifecycle. The initial matrix passed 56 cases;
  the ten failures were stale version expectations or port-count expectations
  needing the new Whisper `finalId`. All passed in the **15/15** focused recheck.
  The final keyed MV3 suite passed **2/2**, including an unconnected translator
  branch, duplicate direct transcripts, Stop, Cancel and restart.
- `git diff --check`: passed.

## Environment and limits

MV3 checks used a fixture-only package assembled from the production extension
files and the builder's `SHARED_FILES`, then the existing test fixtures supplied
deterministic inference Workers/runtime modules. Native Chromium MV3 loading and
actual Worker boundaries ran. The normal unit suite also tests the production
packaging script with pinned asset fixtures.

`npm run build:extension` was attempted and stopped at its expected guard:
`Missing local models. Run npm run prepare:assets first.` This worktree has no
prepared model assets. A complete model-bearing build and real-model inference
smokes were not performed; inference implementations and prompts are unchanged.
No deployment, push, PR, merge or GitHub comment was performed. Publication
verification, if this change is later deployed, remains pending after merge.
