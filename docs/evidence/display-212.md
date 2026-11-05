# Display tabs and ITEM columns (#212)

Validated on 2026-11-05 with Playwright 1.63.0, Chromium 153.0.8010.12 and
WebKit 26.6 on macOS. All checks below were local; nothing was pushed or published.

## Result and compatibility

One executable Display creates one tab, keyed by Node ID in graph array order.
`settings.title` labels it; blank titles use `Display <ID>`. `inputCount` defaults
to 1 and supports 1–32 numbered ITEM ports. Every port owns an independent latest
complete snapshot, including omitted siblings in grouped deliveries. There are
no producer restrictions, output ports or new graph execution rules.

Version 15 is retained. Only Display's legacy destination `input` converts to
`input1`, and missing title/inputCount settings receive defaults. Reading and
validation do not mutate the graph or stored original. Save/Export write the
canonical form. Node IDs, unrelated data and `Hold.input` remain intact;
conflicting legacy/current connections fail validation. Older unsupported schema
versions and removed Node types still require explicit recovery.

Try [the model-free example](../examples/display-tabs.json) through Import and
Save. It uses three Text constants to demonstrate Main's two independent columns
and Summary's single pane. Replace the constants with any compatible producers.

## Checks completed

- `npm ci`: installed the repository's pinned dependencies.
- `npm test`: **760 passed**, including bounds/title validation, legacy storage,
  default/reset, JSON round-trips, exact edge removal, partial executable paths,
  all concrete ITEM types, grouped and independent updates, duplicate titles,
  node order, HTML safety, and per-port Stop/Cancel/restart/stale-context behavior.
- `npx playwright test tests/browser/display-tabs.spec.js tests/browser/live-scroll.spec.js tests/browser/display-items.spec.js --project=chromium --project=webkit`:
  **16 passed**. Hidden processing, latest results on return, roving tabindex,
  ARIA relationships, arrows/Home/End, focus/selection retention, independent
  scrolling and following (including hidden updates), copy, safe pair/list/text
  rendering, Stop/Cancel/restart, and 1440/390/280 px layouts.
- `npx playwright test tests/browser/extension-layout.spec.js tests/browser/view.spec.js tests/browser/text-sliding-window.spec.js tests/browser/keyed-text-coalesce.spec.js --project=chromium`:
  **37 passed**, covering editor gestures, keyboard/touch, persistence, recovery,
  independent producer compatibility and existing formatting/layout behavior.
- Unpacked MV3 using `playwright.extension.config.js`: **84 distinct scenarios
  passed across the initial runs and targeted reruns after correcting affected
  fixtures/assertions**. Files: `display-tabs`, `live-text`, `simple-layout`,
  `graph-interactions`, `graph`, `graph-concurrent`, `graph-text-summary`,
  `graph-hold-feedback`, `item`, `graph-if-condition`, `graph-number`,
  `graph-whisper`, `primitive-composition`, and `layout` (all `.spec.js` under
  `tests/extension`). Existing assertions were updated for numbered ports,
  Display Settings, tab visibility, Input N headings, canonical example JSON,
  actual pair-table rows and retained last snapshots. Final targeted reruns
  passed; no observed failures remain unresolved.
- The production recorder path ran the model-free example, verified two Main
  columns plus one Summary pane, and selected Summary with trusted Chrome touch
  events at 1440 and 390 px. Selected-tab hover contrast is regression-tested.
- `git diff --check`: passed.

## Screenshots

Generated from the actual unpacked MV3 recorder using literal Text sources with
`UPDATE_DISPLAY_SCREENSHOTS=1 npx playwright test --config playwright.extension.config.js tests/extension/display-tabs.spec.js --grep model-free`.
Main was visually inspected at both widths: side-by-side wide panes and stacked
narrow panes, with readable selected-tab contrast and no horizontal overflow.

| View | Wide | Narrow |
| --- | --- | --- |
| Main | [1440 px](display-212-main-1440.png) | [390 px](display-212-main-390.png) |
| Summary | [1440 px](display-212-summary-1440.png) | [390 px](display-212-summary-390.png) |

## Packaging and limits

`npm run build:extension` was attempted and stopped with **Missing local models**.
The worktree has no prepared ASR/translation/TTS model distribution. A full
production bundle and real-model microphone/tab-audio inference were **not**
validated. This change does not modify inference or model preparation.

For the MV3 tests, source files were staged into ignored `dist/chrome-extension`
using the production packager's `SHARED_FILES` list, with extension sources and
manifest copied unchanged. The existing fixtures then installed their controlled
Workers and asset responses. This exercises Chrome's extension boundary,
production graph/session/editor/Live code and real Worker messaging, without
claiming a model-complete production build. The model-free recorder example
requires no inference replacement.

The source-only staging operation was:

```python
import importlib.util
import shutil
from pathlib import Path
spec = importlib.util.spec_from_file_location('extension_build', 'scripts/build-extension.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
target = Path('dist/chrome-extension')
(target / 'web').mkdir(parents=True, exist_ok=True)
shutil.copytree('extension', target / 'extension', dirs_exist_ok=True)
shutil.copy2('extension/manifest.json', target / 'manifest.json')
for name in build.SHARED_FILES:
    shutil.copy2(Path('web') / name, target / 'web' / name)
```

Screen-reader speech output and physical touch hardware were not tested;
accessibility coverage checks DOM semantics, keyboard operation, live-region
suppression, focus and trusted emulated touch events.
