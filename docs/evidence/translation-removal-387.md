# Translation removal validation (#387)

Validated locally on 2026-11-17 against upstream `b9d1508`.

## Scope

Removed both OPUS-MT node types, workers, model definitions, cache adapters,
manifests, review scripts, standalone pages, dedicated notices and tests.
No aliases, migration, graph repair or model substitution were added.
New/reset graphs contain Japanese Moonshine transcription only. Translation
examples explicitly compose supported nodes; the obsolete direction preference
and OPUS preparation injection are gone.

TranslateGemma in both directions, PLaMo, the shared scheduler/Worker protocol,
model cache, and pinned Transformers.js/ORT runtime staging remain. Generic
third-party runtime code and licenses are retained because supported models
still use those distributions. Playground summary/classifier cache loading
now uses a model-neutral adapter rather than importing the deleted OPUS cache.
Historical evidence remains under `docs/evidence/`; current examples use
`docs/examples/bilingual-history.json`.

## Passing checks

| Check | Result |
| --- | --- |
| `npm ci` | Passed; lockfile unchanged |
| `npm test` | 915 passed |
| `npm run prepare:playground-assets` | Passed; pinned weight-free runtimes/manifests staged |
| `npm run build:extension` | Passed; 219 inventory entries, zero model weights |
| `node --test tests/model-distribution.test.js` | Three passed: source/docs/CI references, Pages/extension assets, executable published example |
| Affected Chromium/WebKit suites | 224 passed, four skipped; 1.3 minutes |
| Affected MV3 suites | 51 passed; 1.4 minutes |
| Library required-model and responsive accordion checks | Two passed after updating shared-model expectations |
| MV3 default/reset, wide editor and Models layout checks | Three passed after updating manifest counts and preparation diagnostics |
| Changed Markdown relative links and `git diff --check` | Passed |

The browser selection comprised `translation`, `translation-ports`, `plamo`,
`playground-assets`, `model-playground`, `display-items`, `graph-port-order`,
`graph-quick-add`, `graph-ai-presentation` and `text-contracts` specs.
The MV3 selection comprised `translategemma`, `plamo`, `translation-ports`,
`graph-models`, `model-persistence`, `model-inspection`, `model-card-actions`,
`model-details`, `windowed-translation`, `item`, `graph-port-order` and
`graph-translation-feedback` specs. These exercise real page/Worker/cache
boundaries with small deterministic assets, including ID, preview, error,
language configuration, Stop/Cancel, integrity and cache sharing.

The distribution audit runs in both Pages and model-test CI. It excludes
historical evidence and third-party bundle internals from source-content
matching, but checks all staged Pages/extension filenames for retired assets
and model weights. The build separately checks the pinned runtime hashes.
No production model weights were intentionally downloaded or real inference
quality claimed; real-model smoke tests remain opt-in.

## Broader regression sweep and upstream comparison

The full browser run, before the final expectation/fixture corrections,
recorded 530 passed, 37 skipped and 21 failed. The affected failures (AI card
counts and the shared text-contract test's removed ASR constructor) were fixed
and pass in the final affected selection above. Remaining failures concern
validation-panel pointer interception, popup expectations, obsolete inspector
copy and WebKit zoom geometry.

The broader MV3 run recorded 283 passed, 15 skipped and 26 failed before it was
stopped, with one interrupted test and 149 not run. Five failures were stale
model labels/counts/preparation-message expectations, corrected and rerun above.
Other failures concern canvas interactions, concurrent capture, IfCondition
editing, TTS setup and the native-target fixture's disabled Start control.
The separate native translation-target probe also stops at that Start control.
Its translation assets now use tiny verified same-origin fixtures, and its
explicit graph retains ID-to-pair routing, avoiding production-weight requests.

Representative unchanged-upstream reproductions ran in an isolated worktree at
`b9d1508`: browser validation pointer/touch, popup, inspector-copy and WebKit zoom
failures; MV3 canvas and concurrent capture failures; IfCondition editing; both
TTS setup failures; and the native-target disabled-Start failure. This is not a
claim that the entire repository suite passes. No unrelated production behavior
was changed to address those failures.

## Post-merge verification

Pending for Pages publication only: verify the deployed revision, removed page
URLs no longer resolve, and TranslateGemma/PLaMo navigation and runtime URLs
work under the repository prefix. Local builds do not establish deployment.
No push, PR, comment, merge or deployment was performed by this implementation.
