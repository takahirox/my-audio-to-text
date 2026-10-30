# Graph Editor inspector, disconnection and recovery (#160)

The inspector stays 280px wide on desktop and occupies a compact, scrollable
region below the canvas on narrow screens. Selection updates existing canvas
controls in place; the node selection border no longer shifts its ports.
Empty selection, node Settings (including IDs), and connection details share the
same region. Clear selection, Escape and blank canvas retain their focus paths.

Connected input ports support pointer/touch dragging to blank canvas to detach
one wire, and dragging to a compatible input to reconnect transactionally.
Cancelled drags, invalid targets and identical connections preserve the draft.
The inspector Disconnect action and focused-wire Delete/Backspace remain
available. The floating button, placement sampling and overlap scoring are gone.

Recovery is under Graph actions → Recovery. Its selector, Copy JSON and Download
JSON expose original, older and numbered copies. Copy/download use the original
stored string, including CRLF, rather than the textarea's normalized value.
Blocking migration still shows a visible repair/Save warning and recovery path.
The graph storage and migration implementation is unchanged.

Validation:

- `npm test`: 618 passed.
- `node --test tests/extension-graph-editor.test.js tests/extension-graph.test.js`:
  35 passed after the input-reconnection change.
- `npx playwright test tests/browser/extension-layout.spec.js --grep-invert 'live regions render safe snapshots' --workers=2`:
  56 passed across Chromium and WebKit. Covers 1440px/390px geometry and scroll
  stability, duplicate types/IDs, focus, zoom/Fit, pointer/touch controls,
  disconnection, input-end dragging and exact recovery-copy integrity.
- Final browser drag/recovery rerun (`--grep 'connected input drag|input-end dragging|Graph actions recovery'`):
  12 passed after tightening wire hit testing and asserting CRLF downloads.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-interactions.spec.js tests/extension/layout.spec.js tests/extension/graph.spec.js tests/extension/live-text.spec.js tests/extension/simple-layout.spec.js`:
  75 passed. Includes native touch dragging, active/saved draft isolation,
  profile persistence, older reviewed migrations and v12 paired-input repair.
- Final MV3 drag/recovery rerun (`--grep 'connected input drag|input-end dragging|native touch drags|Graph actions recovery'`):
  7 passed against the final source and exact-download assertions.
- Desktop and narrow screenshots inspected locally: the inspector is beside/below
  the canvas, and no floating Disconnect or horizontal page overflow appears.
- `git diff --check`: passed.

The excluded pre-existing browser renderer case supplies strings to the DOM-only
rendering API and fails in both engines ("DOM expects an actual inert HTML Node
or DocumentFragment"). It is unrelated to this editor change and was left intact;
the complete browser layout file is not claimed to pass.

`npm run build:extension` stops because prepared local model/runtime assets are
absent ("Missing local models. Run npm run prepare:assets first."). MV3 tests
used an ignored source-only fixture package in `dist/chrome-extension`, marked
`FIXTURE-ONLY.txt`: extension/, its manifest at package root, and exactly the
builder's SHARED_FILES under web/. Existing extension test fixtures provide
controlled Workers/assets. These checks establish packaged editor behavior,
not production model readiness or real inference.

No post-merge verification is required by #160.
