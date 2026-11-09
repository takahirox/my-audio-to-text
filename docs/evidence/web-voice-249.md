# In-page microphone controls #249

The content script now constructs four locally bundled Material Symbols Outlined
SVGs at 20 px inside a 36 × 36 px circular control. Recording uses Stop with a red
surface; preparing/stopping use an activity icon, respecting reduced motion;
errors retain the explanatory tooltip and live status. Source paths, pinned
upstream revision and the full Apache-2.0 license are packaged under
[extension/icons/material-symbols](../../extension/icons/material-symbols/README.md).

Placement tests nearby exterior positions first, samples the painted page to avoid
neighbouring controls, then expands the search in crowded rows. The control and
status are clamped independently to the visual viewport. An active Stop remains
visible when its field scrolls offscreen. A completely occupied viewport still
requires best-effort placement; no universal website layout guarantee is claimed.
Session, permission, graph, capture and insertion code remains unchanged.

Validation in this worktree (Chrome for Testing **153.0.8010.12**):

- `npm test`: **863 passed**.
- Installed-extension checks: **25 passed** across `web-voice.spec.js` (17),
  `graph-library.spec.js` (7) and `live-model-preparation.spec.js` (1).
- The three new browser tests inspect the actual closed Shadow DOM via DevTools,
  compare all rendered paths to the locally packaged official SVGs, and verify
  bundled attribution/license, dimensions, centering, `currentColor`, decorative
  accessibility attributes, all five states, labels/status, disabled Stop drain,
  normal/reduced motion, idle/recording dark treatments, hover, focus, and forced
  colors. They check the unchanged input caret after pointer Start, normal typing,
  native Space activation after DevTools focus, and Tab/Enter Stop while recording.
- Layout checks cover adjacent textarea/submit controls, a crowded form, tiny
  fields, viewport corners, 320 px width, resize, style-only reflow, CSS zoom 1.25,
  native `chrome.tabs.setZoom(1.25)`, device scale factor 2, and offscreen scrolling.
- Existing Web voice lifecycle tests pass, including input/textarea/basic
  contenteditable insertion, final drain, target/focus changes, cancellation,
  permission denial/removal, resource ownership, removal/navigation and reload.
- All new UI checks report **zero remote requests and zero page errors**.
  [State-check evidence](web-voice-249/mic-ui-evidence.json).
- `node --check extension/web-voice-content.js` and `git diff --check`: passed.

The browser fixture installs an unpacked bundle of production extension files and
the production optional-only manifest, with controlled inference Workers and a
fake microphone. It uses the existing native host-grant upgrade fixture and CDP
microphone permission decisions. It does not substitute the content script or add
page-world access/test hooks. See [#247 evidence](web-voice-247.md) for the fixture's
permission-prompt limitations. This run does not claim physical microphone or
real-model inference validation.

Full model distribution validation is unavailable in this clean worktree:
`npm run build:extension` stops with **Missing local models. Run npm run
prepare:assets first.** The additional `targets.spec.js` run failed all 23 cases
at fixture setup with `ENOENT: dist/chrome-extension`, before exercising feature
code. Those checks need the documented asset preparation and full build before
rerunning; asset validation was not bypassed. The installed Web voice UI checks
above use their independent production-source bundle and passed.

Saved Chrome screenshots (review evidence, not pixel-baseline assertions):

- [Idle light with focus](web-voice-249/mic-light-focus.png)
- [Idle dark](web-voice-249/mic-dark.png)
- [Recording light](web-voice-249/mic-recording.png)
- [Recording dark](web-voice-249/mic-recording-dark.png)
- [Error/status](web-voice-249/mic-error.png)
- [Small field with page/CSS zoom and device scale factor 2](web-voice-249/mic-small-field-zoom.png)
