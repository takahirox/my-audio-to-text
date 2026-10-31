# Graph Editor model notices in Help (#182)

The existing native details disclosure now sits near the top of Graph Editor
Help, initially collapsed, with a Models link that opens a separate tab and keeps
the draft available. The existing draft-based notice selection and deduplication
are retained. An explicit empty message appears when no notices apply. Existing
Help instructions and the TranslateGemma legal/attribution link remain available.
Save, persistence, model preparation, caching and session code are unchanged.

Validation on 2026-10-31:

- `npm test`: 822 passed, including graph persistence and preparation checks.
- `npx playwright test tests/browser/extension-layout.spec.js`: 64 passed across
  Chromium and WebKit. New checks cover Help placement, initial collapse,
  Enter/Space disclosure interaction, link keyboard navigation, Models opening,
  Close/Escape focus recovery, 390/1440px layouts, every current model notice,
  deduplication, adding/removing Nodes, Load saved, Reset, empty notices, unchanged
  storage and no preparation requests during editing/Help use.
- `npm run test:extension -- tests/extension/layout.spec.js tests/extension/graph-models.spec.js tests/extension/graph-optional-asr.spec.js tests/extension/translategemma.spec.js --grep 'layout|Save and reload|both optional ASRs|Save|save'`:
  15 passed, one existing failure. Passes include narrow MV3 Help and draft controls,
  optional ASR/Gemma notices in Help, saved-node preparation, cache reuse,
  preparation failures/retry, cancellation and concurrent saves.
- `git diff --check`: passed.

The existing `layout.spec.js:60` transcript assertion expects a newline between
committed text and preview, while DOM text content concatenates them. The same
failure was reproduced with the unchanged upstream `graph-editor.js` in the
fixture package; no transcript/runtime changes were made for this UI issue.

`npm run build:extension` stops at “Missing local models. Run npm run
prepare:assets first.” MV3 checks used the repository's documented source-only
fixture packaging approach: ignored `dist/chrome-extension`, marked
`FIXTURE-ONLY.txt`, with extension/, its root manifest, the builder's exact
SHARED_FILES and legal files under web/. Existing fixtures supply controlled
Workers/assets. A complete production build and real model inference were not
validated. No post-merge-only verification is required by this issue.
