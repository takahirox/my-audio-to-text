# Async translation and Hold feedback — Issue #207

Validated on 2026-11-04 in the implementation worktree with Node 26.12.1 and
Playwright 1.63.0 on macOS. All inference replies below are controlled; no real
WebGPU model execution or model quality/latency claim is made.

## Reproduction and diagnosis

Before changing production code, `node --test tests/translation-feedback.test.js`
failed all six initial regressions for TranslateGemma En→Ja and OPUS-MT En→Ja.
The graph uses the actual TextWindow, TextFormatter, Hold, MeetingSummaryNode
and TranslationSchedulerNode, with controlled summary/translation Workers:

```text
TextWindow → TextFormatter ← Hold ← MeetingSummary → Translation → output
                  └──────────────→ MeetingSummary
```

The first delayed translation result, followed by window B, produced:

```text
Node translator: Sampled work emitted after its receive promise completed.
Node formatter: Sampled work cannot reach translator.
```

Translation admission returned while inference was pending, so its captured
sampled context expired. The first error failed/aborted that scheduler; routing
the next summary into it then poisoned the formatter's sampled turn. Awaiting
translation inside receive would preserve its context but unnecessarily gate
summary feedback on the independent translation/display branch.

## Implementation and tradeoffs

- `context.defer()` acquires a node-owned work handle during receive. A job
  emits through `work.context` and retires it with `work.complete()`. Provenance,
  provisional flags and signal identity survive admission. Stop waits for owned
  jobs before closing the node; node abort retires handles and suppresses late
  emissions. Completed handles reject live late output. Worker cleanup remains
  the node's responsibility; a lost handle can stall Stop, interruptible by
  Cancel/dispose, just as a lost receive promise could.
- Sampled turns retain only branches structurally capable of storing required
  feedback, including nested obligations. Independent branches drain and fail
  separately. Their late output needs explicit ownership. No node names, TEXT
  contents or output names participate in this decision. Reachability across
  all emitting ports is conservative: any route back to required state retains
  the branch. Sampled consumers without feedback retain existing full tracking.
- Both translation schedulers use the same implementation, with per-job work
  ownership. Their bounded committed FIFO, preview replacement/clear, IDs,
  accepted context snapshots, grouped output families and failure diagnostics
  remain. Replaced pending previews and canceled/disposed jobs release handles.
- One #202 test previously expected an independent startup failure to prevent
  Hold storage. It now verifies both queued feedback updates complete while
  Stop still reports the independent failure. Other feedback failure, missing
  storage, timeout, nesting and FIFO checks remain in place.
- Graph serialization/version and typed ports are unchanged. Hold and
  MeetingSummary production implementations require no change.

## Checks run

| Check | Result |
| --- | --- |
| GitHub Issue #207 | Read through the GitHub connector; open, no comments. |
| `npm ci` | Passed, 43 packages; audit reported zero vulnerabilities. |
| `npm test` | **736 passed**, zero failed/skipped; includes all existing direct translation, feedback and graph validation tests. |
| Browser: Hold feedback, translation ports, TextWindow, TEXT contracts, Display items | **30 passed** across Chromium and WebKit. |
| MV3: `graph-translation-feedback.spec.js`, `graph-hold-feedback.spec.js` | **3 passed**. Native module Workers, production scheduler/runtime/summary nodes, extension CSP, existing editor Import/Save/Reload checks. |
| `git diff --check` | Passed. |
| `npm run build:extension` | Blocked: “Missing local models. Run npm run prepare:assets first.” |

New tests cover delayed single-window output; A/B/C with S2 and S3 generated
before T1 resolves; reversed edges; exact source/result/provenance association;
model/inference errors; count/character overload; preview replacement and final
priority; Stop and Cancel during Stop; cancellation/disposal and fresh runs;
explicit completion enforcement; and translation deliberately placed on the
feedback path, where waiting remains necessary. Existing tests exercise all four
translation directions, IDs, context snapshots, preview errors and Worker release.

The MV3 tests create/remove isolated source-only fixture packages. They exercise
real Worker messaging with controlled replies and require no prepared assets.
They do not establish that the complete model-bearing distribution builds.
Browser installation was initially absent; `npx playwright install chromium
webkit` resolved it. Port 8000 was already occupied, so browser checks used a
transient copy of the standard config with a Python web server and baseURL on
127.0.0.1:8007. That temporary config was removed afterward.

Reproduction commands (use the standard port when available):

```sh
npm ci
npm test
npx playwright test tests/browser/hold-feedback.spec.js tests/browser/translation-ports.spec.js tests/browser/text-window.spec.js tests/browser/text-contracts.spec.js tests/browser/display-items.spec.js --workers=2
npx playwright test --config playwright.extension.config.js tests/extension/graph-translation-feedback.spec.js tests/extension/graph-hold-feedback.spec.js
npm run build:extension
```

## Not exercised

Real TranslateGemma/OPUS-MT translation, real LFM2.5/Qwen3.5 summarization,
live ASR/microphone/tab capture, GPU memory/latency, and a complete distribution
with pinned model/runtime assets were not exercised. Prepare assets and run the
existing opt-in real-model suites before making claims about those cases.

## Review follow-up: independent branch descendants

The review found that a synchronous relay discarded the independent branch's
receive-lifetime requirement along with its feedback-turn membership. Before
the follow-up fix, the new one- and two-relay late-emission regressions failed:
an expired receive context emitted without an owned job and no error appeared.
The direct branch correctly rejected the same operation.

Pipeline now carries the receive-lifetime requirement on downstream deliveries
separately from the feedback turn. Descendants must await output or acquire
`context.defer()`, including after relays and owned emissions. The branch still
leaves the feedback FIFO. Regressions cover zero, one and two relays, both emit
APIs, expired-context rejection, and Stop waiting for every owned job while Hold
has already completed both summary updates.

Follow-up checks on 2026-11-04: `npm ci` passed; `npm test` passed **740 tests**;
the same five browser suites listed above passed **30 tests** across Chromium
and WebKit; the two MV3 suites passed **3 tests**; `git diff --check` passed.
Browser checks used `ASR_BASE_URL` with an ephemeral localhost Python server.
No real WebGPU models or complete model-bearing distribution were exercised in
this follow-up; the earlier asset-related build limitation still applies.
