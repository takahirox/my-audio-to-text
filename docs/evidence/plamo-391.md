# PLaMo multilingual and GGUF auto-switch evidence (#391)

Validated on 2026-11-17 on Apple M4 Max, 64 GiB RAM, macOS 27.2.1 arm64.
Exact inputs, outputs, per-run load/inference timings, browser capabilities and
hashes are in [the measurement record](plamo-391.json). These are real model
outputs, with no ASR dependency or inference fixture.

The packaged MV3 extension passed in Chromium 153.0.8010.12 (isolated, secure,
JSPI enabled); the standalone Playground passed in Chrome 157.0.8103.52 (secure,
JSPI enabled). Both use the production Wllama 3.13.0 CPU WASM runtime, one thread,
no GPU layers, 2,048-token context, deterministic decoding and 256 output tokens.
Inference remains local. One official Q4_K_M download was reused via a static
loopback byte server; the test-only delivery URL preserves the production hashes
and immutable browser cache key. No model weights enter the extension or Pages.

## Real translations

Both environments passed all ten cases and returned the same strings. Empty
source/target entries below mean genuinely unconnected graph ports and omitted
Playground fields. Extension model initialization took 4.07–4.30 seconds per job,
and translation/drain took 4.85–7.56 seconds. Standalone loading took 8.46 seconds
on its first local-byte/cache preparation, then 4.98–5.79 seconds per fresh Worker;
translation/drain took 4.17–6.62 seconds. Some runs overlapped across browsers, so
use these as functional smoke measurements, not isolated performance benchmarks.

| Source | Target | Exact generated string |
| --- | --- | --- |
| (omitted) | (omitted) | The meeting has been rescheduled for next Monday. |
| (omitted) | (omitted) | 今日はいい天気だ。 |
| auto | auto | 今日はいい天気だ。 |
| (omitted) | en | The meeting has been rescheduled for next Monday. |
| en | ja | 今日はいい天気だ。 |
| fr | ja | 会議は来週の月曜日に行われます。 |
| ko | en | The meeting will be held next Monday. |
| zh-hans | ja | 会議は来週の月曜日に開かれます。 |
| zh-hant | ja | 会議は来週の月曜日に開かれます。 |
| auto | ja | プロジェクトダッシュボードを開いてください。 |

The standalone smoke also canceled actual inference, confirmed that no model
Workers remained, and successfully retried with a fresh Worker from verified
cache. Requests were GET-only, contained no source text and did not fetch model
bytes again on subsequent jobs. The extension drained and disposed each graph.

## Template, model and regression checks

- The pinned revision remains `4f672106b847200bfdc0f6af6c321cd94eba1aed`.
- Review verified all 1,807,203,040 bytes, the whole-file SHA-256, every manifest
  chunk, both official licenses and the official template. A metadata-only GGUF
  read confirms its embedded `tokenizer.chat_template` exactly matches the
  committed template, including the November 8 auto-switch behavior.
- The direct PFML3 builder matches independent Jinja2-rendered fixtures for
  omitted/auto target, explicit targets, source omission and multilingual inputs.
  A digest also compares all 53 codes as both source and target. Auto mode has
  input `lang=ja/en`, no output `lang`, and no app-side language detection.
- `npm test`: 936 passed, including grouped delivery, queued language snapshots,
  preview/ID/error routing, Stop/Cancel, graph contracts and distribution audits.
- Deterministic PLaMo browser suite: 4 passed. PLaMo extension and Models details:
  4 passed. Exact palette/canvas function and model subtitle checks also passed.
- Extension build: 219 verified files, zero model weights. Artifact audit now
  seeds stale GGUF files in the PLaMo vendor directory and checks exclusion.
- `npm ci` audit: zero vulnerabilities.

The first default Playwright launch found no browser for its pinned build. The
browser fixtures then passed using installed Chrome; the pinned Playwright
Chromium was installed for extension validation. No model/runtime pin changed.

## Reproduction

```sh
npm run setup:extension
python3 scripts/review-plamo-assets.py
npm test
TRANSLATION_CHANNEL=chrome npx playwright test tests/browser/plamo.spec.js --project=chromium --workers=1
npx playwright test --config playwright.extension.config.js tests/extension/plamo.spec.js tests/extension/model-details.spec.js
PLAMO_EXTENSION_SMOKE=1 npx playwright test --config playwright.extension.config.js tests/extension/plamo-smoke.spec.js
PLAMO_SMOKE_GGUF=.cache/plamo-review/plamo-3-translate-2b-Q4_K_M.gguf npm run test:plamo-real
```

All 53 codes are validated deterministically; this smoke samples the languages
above rather than measuring translation quality across all pairs. For non-Japanese
and non-English input, omitted/auto target has undefined output language and is
not claimed as supported switching behavior. Specify a concrete target.
