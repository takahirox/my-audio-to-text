# Graph Library and Launch settings separation (#253)

The Library list and selected detail now contain graph management, preview,
metadata and recovery. Assignment buttons and Live/Web assignment tags are
removed. The separate **Launch settings** panel below the workspace contains
labeled graph selectors for **Live window** and **Web page microphone button**,
with an independent website microphone ON/OFF switch. Help disclosures retain
next-session behavior and permission guidance without permanent long copy.

Selectors use stable IDs and the existing revision-aware `GraphLibrary.assign()`
path. Disabled options include eligibility reasons from `usable`/`webVoiceError`;
a bound graph becoming incompatible remains selected with a recovery reason.
Only the Web selector supports **Not assigned**. Failed writes and stale revisions
restore current saved choices, preserve metadata drafts and focus an inline
error. Cross-tab changes refresh both selectors and saved names without discarding
unsaved details. Bound graphs remain protected from deletion with a compact
Launch settings instruction.

The separate preference store, default-OFF rule, permission scope, injection
policy, graph schema and runtime/session code are unchanged. Assignment never
requests permission or enables website controls. Explicit ON opens the consent
dialog; only Continue requests Chrome permission in the user gesture. Denial,
Cancel and Escape remain OFF. OFF retains the saved graph and removes controls /
stops capture. Re-enabling still requires a compatible binding.

## Visual and accessibility evidence

Inspected production extension UI screenshots in headless Chromium on macOS:

- [1440 px master/detail and Launch settings](library-253-1440.png)
- [390 px selected details](library-253-390.png)
- [390 px list and long launch choices](library-253-list-390.png)
- [320 px list and long launch choices](library-253-list-320.png)
- [390 px explicit-ON consent dialog](library-253-consent-390.png)

Browser assertions cover label/select associations and accessible combobox names,
switch name/state, keyboard row selection without assignment, native select
type-ahead, Tab to the switch, Space to open consent, Escape/focus return, focused
save errors, narrow Back navigation, menu bounds and no document overflow with
long names at 390/320 px. These are browser accessibility/keyboard checks;
physical-device and VoiceOver testing were not performed.

## Validation (2026-11-10)

- `npm ci --ignore-scripts`: passed, 0 audit vulnerabilities.
- `npm test`: **863 passed**.
- Focused Library + Web microphone browser run: **31 passed**.
- Broader source-based MV3 UI regression command below: **50 passed** on the
  final UI/test changes. Coverage includes both selectors, stable renamed IDs
  across reload/sort, independent opt-in and cross-tab OFF, re-enable after
  unassignment/rebinding, invalid/edited/corrupt graphs, stale revisions, quota
  errors, retained drafts, safe deletion after unassignment, Live snapshot and
  preload cancellation, microphone lifecycle, permission denial/removal, Web
  snapshot behavior, exactly-once output, model caching and editor recovery.
- `node --check` for the Library page and both changed browser test files:
  passed. `git diff --check`: passed.

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-library.spec.js \
  tests/extension/web-voice.spec.js \
  tests/extension/graph-actions.spec.js \
  tests/extension/graph-concurrent.spec.js \
  tests/extension/graph-models.spec.js \
  tests/extension/live-ui.spec.js \
  tests/extension/shared-ui.spec.js \
  --grep-invert 'Live, Graph and Models' --reporter=line
```

## Validation limits

`npm run build:extension` was attempted and is blocked by missing prepared local
models: `Missing local models. Run npm run prepare:assets first.` No model assets
were downloaded, production package built, or real-model/GPU inference tested.
Source-based fixtures exercise production extension pages, storage and runtime
with controlled model inference replies.

The command excludes the unrelated shared-UI **Live, Graph and Models** test
because of the existing Graph Editor inspector failure documented and reproduced
on untouched upstream in [the #250 validation record](graph-library-250.md).
It was not rerun here. No Graph Editor, Live or shared stylesheet changed.

Chrome's native permission-bubble buttons are not automated. Grant fixtures use
Chrome-native installation grants; the denial test controls only the permission
API result and checks exact HTTP/HTTPS origins and an active user gesture. No
request occurs before explicit ON and Continue.
