# Issue #130: meeting-summary validation

## Latest review fixes (2026-10-21)

Both processors retain separate evidence when named actors/recipients or
possessive owners differ. Reconciliation checks ordered content anchors,
explicit name/direction/ownership markers and Japanese direction/possession
particles before replacing an earlier record. Ambiguous paraphrases remain
separate; these are conservative lexical checks, not general role inference.

Japanese nominalized negatives such as `送信したことはありません` and
`承認したことはありません` remain open evidence. Classification, completion
grounding and reconciliation share the detector; the negative construction is
removed only from topic keys so it can retract the same task/status. Controlled
sequential regressions cover both processors, swapped roles in either order,
possessive owners, Japanese particles, repeated input, same-role affirmative
transitions, nominalized negative variants and affirmative controls. Faithful
controlled renderings test policy invariants, not model translation accuracy.

## Checks on the current implementation

- `npm ci`: passed; restored the missing Moonshine dependency.
- All pinned ASR, translation, optional-ASR, meeting-summary and TTS assets were
  prepared; `review-meeting-summary-assets.py` reproduced both existing model
  manifests without changes and verified the cached model bytes.
- `npm test`: **500 passed, 0 failed, 0 skipped**, including all **71**
  meeting-summary tests.
- `npm run build:extension`: **passed**, including pinned runtime/model checks.
- Focused packaged extension regressions: **94 passed, 0 failed, 0 skipped**.
  These cover graph defaults/storage/migrations, Save/retry/cache reuse,
  independent paths, ASR/translation/IfCondition, TTS display integration,
  Stop/Cancel and Live display behavior using controlled inference fixtures.
- Pinned-model packaged offline MV3 smokes: **2 passed, 0 failed, 0 skipped**.
  Each uses its actual model and packaged runtime, without inference mocks.
- `git diff --check`: passed.

After preparing the assets, reproduce the checks with:

```sh
npm test
npm run build:extension
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-meeting-summary.spec.js tests/extension/graph.spec.js \
  tests/extension/graph-if-condition.spec.js tests/extension/live-text.spec.js \
  tests/extension/windowed-translation.spec.js tests/extension/graph-whisper.spec.js \
  tests/extension/graph-zipformer.spec.js tests/extension/graph-optional-asr.spec.js \
  tests/extension/translategemma.spec.js tests/extension/translation.spec.js \
  tests/extension/graph-concurrent.spec.js tests/extension/graph-models.spec.js \
  --output=test-results/review-fixes-130-regressions
MEETING_SUMMARY_SMOKE=1 npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-meeting-summary-smoke.spec.js \
  --output=test-results/review-fixes-130-real
```

## Current real-inference recordings

Completed at `2026-10-21T11:53:46.789Z` (LFM) and
`2026-10-21T11:55:32.520Z` (Qwen). Full outputs, factual assertions, Worker replies,
runtime pins and process observations are in the
[LFM recording](meeting-summary-lfm2-130-roles-negation.json) and
[Qwen recording](meeting-summary-qwen35-130-roles-negation.json).

Both recordings match the three current implementation source/package SHA-256
values below. The smoke compares packaged Worker/policy/Node bytes to source
before inference; the hashes were checked again before saving the recordings.
The unchanged test fixture hash is included for reproduction.

| File | SHA-256 |
| --- | --- |
| `web/meeting-summary-worker.js` | `667c64884a5000767020de23fc4f566882829e56cc179ec5473e60e32ddc1793` |
| `web/meeting-summary-policy.js` | `a25fffb7f58537541f569b446c56eddd8eac901bf920b81b1c28687cb7a2e190` |
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
| Worker initialization | 1.461 s | 2.186 s |
| Start to active | 1.841 s | 2.334 s |
| First decoded token, first update | 0.778 s | 0.926 s |
| First generation | 1.320 s | 1.953 s |
| Second generation | 0.504 s | 1.334 s |
| Stop tail generation | 0.348 s | 0.699 s |
| First update including batch wait | 30.976 s | 31.843 s |
| Second update including batch wait | 30.518 s | 31.344 s |
| Stop tail observed latency | 0.398 s | 0.751 s |
| Highest sampled sum of owned Chrome process RSS | 3389 MiB | 4444 MiB |

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

Actual-model fixtures are in `tests/fixtures/meeting-summary.js`. The newly
reviewed swapped-role/possessive and nominalized-negation variants, along with
interrogatives, large batches, overflow and unchanged output, use controlled
renderings in deterministic tests. The real-inference fixture tests negative
venue approval, not general accuracy on every such linguistic construction.
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
their recorded source hashes. In particular, the earlier `*-130-questions.json`
recordings with policy `66ca1cf…` do not validate the current policy above.
