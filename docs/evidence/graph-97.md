# On-canvas edge removal (#97)

Local verification on macOS with Playwright 1.63.0 and packaged MV3 Chromium.
The standard asset preparation scripts staged the pinned ASR, translation and
TTS runtimes before building `dist/chrome-extension/`.

## Automated coverage

`tests/extension/graph-interactions.spec.js` verifies:

- No Connections heading/list; Disconnect is hidden until a wire is selected.
- Native mouse selection through the enlarged SVG hit target, selected styling
  and accessible state, switching wires without deleting, and blank-canvas/Escape
  clearing. Selecting alone leaves the draft clean and all wires present.
- Pointer removal at 50%, 75%, 100%, 125% and 150% zoom. The labeled native button
  stays at least 112 × 44 screen pixels, within the canvas viewport and clear of
  ports. Saving/reloading preserves every other edge, Node and fan-out route.
- Zoom changes, scrolling a selected wire out of view and back, a 390px-wide
  layout, and selecting a tiny visible segment of a long, scrolled wire.
- Delete/Backspace on a focused wire, Enter/Space selection and button activation,
  Tab/Shift+Tab between selected wire and action, Escape from the action, and
  focus returning to the scrollable canvas after removal.
- Native Chromium touch input via CDP `Input.dispatchTouchEvent`, selecting and
  removing an optional edge without hover or keyboard. Saving leaves the running
  session's Workers and provisional route intact; the next session uses the edit
  while its final route still works.
- Required-input validation and refusal to save an invalid deletion, reconnection
  by click/drag, conflict handling, migrations and translation display behavior.

Existing graph tests now select a wire before using its on-canvas control;
they continue to cover Node editing/dragging, validation/recovery, persistence,
profile restart, active-session isolation and TTS fixture integration.

## Checks

- `npm test`: 274 passed, no skips.
- `npm run test:extension`: 101 passed, 5 opt-in skips. This full regression run
  preceded the final viewport-anchor and Node-selection hardening.
- After those final changes, `npm run build:extension` succeeded and
  `npm run test:extension -- tests/extension/graph-interactions.spec.js tests/extension/graph.spec.js`
  passed all 27 tests, without skips.
- `git diff --check` passed.

The five skipped opt-in smokes are real Supertonic3/Kokoro inference (two),
real ASR-to-field speech (one), and real OPUS-MT in both directions (two).
The graph interaction tests exercise the packaged editor, storage and session
coordinator; their capture/ASR and heavyweight inference boundaries are fixtures.
The full suite also checks real packaged ASR Worker initialization and native
capture/page-target interactions, without establishing speech accuracy here.

Shared web-browser tests, opt-in model inference smokes, physical touch hardware
and manual site-specific checks were not run for this editor-only change.
No post-merge or deployed-extension verification is required.
