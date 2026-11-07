# Issue #241: pointer-anchored Graph Editor zoom

Ctrl+wheel and Chromium trackpad pinch share one non-passive listener on the
canvas scrollport. Pixel, line and page deltas become continuous logarithmic
zoom steps, bounded near 10% per event. Ordinary scrolling and events over
Inspector, quick-add, navigation controls and other overlays remain native.
Zoom stays within 1%–150%; buttons use 10 percentage point steps, presets remain
available, and custom/Fit percentages display to two decimal places.

Zoom updates the canvas transform, scroll extent and wire hit widths without
recreating nodes, ports or wires. Pointer anchoring includes the viewport border,
actual scroll offsets and ancestor scaling. Native scroll bounds constrain the
anchor at edges. Modified gestures during node/port drags are consumed without
changing zoom. Explicit 100% selection retains editing-target focus recovery.

Validation executed on 2026-11-07:

- `npm test`: **835 passed**.
- `npx playwright test tests/browser/graph-zoom.spec.js tests/browser/graph-canvas-first.spec.js tests/browser/graph-port-order.spec.js tests/browser/graph-quick-add.spec.js tests/browser/graph-routing.spec.js tests/browser/extension-layout.spec.js --project=chromium --workers=1 --output test-results/graph-241`: **81 passed**.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-canvas-first.spec.js --output test-results/mv3-zoom`: **1 passed**, loading the production editor modules with the real MV3 manifest without inference assets.
- `node --check` on the editor and both new test modules; `git diff --check`: passed.

Coverage includes deterministic pointer geometry and reversal while scrolled at
1440px/390px, 2× display scale and a scaled ancestor; delta normalization;
native wheel scrolling and Ctrl+wheel browser-zoom suppression; Chromium's CDP
synthesized desktop pinch with exactly one application of each wheel delta;
fractional percentages, keyboard buttons, tiny Fit, limits, scroll-edge clamping,
100% focus restoration, wire attachments/hit testing, selected-wire keyboard
actions, fractional node/port dragging, reconnect/detach/cancellation, quick-add,
Inspector edits, touch controls, and unchanged saved graph data during zoom.

Pinch coverage uses Chromium's gesture synthesis, not physical trackpad hardware.
No Safari-specific gesture support is added or claimed.
