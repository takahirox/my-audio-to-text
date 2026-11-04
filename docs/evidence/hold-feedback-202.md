# Hold feedback validation — Issue #202

Validated on 2026-11-04 in the assigned implementation worktree, using Node
26.12.1 and Playwright 1.63.0 on macOS. No real-model inference is claimed below.

## Implemented behavior

- Hold stores ordinary TEXT without emitting. Pipeline samples readable outputs
  with an ordinary consumer delivery; only emitting routes participate in DAG
  validation. Primitive compatibility and edge JSON are unchanged.
- A sampled consumer serializes its delivery and all causally forwarded awaited
  work before reading state for its next input. Feedback must be stored by that
  work; string equality and unrelated TEXT cannot release the queue. Async hooks
  must return their completion promise and retain their receive context.
- Waiting is capped at 32 active/queued deliveries and 32,768 ordinary-input
  characters per sampled consumer, with a four-minute update deadline. Overflow,
  failure, missing completion and timeout visibly stop the branch. Stop flushes
  and drains; Cancel/disposal abort and discard waiting work; fresh Start clears.
- MeetingSummary has no private note, batching timer or excerpt reconciliation.
  Each nonempty accepted formatted input makes one request/generation and emits
  one successful result, including unchanged text. Input/token/output budgets,
  conservative grounding, cache-only local inference and Worker cleanup remain.
- Graph Help, runtime/port docs and a six-node importable example are included.
  Existing direct summary graphs still load but now summarize each input
  independently; the documented explicit composition supplies prior history.

## Actual checks

| Check | Result |
| --- | --- |
| `npm ci` | Passed; 43 packages installed, audit found zero vulnerabilities. |
| `npm test` | **698 passed**, zero failed/skipped; about 0.8 seconds. |
| Chromium: `hold-feedback`, `text-window`, `text-contracts`, `display-items` browser specs | **6 passed**. |
| WebKit: `hold-feedback` browser spec | **1 passed**. |
| MV3: `graph-hold-feedback.spec.js` | **1 passed** in a source-only fixture extension with controlled Worker replies. |
| MV3: `graph-model-failures`, `graph-meeting-summary`, `live-text` specs | **12 passed** using fixture-packaged source and controlled model/capture assets. |
| `git diff --check` | Passed. |
| `npm run build:extension` | **Blocked by absent prepared assets**: “Missing local models. Run npm run prepare:assets first.” No successful complete distribution build is claimed. |

The new tests cover empty initial state; independent source order and grouped
updates; exactly one format per window; A/B/C races; unchanged output; unrelated
and detached output; explicit and missing-result failure; count/character limits;
timed-out work; Stop tails/drain; Cancel/dispose/restart; mixed ordinary cycles
and sampled boundaries; nested sampling; primitive type rejection; import and
save/reload. Tests use production Display and preserve its session signal
identity. MV3 tests exercise real extension CSP and Worker messaging, without
substituting Pipeline, Hold, formatter or MeetingSummary node logic.

The existing MV3 fixture suites require `dist/chrome-extension`. For these
checks only, that ignored directory was staged from current `extension/`,
`web/` and `extension/manifest.json`, without model/vendor assets. The fixture
suites replace model/capture code and manifests themselves. This staging is
not the production build. The new feedback MV3 test creates and removes its own
isolated source-only fixture package and can run without `dist/`.

Reproduction commands:

```sh
npm test
npx playwright test tests/browser/hold-feedback.spec.js tests/browser/text-window.spec.js tests/browser/text-contracts.spec.js tests/browser/display-items.spec.js --project=chromium
npx playwright test tests/browser/hold-feedback.spec.js --project=webkit
npx playwright test --config playwright.extension.config.js tests/extension/graph-hold-feedback.spec.js
# After a real build, or explicitly staging the source-only fixture as above:
npx playwright test --config playwright.extension.config.js tests/extension/graph-model-failures.spec.js tests/extension/graph-meeting-summary.spec.js tests/extension/live-text.spec.js
```

## Unverified cases

The complete model-bearing MV3 build, live microphone/tab ASR into this feedback
path, and real LFM2.5/Qwen3.5 output quality, latency, GPU/memory usage and new
prompt behavior were **not run**: this worktree has no prepared model/runtime
assets. The opt-in `graph-meeting-summary-smoke.spec.js` now uses the explicit
Hold/TextWindow/formatter graph for later offline real-model verification.
Prepare the pinned assets and run it separately before claiming factual/model
quality or a working complete packaged distribution. Historical #130 model
reports concern the retired reconciliation behavior and do not establish
accuracy of this prompt. No push, PR, merge, deployment or Issue comment occurred.
