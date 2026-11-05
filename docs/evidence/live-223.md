# Live Concept A redesign — Issue #223

Live now has its own light stylesheet, a waveform header with Graph/Models
navigation, a lifecycle-derived session pill, one row of recording controls, a
graph-driven action band and a growing reading card. The original detailed
session message and Session details disclosure sit below the outputs. Target
controls, actionable notices, model recovery and generated audio remain available.
No graph, node, model or Display mapping contracts changed. The shared
`recorder.css` and `live-text-regions.js` are unchanged.

## Visual evidence

Screenshots use the model-free graph in `tests/fixtures/live-ui.js`. Japanese
and English text, input labels and button captions are fixture data delivered
through production graph nodes. The application adds no timestamps, model names
or elapsed timer.

| Viewport | Browser-served production UI | Unpacked MV3 UI |
| --- | --- | --- |
| Desktop, 1440 × 1000 | [Screenshot](live-223-browser-1440x1000.png) | [Screenshot](live-223-mv3-1440x1000.png) |
| Live window, 800 × 844 | [Screenshot](live-223-browser-800x844.png) | [Screenshot](live-223-mv3-800x844.png) |
| Narrow, 390 × 844 | [Screenshot](live-223-browser-390x844.png) | [Screenshot](live-223-mv3-390x844.png) |
| Short, 390 × 520 | [Screenshot](live-223-browser-390x520.png) | [Screenshot](live-223-mv3-390x520.png) |
| Error/recovery, 390px | [Screenshot](live-223-browser-error-390.png) | [Screenshot](live-223-mv3-error-390.png) |

[Measured Chromium geometry](live-223-geometry.json) records no page-width
overflow and 44px recording/action/navigation targets. Reading-card heights are
631px, 475px and 470px at desktop, Live-window and narrow sizes, respectively;
each exceeds half the viewport height even with two graph actions and Hold
status messages. At 390 × 520 the reading card keeps a 270px minimum and the
page scrolls normally to the bottom status, with no overlay. Text scrolls inside
its pane; tabs and controls stay outside that scrolling content.

Browser checks activate both navigation links and verify that the destination
pages retain their dark palette and do not load `live.css`. MV3 checks verify the
same stylesheet isolation. Existing Graph/Models layout checks also pass.

## Checks executed

- `node --test tests/display-tabs.test.js tests/extension.test.js tests/button-hold.test.js`:
  **60 passed**.
- `UPDATE_LIVE_UI_SCREENSHOTS=1 npm run test:browser -- tests/browser/live-ui.spec.js tests/browser/display-tabs.spec.js tests/browser/live-scroll.spec.js tests/browser/display-items.spec.js tests/browser/extension-layout.spec.js --workers=2 --output=test-results/browser-final`:
  **82 passed** across Chromium and WebKit.
- `UPDATE_LIVE_UI_SCREENSHOTS=1 npm run test:extension -- tests/extension/live-ui.spec.js tests/extension/display-tabs.spec.js tests/extension/live-text.spec.js tests/extension/simple-layout.spec.js tests/extension/graph-actions.spec.js tests/extension/targets.spec.js tests/extension/item.spec.js --output=test-results/extension-final`:
  **41 passed, 2 failed**; both failures also reproduce upstream, as described below.
- `git diff --check`: passed.

Coverage includes idle/loading/starting/running/stopping/completed/canceled/error
pills, disabled recording controls, dynamic actions and their busy/failure states,
Stop/Cancel/restart, keyboard and touch tabs, per-input scroll retention and
bottom following, background updates, unchanged DOM and text selection, literal
TEXT and ITEM rendering, empty/single-input/no-display/multiple-Display states,
responsive wrapping, target authorization, microphone permission denial, graph
change warnings, unfamiliar diagnostics, recovery and audio playback/download.
The scroll fixture now supplies a flex parent matching the real Live container.

## Known failures and unverified cases

The two failing target tests are unchanged from upstream:

1. `toolbar automatically readies one TEXT sink; Live popup focus, input/search/textarea, order, once, Stop and Cancel`
   expects newline-separated Live text but receives the literal concatenated TEXT.
2. `completed translations flow directly to TEXT fan-out and paired Live; provisional/pending and duplicate finals never insert`
   expects a `tbody` in a TEXT display; no table exists.

Both were rerun with upstream `recorder.html` and `recorder.js` from checkpoint
`6591fea` restored in the staged package. They fail at the same assertions. The
shared stylesheet and renderer already match upstream. These contract/fixture
mismatches are outside the visual redesign; no node semantics or target-test
expectations were changed.

`npm run build:extension` stopped at **Missing local models**. The checkout has
no prepared model/runtime assets. For the deterministic MV3 checks, production
extension sources, the manifest, builder-listed shared Web modules and licenses
were staged in the builder's directory layout; existing fixtures then supplied
controlled workers. This establishes source-packaged MV3 UI behavior, not a full
production asset build or real-model inference. Those checks remain unverified.
No deployment or post-merge publication check was requested for this extension
UI change. Nothing was pushed or published.
