# Correlated primitive outputs — Issue #95

`Pipeline.context.emitOutputs()` snapshots one named output map and appends one
queue item per receiving Node. Opt-in `receiveInputs()` receives the connected
primitive values together; ordinary `emit()` and `receive()` remain supported.
The runtime validates all output names before enqueueing, preserves publication
order, isolates fan-out branches, skips canceled/failed deliveries, and drains
groups on Stop. Separate processor branches are explicitly unsupported as joins.

TranslationScheduler emits successful text independently and groups primitive
source/status/error/final-index updates for the paired view. Pending and error
updates omit successful text. No `TEXT_RESULT` token or structured text payload
remains. Both directions preserve provisional invalidation, repeated identical
sources, ordered final delivery, errors, cancellation and graceful final drain.
Version 5 graphs expand version 4 paired routes, retain TEXT-only routes, and
preserve earlier field/extraction migrations. Invalid migration leaves saved
JSON untouched and exposes the existing Reset and Save recovery path.

The editor validates types, single incoming edges, required/optional inputs,
complete direct paired bundles and acyclicity. Its canvas now includes the actual
height of the expanded port cards. The public-contract audit justifies retaining
synthesized audio samples together with their rate/channel format; captured mono
16 kHz PCM remains a distinct contract.

Deterministic tests include consecutive identical source values, asynchronous
multi-input receivers, out-of-order background completions, immutable map
snapshots, fan-out, independent primitive consumers, invalid emissions, branch
errors, cancellation and source Stop tails. Both translation directions also test
a blocked paired consumer while the independent TEXT branch receives each final
once. Packaged MV3 tests cover default graphs and persisted paired/TEXT-only
version 4 routes in both directions, all four UI states, required/optional ports,
wire interactions, and the expanded canvas extent.

Validation on 2026-10-13:

| Command | Result |
| --- | --- |
| `npm test` | 274 passed; no failures or skips |
| `npm run test:browser -- --workers=2` | Chromium + WebKit: 218 passed, 18 optional checks skipped |
| `npm run build:extension` | Passed with checksum-pinned ASR, translation and TTS assets |
| `npm run test:extension -- tests/extension/graph-interactions.spec.js tests/extension/graph.spec.js` | 20 passed after correcting legacy wire-count and reload-fixture assumptions |
| `npm run test:extension` (final full suite) | 95 passed, 5 optional checks skipped; no failures |
| `git diff --check` | Passed |

The 18 browser skips are opt-in model/runtime smoke checks, speech-accuracy
checks and thread benchmarks (nine per engine). The five MV3 skips are two real
TTS graph checks, two real direction-specific translation end-to-end checks,
and one real ASR focused-field check. These optional checks were not enabled.
The mandatory packaged test initializing the unmodified pinned ASR/Silero
Workers under MV3 CSP did pass. Fixture inference checks do not claim new model
accuracy or physical-device performance. No human-only, deployed-site or
post-merge verification is required by this Issue.
