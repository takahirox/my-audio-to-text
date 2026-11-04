# TextSummary settings and generic policy (#210)

Validation date: 2026-11-04. This replaces the meeting-specific instruction and
publication heuristics, retaining the two existing pinned models and local
Worker ownership. The default instruction is `Summarize the input text.`;
structure and rolling-update behavior now come from saved `Settings.prompt`.

## Compatibility decision

Old `MeetingSummaryLfm2` / `MeetingSummaryQwen35` graph types fail explicitly on
Load and Import. The diagnostic names the corresponding new type and explains
how to add `settings.prompt` while retaining IDs, positions, language and edges.
Original JSON remains in storage and in Graph actions → Saved JSON until an
explicit Save. There is no automatic rewiring or replacement instruction.
Both backends have unit and MV3 recovery tests, including Hold feedback edges.
See the [conversion steps](../text-summary-nodes.md#existing-saved-graphs-explicit-recovery).

Model IDs, immutable revisions, asset manifest bytes/checksums, license files,
cache keys/URLs and packaged vendor directory remain unchanged. The renamed
runtime specification is byte-identical to the previous specification. No model
was added or downloaded for this validation; translation/TTS implementations and
Pipeline feedback scheduling were not modified.

## Executed checks

- `npm ci`: successful.
- `npm test`: **746 passed**, no failures or skips. Includes both summary Nodes,
  prompt types/lengths, default instruction, multiline Save/Load/JSON round trips,
  active-session settings isolation and next-session application, arbitrary text
  fixtures, single-request operation, admission limits, failures/timeouts,
  cancellation, model manifests, preparation, Hold FIFO and independent translation.
  The package unit test runs the build script against controlled pinned fixtures
  and checks copied core files and permissions; it is not a full model build.
- `npm run test:browser -- tests/browser/hold-feedback.spec.js --project=chromium`:
  **2 passed**, including Stop, Cancel/restart and independent asynchronous output.
- The MV3 command below: **19 passed, 2 real-model tests skipped**.
- `node --check` for the Worker and updated opt-in real-model smoke; Python AST
  parsing for preparation, review and build scripts; runtime-pin byte comparison;
  `git diff --check`: successful.

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-text-summary.spec.js \
  tests/extension/graph-text-summary-smoke.spec.js \
  tests/extension/graph-hold-feedback.spec.js \
  tests/extension/graph-translation-feedback.spec.js \
  tests/extension/graph-model-failures.spec.js \
  tests/extension/live-text.spec.js
```

The MV3 run used an ignored **source-only fixture distribution** at
`dist/chrome-extension`, copied from `extension/`, `web/` (excluding `vendor/`
and `tts-assets/`) and `extension/manifest.json` as the root manifest. Existing
extension fixtures replace capture/model dependencies as needed. This did not
run the full asset-backed build or prepare its missing pinned assets. To
reproduce this deterministic run without model downloads, stage that source
fixture first:

```sh
python3 - <<'PY'
from pathlib import Path
import shutil
root = Path('dist/chrome-extension')
root.mkdir(parents=True, exist_ok=True)
shutil.copytree('extension', root / 'extension', dirs_exist_ok=True)
shutil.copytree('web', root / 'web', dirs_exist_ok=True,
                ignore=shutil.ignore_patterns('vendor', 'tts-assets'))
shutil.copy2('extension/manifest.json', root / 'manifest.json')
PY
```

The summary MV3 tests run the **production module Worker, prompt policy and
cache-only loader** with a controlled tokenizer/model runtime and tiny verified
cache fixtures. For both backends they verify:

- The palette has only the two new types; each Settings prompt is a textarea.
- Multiline prompts survive Save/reload, Export/download and Import. Editing an
  unsaved draft leaves saved instructions unchanged; saving a different prompt
  changes the chat instruction for identical text.
- Article, technical, conversational and transcript inputs produce one request
  each with the exact saved prompt, short language fallback and complete quoted
  input. There are no mandatory minutes sections or meeting semantic checks.
- Inference succeeds offline without additional model requests. Chat uses greedy
  generation, disabled thinking, no truncation and a 1,024-token output cap.
- The combined budget accepts 7,168 prompt tokens and rejects 7,169. Exhausted
  output budget without EOS, empty/oversized output, invalid prompt and model
  failures return errors without a replacement summary.
- Preparation cancellation/retry and cache reuse, failed load/inference,
  Stop/Cancel/restart, late replies, literal Display rendering, sequential Hold
  feedback and translation fan-out remain operational.

These deterministic results establish settings/wiring/lifecycle behavior. They
do not establish factual accuracy, prompt adherence or performance of either
real model.

## Real-model checks not performed

`TEXT_SUMMARY_SMOKE` was unset, so both opt-in real-model tests were skipped.
Neither actual LFM2.5 JP nor Qwen3.5 inference, GPU memory use, latency, output
language/format adherence or summary accuracy was measured for this change.
No new model-quality claims are made. Historical #130/#202 output evidence
applies to previous instructions and must not be treated as validation here.

The updated opt-in suite keeps offline rolling feedback, Stop and Cancel checks
and adds independent article, technical, conversation and transcript cases plus
two different user prompts for identical article text. It records inputs,
prompts, actual outputs, timing and token metrics without requiring hidden
meeting sections. Review those outputs for accuracy and requested structure:

```sh
# Requires the existing pinned asset-backed distribution and cached model bytes;
# see ../text-summary-nodes.md for setup. This was NOT executed here.
npm run test:text-summary-real
```
