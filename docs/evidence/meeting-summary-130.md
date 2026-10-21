# Issue #130: meeting-summary validation

## Prospective-action review fix (2026-10-21)

Readiness and expected/scheduled actions remain open evidence. Plans remain
proposals, including a plan contingent on a venue being approved; the embedded
approval does not establish a confirmed decision. Classification and completion
grounding share prospective-status checks, so a rendering that drops readiness
or expectation and claims completed work is rejected. Affirmative completion
and established decisions authorizing future actions still work.

Controlled English/Japanese renderings exercise both processors, repeated
inputs, a later genuine completion, and affirmative controls. They also retain
the embedded-question, actor-scope and Japanese-negation regressions. These
checks isolate deterministic policy behavior from model accuracy.

- Meeting-summary tests: **77 passed, 0 failed, 0 skipped**.
- `npm ci`: passed; restored the missing dependency.
- `npm test`: **506 passed, 0 failed, 0 skipped**.
- All pinned ASR, translation, optional-ASR, meeting-summary and TTS assets were
  prepared. Supporting GitHub archive downloads initially stalled; the same
  pinned bytes were fetched with curl, verified and successfully staged.
  `review-meeting-summary-assets.py` verified both model caches and reproduced
  both tracked manifests without changes.
- `npm run build:extension`: **passed**, including pinned runtime/model checks.
- Focused packaged extension regressions: **94 passed, 0 failed, 0 skipped**.
  They cover graph defaults/storage/migrations, Save/retry/cache reuse,
  independent paths, ASR/translation/IfCondition, TTS display integration,
  Stop/Cancel and Live display behavior using controlled inference fixtures.
- Pinned-model packaged offline MV3 smokes: **2 passed, 0 failed, 0 skipped**.
  Both use actual pinned models and packaged runtimes without inference mocks.
  Their recorded policy, Worker and Node hashes match the final source and build.
- `git diff --check`: passed.

Prepare dependencies, packaged assets and the verified model cache, then reproduce:

```sh
npm run setup:extension
python3 scripts/review-meeting-summary-assets.py
npm test
npm run build:extension
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-meeting-summary.spec.js tests/extension/graph.spec.js \
  tests/extension/graph-if-condition.spec.js tests/extension/live-text.spec.js \
  tests/extension/windowed-translation.spec.js tests/extension/graph-whisper.spec.js \
  tests/extension/graph-zipformer.spec.js tests/extension/graph-optional-asr.spec.js \
  tests/extension/translategemma.spec.js tests/extension/translation.spec.js \
  tests/extension/graph-concurrent.spec.js tests/extension/graph-models.spec.js \
  --output=test-results/prospective-130-regressions
MEETING_SUMMARY_SMOKE=1 npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-meeting-summary-smoke.spec.js \
  --output=test-results/prospective-130-real
```

## Real-inference recordings for the final implementation

Completed at `2026-10-21T12:31:22.474Z` (LFM) and
`2026-10-21T12:33:08.440Z` (Qwen). Full outputs, factual assertions, Worker replies,
runtime pins and process observations are in the
[LFM recording](meeting-summary-lfm2-130-prospective.json) and
[Qwen recording](meeting-summary-qwen35-130-prospective.json).

Both recordings match the three recorded implementation source/package SHA-256
values below. The smoke compares packaged Worker/policy/Node bytes to source
before inference; the hashes were checked again before saving the recordings.
The unchanged test fixture hash is included for reproduction.

| File | SHA-256 |
| --- | --- |
| `web/meeting-summary-worker.js` | `667c64884a5000767020de23fc4f566882829e56cc179ec5473e60e32ddc1793` |
| `web/meeting-summary-policy.js` | `5928f1648d661077f599c7f399dc7219fcbcd2d2ebdd21ae6f8d609283bc82c6` |
| `web/meeting-summary-node.js` | `1b2a3c52b35dead5176d7f61423eab6b94523f02f8fda6c23e3082f36bdb76f5` |
| `tests/fixtures/meeting-summary.js` | `74e0ab32d91991127f4457fe8706f8c2265dd61e2e9af7a4b7f7f5839ed123e7` |

| Model | Immutable revision | Prepared bytes |
| --- | --- | ---: |
| LiquidAI/LFM2.5-1.2B-JP-202606-ONNX | `01b5a0a33d22253d5ee52b367d2375eeb113b7cd` | 748,958,502 |
| onnx-community/Qwen3.5-2B-ONNX-OPT | `ed446636739bf426e73c5a00714fd8e010d36c21` | 1,402,859,425 |

Environment: macOS `arm64`, Apple M4 Max / Metal, Playwright 1.63.0
Chromium 153.0.0.0, cross-origin isolated, 16
reported logical cores. Both models use WebGPU q4f16 with isolated packaged
Transformers.js 4.2.0 / ONNX Runtime Web 1.26.0-dev.20260416-b7804b056c.

Each smoke verifies both palette entries, saves its graph, prepares the exact
pinned model from loopback, verifies cache reuse on a second Save and reloads the
saved graph. A controllable committed TEXT producer supplies English/Japanese
meeting evidence; production owned Workers, verified model cache, packaged
runtime and real `LiveTextDisplay.replace` handle generation and display.
The browser context is offline before Start. No model or executable downloads
occur during inference.

Each produces a nonempty Japanese snapshot, a second update, then a third
snapshot draining accepted input on graceful Stop. The final note stays visible
and owned Workers are released. A fresh session clears context; Cancel on its
first actual decoded token terminates the Worker without a result or late Live
write. The independent transcript display retains all three batches. Both runs
observed **zero HTTP requests after Start**, **zero recorder CSP violations**
and **zero console errors**. All factual assertions passed: proposal/decision
separation, corrected budget, pending venue approval, unknown accessibility
owner and invitations transitioning from pending to completed.

| Measurement | LFM | Qwen |
| --- | ---: | ---: |
| Worker initialization | 1.243 s | 2.174 s |
| Start to active | 1.325 s | 2.327 s |
| First decoded token, first update | 0.765 s | 0.928 s |
| First generation | 1.300 s | 1.952 s |
| Second generation | 0.497 s | 1.346 s |
| Stop tail generation | 0.346 s | 0.726 s |
| First update including batch wait | 31.263 s | 31.803 s |
| Second update including batch wait | 30.514 s | 31.364 s |
| Stop tail observed latency | 0.382 s | 0.763 s |
| Highest sampled sum of owned Chrome process RSS | 3330 MiB | 4609 MiB |

Extension regressions finished before these sequential inference runs. These
are observations, not isolated benchmarks or latency guarantees. RSS includes
browser, renderer and GPU processes and can double-count shared pages; it is
neither isolated model memory nor a measured peak. Process CPU times are
recorded; CPU utilization, GPU kernel load, free VRAM and peak GPU allocation
were not measured.

Final LFM snapshot:

```text
議論の要点
- 【提案】Mika: 私たちは11月12日に予算250000円でパイロットを開始できる可能性があります。これは提案に過ぎません。
- 【提案】【担当者不明】Mika: 誰かがアクセシビリティを確認すべきですが、誰が担当するかは分かりません。
決定事項
- Ken: 承認済み。11月12日に予算250,000円でパイロットを開始することを決定しました。
完了事項
- Mika: 招待状は送信済みです。
未解決の質問・対応事項
- Ken: 私たちはまだ承認が必要です。（承認待ち）
- Ken: 私たちはパイロットではなく、会場の承認をまだ必要としています。（承認待ち）
- Ken: 会場は承認済みではありません。
- 【担当者不明】Ken: アクセシビリティの確認担当者は不明です。
```

Final Qwen snapshot:

```text
議論の要点
- 【提案】Mika: 11 月 12 日にパイロットプロジェクトを立ち上げ、予算 250000円です。これは提案です。
- 【提案】【担当者不明】Mika: 誰かがアクセシビリティを確認してください。誰か分かりません。
決定事項
- Ken: 承認されました。11 月 12 日に 25 万円でのパイロット事業を開始することになりました。
完了事項
- Mika: 招待状は送信済みです。
未解決の質問・対応事項
- Ken: まだ承認が必要です。（承認待ち）
- Ken: 会場への承認は必要ですが、パイロットへの承認は不要です。（承認待ち）
- Ken: 会場は承認済みではありません。
- 【担当者不明】Ken: アクセシビリティの確認担当者は不明です。
```

## Boundaries and limitations

Actual-model fixtures are in `tests/fixtures/meeting-summary.js`. Readiness,
expectations, plans, swapped-role/possessive and nominalized-negation variants,
along with embedded questions, large batches, overflow and unchanged output, use controlled
renderings in deterministic tests. The new prospective-status cases were not
added to the actual-model fixture; their classification/grounding regressions
isolate policy behavior from model translation accuracy. The real-inference
fixture tests negative venue approval, not general accuracy on every such
linguistic construction.
These smokes exercise summaries, not ASR accuracy; all actual-model batches
remain below the 2,000-code-unit trigger.

Both final notes retain Mika's corrected proposal separately from Ken's
decision, an unspecified approval item and repeated accessibility evidence.
The conservative guard keeps these instead of guessing which record to remove.
Qwen renders the accessibility suggestion awkwardly as a request. Lexical checks
can retain stale/duplicate items, miss paraphrases or conflate topics; models
can omit/mistranslate evidence or follow hostile text. Bounded compression can
lose earlier facts. Keep and verify the transcript.

English actual-model output, arbitrary long meetings, simultaneous heavy models
and other hardware were not newly measured. Each concurrent instance owns
separate weights and working memory; these runs do not establish safe concurrent
memory limits. Heavy real-inference smokes for unrelated ASR/translation/
IfCondition/TTS models were not rerun; their unit and controlled graph checks
passed and do not establish actual-model accuracy. No human quality result,
automatic winner or default preference is asserted. No deployment-only or
required post-merge verification was discovered.

Other existing JSON recordings in this directory are historical and verify only
their recorded source hashes. The earlier `*-130-roles-negation.json` recordings
use policy `a25fffb7…`; only the new `*-130-prospective.json` recordings validate
the final policy bytes. No executable source changed after these recordings.
