# Canvas node headings (#156)

Canvas headings now render only the node type label. Existing `Select <node ID>`
accessible names, `data-node` attributes and Settings' `Node: <node ID>` text
remain intact. No graph schema, IDs, edges or interaction handlers changed.

The new browser regression failed against the original heading text, then
passed in Chromium and WebKit at 390×900 and 1440×900. It checks every heading,
two ASR nodes with distinct IDs, pointer and Enter/Space selection, the selected
ID in Settings, focus recovery after zoom, no horizontal page overflow and
byte-for-byte unchanged saved JSON through Save and reload.

Validation:

- `npm ci`: passed, zero audit vulnerabilities.
- `npm test`: **610 passed**, zero skips.
- `ASR_BASE_URL=http://127.0.0.1:8146 npx playwright test tests/browser/extension-layout.spec.js --grep-invert 'live regions' --workers=2`:
  **40 passed** across Chromium and WebKit, including the four new cases.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-interactions.spec.js tests/extension/layout.spec.js tests/extension/graph-models.spec.js`:
  **34 passed**, including pointer movement/reconnection, keyboard and touch
  interaction, disconnection, zoom, settings, Save/reload and the updated
  Text formatter heading expectation.
- `git diff --check`: passed.

The HTTP checks used an isolated server started with
`python3 -m http.server 8146 --directory web --bind 127.0.0.1` because port 8000
was occupied. The unrelated Live rendering case was excluded as in the
[prior validation record](graph-151.md#validation); this run does not claim that
case passes. MV3 checks used an ignored source-only package in
`dist/chrome-extension`, copying `extension/`, its manifest and the build script's
`SHARED_FILES`, with a `FIXTURE-ONLY.txt` marker. Existing test fixtures supply
controlled workers and small assets. A production model build and real inference
were not run for this presentation change.

No post-merge verification is required.
