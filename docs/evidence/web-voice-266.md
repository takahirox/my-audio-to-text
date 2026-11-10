# Field microphone graph selection (#266)

The existing field mic starts/stops one Web session with left-click. Right-click,
Shift+F10, the context-menu key, or Alt+Down opens its compatible-graph menu.
Selection saves one profile-wide default without constructing a TabSession,
loading models, requesting microphone permission, capturing audio, or editing a
field. Escape, Tab, outside pointer activation, page blur and viewport changes
dismiss the menu. Native selections and basic contenteditable carets survive it.

`webVoiceChoices` uses `webVoiceGraph`, including executable typed connectivity,
required processor inputs, graph/settings validation and existing Web exclusions.
The coordinator reads canonical extension localStorage through an inert offscreen
host and closes that host after reads when no recording owns it. Only IDs/names
and the default are sent to controls. Each Start reads the latest saved library
and captures a detached executable snapshot before permission/model preparation.
Library mutations publish changes to every connected page. Selecting elsewhere
can change the next default while existing Web and Live sessions keep their own
snapshots and resources. Cancellation keeps the control reserved through runtime
cleanup and rejects late output.

The default lives in `chrome.storage.local['web-microphone-default-v1']`. On first
resolution, a compatible legacy `assignments.webVoice` migrates. Invalid defaults
become null, with automatic fallback only for one candidate. Multiple candidates
require an explicit choice. Deletion clears the legacy assignment rather than
requiring a removed settings dropdown. Live deletion protections remain.
Explicit website opt-in, website consent and microphone permission remain
independent. Zero compatible graphs hide page controls and produce settings
guidance; saving a compatible graph makes controls available without granting
new consent. Launch Settings retain Live selection and the Web ON/OFF switch.

Validation completed in this worktree:

- `npm test`: **889 passed**.
- `npx playwright test --config playwright.extension.config.js tests/extension/web-voice.spec.js tests/extension/graph-library.spec.js --workers=1`: **54 passed**.
- After the final menu prompt cleanup, the six menu/default/restart/visibility
  cases were rerun with `--grep 'one automatic graph|multiple graphs require|preparing and stopping|deleting defaults|full browser restart|zero compatible graphs can'`: **6 passed**.
- `git diff --check`: passed.
- `npm run build:extension`: stops at the existing missing-local-model prerequisite
  (`Missing local models. Run npm run prepare:assets first.`). No models downloaded.

The Chrome checks load the real MV3 extension and exercise trusted pointer/key
input through its closed shadow widget, actual storage/ports/offscreen ownership,
concurrent Web and Live sessions, caret handling, exactly-once final insertion,
permission setup/denial/revocation, cancellation, navigation, worker loss, browser
restart and cleanup. ASR workers and microphone audio are deterministic fixtures;
these results do not claim real-model inference or physical-device validation.
The restart fixture reapplies the same native host-permission grant used at
installation because CDP unpacked reloading does not preserve the initial
required-host installation fixture as an optional grant.

Reusable subgraphs from #265 are absent from this upstream checkout: the current
version-15 graph schema has no reusable definitions or subgraph nodes. Eligibility
therefore uses the existing executable graph resolver; unknown nodes/references
fail closed. Saved subgraph expansion could not be tested against absent semantics.
