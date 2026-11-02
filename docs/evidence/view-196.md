# Issue #196 verification

Implemented the documented portable `VIEW` contract, one `ViewBuilder` for
plain/latest and keyed text-row snapshots, and a `Display` with only VIEW input.
Display renders complete snapshots without keyed history. The
[recommended importable graph](view-196.json) and
[executable fixture](../../tests/fixtures/view-graph.js) use ASR/coalesce/pair →
ViewBuilder → Display with a separate independently keyed translation branch.

Saved #194 TextDisplay graphs and earlier DOM compositions retain their original
runtime implementations, ports, settings, wires, storage and recovery copies.
Graph version remains 15; no automatic migration is introduced. TextDisplay is
identified as legacy in the palette. Existing default and preference-import
graphs retain their established behavior. New recommendations use VIEW.

Checks run on 2026-11-03:

| Command | Result |
| --- | --- |
| `npm ci` | Passed; 43 packages installed, audit found no vulnerabilities |
| `npm test` | 955 passed, no failures or skips |
| `npx playwright test tests/browser/view.spec.js tests/browser/keyed-text.spec.js tests/browser/text-display.spec.js tests/browser/keyed-dom.spec.js tests/browser/keyed-text-coalesce.spec.js --workers=1` | 26 passed in Chromium/WebKit |
| `npx playwright test tests/browser/view.spec.js --workers=1` | 4 passed after adding plain-view, layout and accessibility assertions |
| `npx playwright test --config playwright.extension.config.js tests/extension/view.spec.js tests/extension/keyed-text.spec.js tests/extension/keyed-dom.spec.js` | 5 passed in actual Chromium MV3 pages with controlled model Workers |
| `npx playwright test --config playwright.extension.config.js tests/extension/view.spec.js` | Passed after the session destination check was updated for Display |
| `git diff --check` | Passed |
| Local Markdown link check | Passed for all eight changed Markdown files |
| `npm run build:extension` | Blocked: missing local models; builder requests `npm run prepare:assets` |

The Node suite checks VIEW invariants, JSON/structured cloning, immutable ownership,
numeric IDs (including negative/fractional/large IDs and 0/-0 equality), empty and
duplicate strings, pending text-first and ID-first updates, ID-only changes,
atomic versus independent updates, grouped omissions, validation before mutation,
fresh Start, stale/aborted contexts and Stop/Cancel/disposal. It exercises ordinary
VIEW fan-out to multiple sinks and an arbitrary producer/output name, rejects
TEXT/NUMBER/DOM type mismatches, checks unfinished drafts and recommended JSON,
and verifies rendering without hidden accumulation. A session regression verifies
that Display remains an active destination alongside an unavailable focused field.

Production-runtime regressions run the new VIEW path and the unchanged legacy
TextDisplay path with all four translation types and transcription alone. They
cover provisional A → final A with no blank finalization gap, B while A translation
is pending, late A replacement, row order, duplicate utterances under distinct
IDs, empty/error translation, safe HTML-like strings and lifecycle cleanup.

Browser tests cover both new Nodes in palette categories, independent keyboard
connections, type filtering, no Settings, Help, Save/reload and original recovery
retention. The same output type renders plain one-cell and paired two-cell views;
real layout verifies equal column widths, preserved whitespace, keyboard focus,
accessible labels and the Live region. Another browser regression sends B
translation before A, checks explicit clears, Cancel, stale emissions and restart.
MV3 tests exercise packaged module imports, production sessions and Live mounting,
actual queued Worker replies, serialized graph reload, Stop, Cancel, restart and
Worker cleanup. Legacy browser/MV3 regressions remain green.

## Packaging scope and unrun checks

This clean worktree has no prepared heavyweight model/runtime assets. The full
model-bearing build was attempted and is blocked as reported above. MV3 tests
used an ignored code-only fixture package assembled from the production builder's
actual `SHARED_FILES`, extension directory and manifest:

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

The existing extension fixture copies this package into its owned temporary
directory, supplies controlled model Workers/manifests, and loads it in Chromium.
This establishes code packaging and MV3 integration, not successful full model
distribution packaging. Model assets were not downloaded for this rendering and
processing change. Real-model inference, actual audio capture, native UI and
physical-device checks were not run; no native implementation was added.

No push, PR, merge or Issue comment was made. There are no changes to deployment
or publication, and no new post-merge-only verification is introduced.
