# Live recording controls — Issue #225

The built-in recording toolbar now contains Start and Stop. The Cancel element,
click handler and disabled-state update are removed. Live's dedicated stylesheet
uses two equal grid columns, without an empty third slot. The shared dark
Graph/Models stylesheet is unchanged.

`TabSession.cancel()`, `Pipeline.cancel()`, Stop, error handling and the production
`pagehide` handler are unchanged. Stop still drains accepted work and keeps
finished output visible. Closing or navigating away from Live still cancels
immediately. No replacement force-stop control was added.

Graph Actions and Display tabs retain their contracts. The shared UI fixture
deliberately includes a user-defined Button named **Cancel**: it emits its held
text into the Notes tab and leaves the session running. Its caption is unrelated
to the removed built-in recording control.

## Layout evidence

| Viewport | Chromium browser UI | Source-packaged MV3 UI |
| --- | --- | --- |
| 1440 × 1000 | [Desktop](live-225-browser-1440x1000.png) | [Desktop](live-225-mv3-1440x1000.png) |
| 390 × 844 | [Narrow](live-225-browser-390x844.png) | [Narrow](live-225-mv3-390x844.png) |

Browser and MV3 checks also exercise 800 × 844 and 390 × 520. Assertions verify
exactly two ordinary recording buttons, no `#cancel-session`, equal widths,
aligned edges, no unused grid column or horizontal overflow, and targets at
least 44px high. Keyboard/touch tabs, independent scroll positions, literal
rendering, Graph Actions, recovery, Graph/Models navigation and palette isolation
remain covered. The desktop and narrow screenshots were also visually inspected.

## Lifecycle evidence

- Start/Stop/repeat exercises native Web Audio capture with worklet and fallback
  processing, final transcription, retained output and worker/audio cleanup.
- Stop during model loading requests no capture. Stop during pending capture
  setup permits replacement; a late grant cannot revive the old session.
- The delayed transcript fixture now observes the current
  `KeyedTextCoalesceNode.input1` path, rather than the retired TextAccumulator
  path. Stop waits for that delivery; teardown suppresses held delivery and
  retains already displayed content.
- A pending summary completes during Stop and remains visible after completion.
  A fresh session's `pagehide` instead terminates its pending summary Worker and
  preserves the last displayed snapshot in the still-observable test document.
- New actual navigation and window-close tests leave summarization permanently
  pending. A second same-origin page observes teardown evidence: all three
  Workers terminated, the capture track ended, the stream stopped once, and
  Pipeline disposal occurred without a graceful Stop/drain hook.
- Existing MV3 cases cover translation cancellation during loading, inference
  and Stop; capture errors; microphone cleanup; concurrent independent branches;
  speaker context closure; streaming speaker cancellation; and rejection of stale
  work after internal cancellation/restart. These use production lifecycle APIs
  or `pagehide`, with no built-in Cancel button.

## Executed checks

Dependencies were installed with `npm ci`, and the pinned Playwright Chromium
and WebKit browsers were installed. Browser tests used the repository's
`PagesHandler` on a dedicated loopback port, 8125, because port 8000 was occupied.

| Check | Result |
| --- | --- |
| `npm test` | **785 passed** |
| `ASR_BASE_URL=http://127.0.0.1:8125 npx playwright test tests/browser/live-ui.spec.js tests/browser/display-tabs.spec.js tests/browser/live-scroll.spec.js tests/browser/display-items.spec.js tests/browser/extension-layout.spec.js --workers=2` | **82 passed**, Chromium and WebKit |
| `npx playwright test --config playwright.extension.config.js tests/extension/live-ui.spec.js tests/extension/live-text.spec.js tests/extension/graph-model-failures.spec.js tests/extension/extension.spec.js tests/extension/graph-speaker.spec.js tests/extension/graph-actions.spec.js --grep-invert 'real pinned'` | Initial run: **37 passed, 4 failed**; all four corrected and passed in the lifecycle rerun below |
| `npx playwright test --config playwright.extension.config.js tests/extension/extension.spec.js tests/extension/live-text.spec.js --grep-invert 'real pinned'` | Final lifecycle run: **26 passed** |
| `npx playwright test --config playwright.extension.config.js tests/extension/display-tabs.spec.js tests/extension/simple-layout.spec.js tests/extension/item.spec.js tests/extension/graph-number.spec.js tests/extension/graph-whisper.spec.js tests/extension/graph-zipformer.spec.js tests/extension/graph-concurrent.spec.js tests/extension/graph-if-condition.spec.js tests/extension/targets.spec.js tests/extension/translation.spec.js tests/extension/graph.spec.js` | **78 passed, 5 failed**; ITEM cancellation corrected and passed below; four upstream failures remain |
| `npx playwright test --config playwright.extension.config.js tests/extension/item.spec.js tests/extension/streaming-tts.spec.js --grep 'portable ITEM\|controlled qwen3-tts'` | **2 passed** |
| Four failing cases rerun with upstream recorder HTML/JS and Live CSS | **Same four failures**, detailed below |
| `node --check` for changed JavaScript; `git diff --check` | Passed |
| Test discovery for changed concurrent-ASR, text-summary and streaming-TTS smoke suites | Passed; discovery does not execute real inference |
| `npm run build:extension` | Blocked: **Missing local models. Run npm run prepare:assets first.** |

Across final executions, **121 distinct MV3 cases passed** and four existing
assertions remain failing. Counts exclude duplicate runs. During implementation,
the four initial lifecycle failures were corrected by updating the retired sink
fixture and matching the actual lowercase summary status. The ITEM test keeps
direct internal cancellation because its deliberately held translation cannot
finish through Stop; its corrected rerun passed.

## Existing failures and limits

The following fail at identical assertions after restoring `recorder.html`,
`recorder.js` and `live.css` from upstream checkpoint
`2959da1e71f4ff26a757e1aff16d20ecc88d50f7` in the staged package:

1. Zipformer palette/routes: expects two output ports; the current node has four.
2. Three-screen screenshots: expects the removed `Input 1` heading.
3. Toolbar TEXT target: expects newline-separated text; the current direct TEXT
   display concatenates the literal values.
4. Translation TEXT fan-out: expects `tbody` in a direct TEXT display.

The Issue #225 sources were restored after this comparison. No graph contracts,
Display behavior or unrelated expectations were changed to address those failures.

This checkout has no prepared heavyweight model/runtime assets. As for #223,
deterministic MV3 tests staged production extension sources, manifest,
builder-listed shared Web modules and licenses in the builder's directory layout;
the existing fixtures supplied controlled workers/runtimes. This verifies the
source-packaged MV3 UI and lifecycle, not a complete production asset build or
real ASR/translation/summary/TTS inference. Real-model smoke tests were not run.
No deployment or post-merge publication verification applies to this local
extension UI change. Nothing was pushed, published or commented on GitHub.
