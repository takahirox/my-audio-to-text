# Issue 205 publication continuation

Preserved implementation checkpoint: `2136099f6baf1ac593313d6842e0ae8910c18926`.
Integrated current main: `0ea2df5e5a7bae4ed9391d9c12d7479e17204530`.

The pipeline merge retains main's deferred async ownership, relay enforcement,
Stop draining and translation scheduler. Only the obsolete experiment's causal
tokens are removed. Newer feedback fixtures compare admitted source text with
committed output source and verify FIFO results, rather than removed tokens.
Model/runtime pins and unrelated functionality are unchanged.

Checks run on the combined implementation on 2026-11-04:

- `npm ci`: passed, zero reported vulnerabilities.
- `npm test`: 735 passed, zero skipped.
- `npx playwright test tests/browser/hold-feedback.spec.js tests/browser/translation-ports.spec.js tests/browser/text-window.spec.js --workers=2`: 22 passed across Chromium and WebKit.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-translation-feedback.spec.js`: 2 passed using a source-only MV3 package with native module Workers and controlled replies.
- `git diff --check`: passed.
- Reference audit: no removed-node/module or causal-token references remain in live source/tests/current docs. Historical evidence remains in `docs/evidence`.

[Earlier implementation evidence](translation-205.json) records 701 unit, 64
browser and 54 extension passes, extension build, preview reruns and saved-graph
rejection/recovery checks. Those results precede this main integration; the full
asset-backed build/extension suite was not repeated in this publication run.

No real-model inference was verified. The earlier real TranslateGemma WebGPU
smoke was skipped because `WINDOW_TRANSLATION_SMOKE` was not enabled. Current
checks use controlled inference and establish routing/lifecycle, not model quality.

This node publishes for review only. It does not merge or close Issue 205.
