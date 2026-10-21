# Issue #130: status reconciliation and current packaged inference evidence

## Review fixes (2026-10-21)

Numeric corrections now reconcile approval/completion as well as quantities. For
example, an approved 900-yen pilot followed by “Correction: we have not approved
the pilot budget of 800 yen, not 900” becomes an open, unapproved 800-yen item.
The obsolete-number clause no longer negates an otherwise affirmative status.
Corrections that make a fact conditional or proposed retain that uncertainty
instead of patching a new number into the old confirmed sentence.

Clear same-subject status assertions replace pending/approved or sent/unsent
records in either direction without requiring a correction keyword. Matching
checks the status predicate as well as the subject, so sending an approved draft
remains a separate action. Questions, conditions and independent future tasks
remain separate evidence. Unrelated or tied subject matches remain conservative.

Four new parameterized tests cover both processors, English/Japanese output,
English/Japanese evidence, sequential transitions, numeric status corrections,
uncertainty, transactionality and unrelated-action safeguards. These controlled
renderings verify deterministic policy behavior, not model translation accuracy.

## Reproduction and checks

Run from the repository root with Node/npm, Python 3 and Playwright Chromium
installed. No model/runtime pins were changed by asset preparation.

```sh
npm run setup:extension
python3 scripts/review-meeting-summary-assets.py
npm test
npm run test:browser -- --project=chromium --workers=1 --output=test-results/browser-130
npm run test:extension -- --output=test-results/extension-130
npm run test:meeting-summary-real -- --output=test-results/summary-130
```

- `setup:extension`: passed, including pinned asset preparation, runtime integrity
  checks and `build:extension`; the missing-assets build blocker is resolved.
- Asset review/download: both existing manifests reproduced without a diff;
  748,958,502 LFM bytes and 1,402,859,425 Qwen bytes verified locally.
- `npm test`: **468 passed**, including **39 meeting-summary tests**.
- Chromium browser suite: **119 passed, 9 skipped** (opt-in inference/benchmark
  tests). WebKit was not rerun.
- Packaged extension suite: **172 passed, 16 skipped**, covering graph storage,
  pipeline/ASR, translation, IfCondition, TTS, asset preparation and lifecycle
  regressions. Heavy inference tests remain opt-in; the two meeting-summary
  skips are superseded by the explicit actual-model run below.
- Both real-model MV3 smokes: **2 passed**, with all existing factual assertions
  retained. The final implementation was exercised, not historical built code.
- `git diff --check`: passed.

## Fresh actual-model runs

Completed at 2026-10-21 05:14 UTC (LFM) and 05:16 UTC (Qwen), on macOS arm64,
Apple M4 Max / Metal, Playwright 1.63.0 Chromium 153.0.0.0, with cross-origin
isolation and 16 reported logical cores. The runtime is the isolated packaged
Transformers.js 4.2.0 / ORT 1.26.0-dev.20260416-b7804b056c WebGPU q4f16 path.

| Model | Immutable revision | Prepared bytes |
| --- | --- | ---: |
| LiquidAI/LFM2.5-1.2B-JP-202606-ONNX | `01b5a0a33d22253d5ee52b367d2375eeb113b7cd` | 748,958,502 |
| onnx-community/Qwen3.5-2B-ONNX-OPT | `ed446636739bf426e73c5a00714fd8e010d36c21` | 1,402,859,425 |

Full outputs, runtime pins, Worker replies, source hashes, timings and process
observations are saved in [LFM evidence](meeting-summary-lfm2-130-status.json)
and [Qwen evidence](meeting-summary-qwen35-130-status.json). Both report policy
SHA-256 `bbabb38ce6c81ff7cb62fd8237c74bff2b256a52326eeca1930a695b791b9eb3`.
The smoke compares packaged Worker/policy/Node bytes to source before running;
the evidence hashes were checked again against the final source files.

Each test selects/saves/reloads its production graph, verifies both palette
entries, downloads the exact pinned model bytes from loopback during Save,
checks cache reuse on a second Save, and reloads the saved graph. A controllable
committed TEXT producer supplies the three English/Japanese fixture batches;
Model inference uses actual owned Workers, packaged runtimes and the real Live
display, without inference mocks.
The entire context is offline before Start. Each real model emits nonempty
Japanese snapshots to `LiveTextDisplay.replace`, performs a second update,
and drains the third accepted batch on graceful Stop. Both preserve the final
snapshot and release all owned Workers. A fresh session clears the note; Cancel
on its first actual decoded token releases the Worker with no result or late
Live write. Both observed **zero HTTP requests after Start**, **zero recorder CSP
violations**, and **zero console errors**. This tests summaries, not ASR accuracy.

| Measurement | LFM | Qwen |
| --- | ---: | ---: |
| Worker initialization | 1.349 s | 2.268 s |
| Start to active | 1.829 s | 2.325 s |
| First decoded token, first update | 0.793 s | 1.077 s |
| First generation | 1.335 s | 2.165 s |
| Second generation | 0.514 s | 1.394 s |
| Stop tail generation | 0.347 s | 0.708 s |
| First update including batch wait | 30.871 s | 32.106 s |
| Second update including batch wait | 30.533 s | 31.414 s |
| Stop tail observed latency | 0.382 s | 0.746 s |
| Highest sampled sum of owned Chrome process RSS | 3370 MiB | 4701 MiB |

Other regression suites were running on the host during these smokes, so these
are observations, not isolated performance benchmarks or latency guarantees.
RSS includes browser, renderer and GPU processes and can double-count shared
pages; it is not isolated model allocation or measured peak memory. Process CPU
times are recorded, but utilization, GPU kernel load, free VRAM and peak GPU
allocation were not measured. Concurrent summary-model inference was not tested;
each instance requires its own weights and working memory.

All per-batch factual checks pass: the initial pilot is a proposal, its corrected
250,000-yen budget becomes approved, venue approval remains pending, invitations
stay open until explicitly reported sent, and accessibility ownership stays
unknown. No recorded invented names or completed administrative work recur.

Final LFM snapshot:

```text
議論の要点
- 【提案】【担当者不明】Mika: 誰かがアクセシビリティを確認すべきですが、誰が担当するかは分かりません。
決定事項
- Ken: 承認済み。11月12日に予算250,000円でパイロットを開始することを決定しました。
完了事項
- ミカ: 招待状は送信済みです。
未解決の質問・対応事項
- Ken: 私たちはまだ承認が必要です。（承認待ち）
- ケン: 私たちはパイロットではなく、会場の承認をまだ必要としています。 会場はまだ承認されていません。（承認待ち）
- 【担当者不明】ケン: アクセシビリティの確認担当者は不明です。
```

Final Qwen snapshot:

```text
議論の要点
- 【提案】【担当者不明】Mika: 誰かがアクセシビリティを確認してください。誰か分かりません。
決定事項
- Ken: 承認されました。11 月 12 日に 25 万円でのパイロット事業を開始することになりました。
完了事項
- ミカ: 招待状は送信済みです。
未解決の質問・対応事項
- Ken: まだ承認が必要です。（承認待ち）
- ケン: 会場への承認は必要ですが、パイロットへの承認は不要です。 会場はまだ未承認です。（承認待ち）
- 【担当者不明】ケン: アクセシビリティの確認担当者は不明です。
```

## Boundaries and limitations

The deterministic review regressions use controlled faithful renderings. The
actual-model fixture is `tests/fixtures/meeting-summary.js`; it establishes
local inference and fixture-specific factual/lifecycle behavior, not general
semantic accuracy or subjective quality. The new outputs retain an unspecified
“still need approval” item and repeated accessibility evidence across sections;
Qwen renders the initial accessibility suggestion awkwardly as a request.
Lexical reconciliation intentionally retains ambiguous subjects instead of
guessing which old fact to remove. It can miss paraphrases, conflate similar
subjects, leave duplicate or stale evidence, or misclassify unfamiliar wording.
Models can omit/mistranslate facts or follow hostile text. Bounded history
eviction can lose earlier facts. Keep the transcript and verify AI drafts.

English model output, arbitrary long meetings, simultaneous heavy models and
other hardware were not newly measured. Heavy inference smokes for unrelated
ASR/translation/IfCondition/TTS models remain opt-in and were not rerun; their
unit and available browser/extension regressions were run. No human quality
result, automatic winner or default preference is asserted. No deployment-only
or required post-merge verification was discovered.

Earlier [LFM](meeting-summary-lfm2-130-reconciled.json) and
[Qwen](meeting-summary-qwen35-130-reconciled.json) recordings are historical and
are superseded for current-source validation by the fresh status-run evidence.
