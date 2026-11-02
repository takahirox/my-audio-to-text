# Issue #194 verification

Implemented primitive `KeyedTextPair` and browser `TextDisplay` output sink.
The [saved graph JSON](keyed-text-194.json) and
[executable fixture](../../tests/fixtures/keyed-text-graph.js) contain the exact
recommended ASR/coalesce/pair/translation/output wiring. No DOM edges occur after
ASR. Existing version 15 graphs and all legacy DOM Nodes remain supported.

Checks run on 2026-11-02:

| Command | Result |
| --- | --- |
| `npm test` | 929 passed, no failures or skips |
| `npx playwright test tests/browser/keyed-text.spec.js --workers=1` | 4 passed: Chromium and WebKit |
| `npx playwright test tests/browser/text-display.spec.js tests/browser/keyed-dom.spec.js tests/browser/keyed-text-coalesce.spec.js --workers=1` | 18 passed: legacy display/coalesce compatibility in Chromium and WebKit |
| `npx playwright test --config playwright.extension.config.js tests/extension/keyed-text.spec.js` | 1 passed: real Chromium MV3 pages with controlled Workers |
| `npx playwright test --config playwright.extension.config.js tests/extension/keyed-dom.spec.js` | 3 passed: legacy MV3 graph compatibility |
| `git diff --check` | Passed |
| `npm run build:extension` | Blocked: missing local models; builder requests `npm run prepare:assets` |

The new runtime tests cover all four translation types, immediate original text,
atomic final/preview clear without a blank snapshot, concurrent A/B, delayed A
translation, first-seen ordering, distinct IDs with duplicate strings, translation
failure retaining original text, and literal `<script>` rendering. Pair tests
cover independent Number/TEXT producers, both edge orders, text-first/ID-first,
ID-only changes, explicit clearing, grouped omissions, numeric validation, grouped
fan-out, stale contexts and fresh Start. Browser tests also deliver B translation
before A and verify literal rendering, Cancel and output reset. The MV3 test uses
production session/runtime/Live mounting, saved graph reload, actual queued Worker
messages, Stop, Cancel, restart and Worker cleanup. The editor test uses keyboard
activation of port buttons so overlapping fixture cards cannot intercept clicks.

Because this clean worktree has no prepared model assets, MV3 checks used a
code-only fixture package in ignored `dist/chrome-extension`, assembled from the
production builder's `SHARED_FILES`, the unchanged extension directory and manifest:

```python
from pathlib import Path
import runpy, shutil
spec = runpy.run_path('scripts/build-extension.py')
target = Path('dist/chrome-extension')
(target / 'web').mkdir(parents=True, exist_ok=True)
shutil.copytree('extension', target / 'extension', dirs_exist_ok=True)
shutil.copy2('extension/manifest.json', target / 'manifest.json')
for name in spec['SHARED_FILES']:
    shutil.copy2(Path('web') / name, target / 'web' / name)
```

The existing extension test fixture copies that package into its owned temporary
directory, replaces model/capture Workers and asset manifests with deterministic
fixtures, then loads it in Chromium. This verifies module packaging and MV3 host
integration; it does not establish a successful full model-bearing distribution
build. No real-model inference, actual audio capture or native-environment check
was run. No native implementation was added. No push, PR, merge or issue comment
was made.
