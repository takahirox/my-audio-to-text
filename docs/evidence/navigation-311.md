# Graph Editor and execution navigation (#311)

Graph Editor now keeps only Library and Models in its header. The redundant
Live action, current-page Graph item and unused navigation status are removed.
The execution window's graph link is labeled **Edit graph**. The existing
session-aware graph ID rewrite and explicit editor `?id=` handling are unchanged.
Models retained its Live control at this point; #319 subsequently simplifies
the Models header navigation to Library only.

## Validation

- `npm run test:extension -- tests/extension/extension.spec.js tests/extension/graph.spec.js tests/extension/shared-ui.spec.js tests/extension/simple-layout.spec.js tests/extension/toolbar-launch.spec.js`
  initially passed 42 of 46 cases. Three obsolete UI assumptions were corrected:
  keyboard navigation starting at the removed Live button, selection persisting
  between viewport checks, and recorder URLs no longer matching a bare URL after
  graph/session parameters are added.
- `npm run test:extension -- tests/extension/shared-ui.spec.js tests/extension/simple-layout.spec.js --grep 'share light controls|Models keeps real|Graph stays canvas-first'`
  passed all three corrected cases. In total, all 45 applicable extension cases
  passed across the broad run and targeted rerun.
- `node --test tests/live-model-preparation.test.js` passed all 40 cases,
  including distinct saved/active graph IDs and independent session ownership.
- `git diff --check` passed.

The multi-window regression opens graph B while graph A is the toolbar default
and is running in another window. Keyboard and pointer activation open B's
explicit editor URL while B is idle, running with pending saved changes, and
completed. Recovery and Edit outputs links retain B's ID. Library/Models
navigation preserves both windows' sessions and the toolbar default. Native
audio navigation also preserves the capture grant, stream and running contexts.

Shared UI checks cover keyboard focus, visible links, 44px control heights and
no horizontal overflow at 1440px and 390px. Generated narrow screenshots were
visually inspected for both headers.

The remaining packaged ReazonSpeech/Silero smoke test could not run:
`Extensions.loadUnpacked` reported `File path cannot be resolved` because this
checkout has no `dist/chrome-extension` bundle or prepared model assets.
Real-model inference and packaging were not validated for this markup change.
