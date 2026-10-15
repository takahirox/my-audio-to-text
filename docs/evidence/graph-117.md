# Issue #117 validation

Validated on 2026-10-16 with Playwright 1.63.0 and Chromium 153.0.8010.12.

## Behavior

- Graph Editor labels the reusable Node **Paired text formatter** and has no
  Translation preset controls. Concrete translator Nodes and their wiring remain.
- Successful valid Save persists the graph before optional asset preparation.
  The preparation follows all saved OPUS-MT/Supertonic3/Kokoro Nodes, including
  parked Nodes, deduplicating directions and voices. Supertonic languages share
  weights. Packaged ASR models are excluded. No graph routes/settings are rewritten.
- Per-model checking/download/verified Ready, Error and Canceled states, byte
  progress, retry and cache checking are in Graph Editor. Models remains the
  recovery/diagnostics/delete interface. Download failures do not undo Save.
- Preparation uses the existing pinned manifests and ModelAssetCache, including
  streamed integrity checks, shared-file reuse and cross-page Web Locks. A newer
  Save, an external graph change or page teardown cancels obsolete preparation.
  Start/inference remain cache-only; Save starts no capture or inference Workers.

## Checks

The worktree initially lacked prepared assets. Ran `npm ci`, then the existing
`prepare:assets`, `prepare:translation-assets`, `prepare:whisper-assets`,
`prepare:tts-assets` and `prepare:zipformer-assets` scripts. The final
`npm run build:extension` passed with those pinned assets.

`npm test`: **336 passed**.

Packaged MV3 UI checks covered **103 distinct passing tests** across these files:

```sh
npm run test:extension -- \
  tests/extension/graph-models.spec.js \
  tests/extension/graph.spec.js \
  tests/extension/graph-interactions.spec.js \
  tests/extension/layout.spec.js \
  tests/extension/live-text.spec.js \
  tests/extension/model-cache.spec.js \
  tests/extension/translation.spec.js \
  tests/extension/graph-concurrent.spec.js \
  tests/extension/graph-number.spec.js \
  tests/extension/graph-whisper.spec.js \
  tests/extension/graph-zipformer.spec.js
```

These were run in batches. The initial 83-test batch passed 81 tests; two new
test assertions were corrected (canvas headings include Node IDs, and invalid
numeric input must use the browser's empty-value path). The subsequent 27-test
batch passed completely. After adding external-save cancellation, rebuilt and
reran all Graph Editor Save/model tests and `graph.spec.js`: **21 passed**.
The unit suite was also rerun successfully after that change.

The new Save tests exercise English-to-Japanese without the opposite direction,
multiple voices/shared weights, parked Nodes, no optional-model requests on
load or unsuccessful Save, persistence before fetching, cache reuse, corruption,
missing/short/failed files, retry, byte progress, cancellation, newer Save,
external Save/conflict preservation, and closing the editor followed by Models
recovery. Existing tests cover legacy migrations, v8 graphs, immutable active
sessions, concurrent paths and packaged ASR behavior.

Inference/model bytes in these UI scenarios are deterministic fixtures; the
production cache, graph/editor/page code, CSP, Cache Storage, streaming hashes,
Web Locks and Worker protocols are exercised. No real optional-model weight
download/inference smoke, full unrelated browser suite, manual recording check
or screenshot refresh was run. No post-merge verification is required by the issue.
