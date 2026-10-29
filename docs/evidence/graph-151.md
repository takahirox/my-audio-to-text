# Readable editing after zoom and Fit (#151)

Browser reproduction confirmed the concern before changing production code.
Playwright 1.63.0 ran the actual extension HTML, CSS and modules in Chromium
153.0.8010.12 and WebKit (Playwright revision 2359), on macOS arm64. HTTP tests
replace only file delivery; MV3 tests additionally exercise the extension origin.

The small case is the default five-Node graph. The large case adds 35 parked
Text Nodes in ten columns: `x = 20 + (i % 10) * 400`,
`y = 600 + floor(i / 10) * 350`. Viewports are 390×900 and 1440×900 CSS pixels.

## Reproduction and measurements

Before the fix, choose 25% or Fit, activate `speech output final`, then choose
100%. The output can be selected with an exact pointer click, but its text is
visually unreadable in the narrow overview. At 390px, returning to 100% leaves
the port outside the canvas viewport and focus on neither that port nor its
Node. All 16 engine/size/width/zoom observations are in
[the original measurements](graph-151-before.json).

Both engines produced the following geometry for `speech output final`
(rounded CSS pixels). Label/hint sizes are computed font sizes multiplied by
the measured canvas scale; target dimensions come from `getBoundingClientRect`.

| View | Zoom | Port width × height | Label / hint font size |
| --- | ---: | ---: | ---: |
| Either graph, either width, 25% | 25% | 26.04 × 11.00 | 2.81 / 2.25 |
| Default, 390px, Fit | 21.32% | 22.20 × 9.38 | 2.40 / 1.92 |
| Large, 390px, Fit | 9.42% | 9.81 × 4.14 | 1.06 / 0.85 |
| Default, 1440px, Fit | 82.00% | 85.41 × 36.08 | 9.23 / 7.38 |
| Large, 1440px, Fit | 36.22% | 37.73 × 15.94 | 4.08 / 3.26 |
| Editing, 100% | 100% | 104.16 × 44.00 | 11.25 / 9.00 |

Native touch also cannot reliably select the short audio wire among adjacent
tiny cards at the lowest scales: an exact exposed DOM point can hit a neighbor
or reveal no Disconnect action. This is treated as an overview limitation;
touch recovery and subsequent editing are tested explicitly. No zoom-dependent
connection rules, automatic disconnections, or blocked editing gestures were
introduced.

Screenshots of the large graph at 390px:
[before Fit](graph-151-before-fit.png),
[after Fit](graph-151-after-fit.png), and
[after Edit at 100%](graph-151-after-edit.png).
The last image shows the far-away `literal-29` output focused and readable.

## Correction and acceptance

The existing viewport action row now offers **Edit at 100%** only below 100%.
It keeps a native 44px target and wraps on narrow windows. Fit still shows the
entire graph. The return action restores the last focused Node/port or selected
wire and reveals it; the existing zoom selector also reveals that target when
increasing scale, keeping focus on the selector. Without an editing target,
zoom preserves the viewport center and the return action focuses the canvas.
No graph schema, port rules, permanent toolbar, navigation mode, framework or
miniature map was added.

[Post-change measurements](graph-151-after.json) contain 32 observations across
both engines, both graph sizes, both widths, 25%/50%/75% and Fit, including actual
hint line rectangles. Overview sizes remain the same. Regression assertions
verify the full-size return action, restored focus and visible editing control,
44px port targets at 100%, unchanged selected-port state and saved graph, and
no horizontal page overflow. A separate selected-wire case verifies that an old
Node focus cannot take precedence over the wire and its keyboard Disconnect.

Keyboard cases at 25%/50%/75%/Fit exercise Enter/Space connections, incompatible
input disabling, Escape, wire selection, Tab/Shift+Tab and Disconnect, heading
arrow movement, contextual settings, and Save with exact graph assertions.
Pointer cases at 25%/Fit/150% exercise typed reconnection, exact edge removal
and correctly scaled heading movement. Pointer movement tolerates one screen
pixel of native coordinate rounding at tiny Fit scales. Native touch cases tap
Fit/return, connect compatible ports, reject incompatible input, select a wire
and tap Disconnect after recovery; they also verify focus and Save. Existing MV3
tests retain drag connection, Delete/Backspace removal and active-session checks.

## Validation

- `npm ci`: passed, zero audit vulnerabilities.
- `npm test`: **606 passed**.
- A dedicated server was started with
  `python3 -m http.server 8141 --directory web --bind 127.0.0.1` because the
  default port 8000 was already occupied. With that server:
  `ASR_BASE_URL=http://127.0.0.1:8141 npx playwright test tests/browser/extension-layout.spec.js --grep-invert 'live regions' --workers=2`:
  **36 passed**, zero skips, across Chromium and WebKit.
- The complete browser layout file initially exposed the existing
  `live regions render safe snapshots...` failure in both engines:
  `DOM expects an actual inert HTML Node or DocumentFragment.` The fixture
  passes strings to the DOM renderer. Running an exact copy of the upstream
  test from `427d244` reproduced both failures independently. That unrelated
  fixture is unchanged; the full layout file is not claimed to pass.
- `npx playwright test --config playwright.extension.config.js tests/extension/layout.spec.js tests/extension/graph-interactions.spec.js`:
  **24 passed**. After prioritizing a selected wire during zoom, reran those
  files with `--grep 'Fit and low|selected-edge control|on-canvas pointer disconnect'`:
  **7 passed** against the final source.
- `git diff --check`: passed.

`npm run build:extension` stops with “Missing local models. Run npm run
prepare:assets first.” Production model/runtime assets are absent; no models
were downloaded. MV3 checks used an ignored source-only fixture package at
`dist/chrome-extension`: copy `extension/`, its manifest to the package root,
and exactly `SHARED_FILES` from `scripts/build-extension.py` into `web/`.
A `FIXTURE-ONLY.txt` marker identifies it. Existing test fixtures supply small
controlled assets and Workers. This establishes packaged editor behavior,
not production model readiness or real inference.

No post-merge verification is required by #151.
