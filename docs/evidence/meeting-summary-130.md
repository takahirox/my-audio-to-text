# Issue #130: meeting-summary validation

## Current review fixes (2026-10-21)

Japanese interrogatives such as `招待状を送信しましたか。` and
`会場は承認されましたか。` now remain unresolved evidence even without a
question mark. Classification, completion grounding and reconciliation share
the same detector, including plain/polite endings, `かな`, `かしら`, `かね` and
`かどうか`. Questions cannot establish completion/approval, replace pending
work or retract established facts. A question phrased as a numeric correction
also cannot patch earlier quantities. Exact repeated questions deduplicate.

Both processors have sequential controlled regressions for pending and confirmed
states followed by questions, repeated questions, numeric-correction questions,
and rejection of a translation that invents completion from a question.
Affirmative and `かもしれません` proposal controls retain their respective states.

Japanese copular negatives, including `承認済みではありません` and
`送信済みではありません`, now keep assertions in open work. When the same
identified speaker retracts an earlier affirmative statement, the negative
replaces it instead of merging contradictory text under decisions/completed
work. The controlled review reproduction classified these statements as
confirmed/completed on the reviewed baseline; both now classify as open.

Both processors have regressions for initial negatives and subsequent
retractions across approval, decision, agreement, sending and completion, with
polite, plain, past and colloquial negative forms. Faithful controlled renderings
isolate policy behavior from model accuracy. Input record arrays are not mutated.

The three-batch acceptance fixture now keeps speaker labels `Mika` and `Ken`
identical across English/Japanese speech. It no longer assumes that `Mika` and
`ミカ` establish the same actor. Separate regressions verify that these different
labels retain independent actions/corrections. The final Japanese batch includes
`会場は承認済みではありません` and repeats it; factual checks require an open
venue item and exclude the venue from confirmed decisions. A controlled replay
of all three batches passes every factual assertion for each processor, including
replacement of Mika's pending invitations with Mika's reported completion.

## Validation

- `npm run setup:extension`: passed, including `npm ci`, all seven asset
  preparation scripts and the production extension build.
- `python3 scripts/review-meeting-summary-assets.py`: passed; both immutable
  model downloads verified and generated manifests were unchanged.
- `npm test`: **492 passed**, including **63 meeting-summary tests**.
- Focused packaged MV3 regressions below: **34 passed**.
- Actual pinned-model offline MV3 smokes below: **2 passed**; all per-batch
  factual assertions passed for both models.
- `git diff --check`: passed.

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-meeting-summary.spec.js tests/extension/graph.spec.js \
  tests/extension/graph-if-condition.spec.js tests/extension/live-text.spec.js \
  tests/extension/windowed-translation.spec.js \
  --output=test-results/questions-130-regressions

MEETING_SUMMARY_SMOKE=1 npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-meeting-summary-smoke.spec.js \
  --output=test-results/questions-130
```

## Fresh actual-model evidence

Completed at `2026-10-21T11:16:20.407Z` (LFM) and `2026-10-21T11:18:07.215Z` (Qwen), on macOS arm64,
Apple M4 Max / Metal, Playwright 1.63.0 Chromium 153.0.0.0, cross-origin isolated,
with 16 reported logical cores. Both use WebGPU q4f16 and the isolated packaged
Transformers.js 4.2.0 / ONNX Runtime Web 1.26.0-dev.20260416-b7804b056c.

| Model | Immutable revision | Prepared bytes |
| --- | --- | ---: |
| LiquidAI/LFM2.5-1.2B-JP-202606-ONNX | `01b5a0a33d22253d5ee52b367d2375eeb113b7cd` | 748,958,502 |
| onnx-community/Qwen3.5-2B-ONNX-OPT | `ed446636739bf426e73c5a00714fd8e010d36c21` | 1,402,859,425 |

Full outputs, factual checks, Worker replies, runtime pins, timings and process
observations are saved in [LFM evidence](meeting-summary-lfm2-130-questions.json)
and [Qwen evidence](meeting-summary-qwen35-130-questions.json). Both recordings
report these final implementation SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `web/meeting-summary-worker.js` | `667c64884a5000767020de23fc4f566882829e56cc179ec5473e60e32ddc1793` |
| `web/meeting-summary-policy.js` | `66ca1cf626b9b95d7e1e093b4332d6831a911c114139a11a457dd0f468a9bc4d` |
| `web/meeting-summary-node.js` | `1b2a3c52b35dead5176d7f61423eab6b94523f02f8fda6c23e3082f36bdb76f5` |
| `tests/fixtures/meeting-summary.js` (fixture used by both runs) | `74e0ab32d91991127f4457fe8706f8c2265dd61e2e9af7a4b7f7f5839ed123e7` |

The smoke compared packaged Worker/policy/Node bytes to source before inference;
both recordings' hashes were verified against source and the package again
before saving these results. All earlier recordings, including `*-130-negation.json`
(policy `e6244ef0…`) and `*-130-batching.json` (policy `5f8d9f64…`), are historical
and do not verify the final policy. These fresh runs also supersede the validation
gap for the previously reviewed policy `912f60e2…`.

Each test verifies both palette entries, saves its production graph, prepares
its exact pinned model from loopback, checks cache reuse on a second Save and
reloads the saved graph. A controllable committed TEXT producer supplies the
English/Japanese batches; actual owned Workers, packaged runtimes, verified
cache and real `LiveTextDisplay.replace` perform inference and display updates.
There are no model/inference mocks. The browser context is offline before Start.

Each model produces a nonempty Japanese snapshot, updates it with the second
batch and drains the third accepted batch on graceful Stop. The final note stays
visible and all owned Workers are released. A fresh session clears context;
Cancel on its first actual decoded token terminates the Worker without a result
or late Live write. Both runs observed **zero HTTP requests after Start**,
**zero recorder CSP violations** and **zero console errors**.

All factual assertions pass: the pilot starts as a proposal, its corrected
250,000-yen budget is approved, the negated venue approval remains open,
invitations remain pending until reported sent and accessibility ownership
remains unknown. The final open section contains no stale invitations task.

| Measurement | LFM | Qwen |
| --- | ---: | ---: |
| Worker initialization | 1.542 s | 2.572 s |
| Start to active | 1.826 s | 2.834 s |
| First decoded token, first update | 0.802 s | 0.973 s |
| First generation | 1.342 s | 2.001 s |
| Second generation | 0.507 s | 1.324 s |
| Stop tail generation | 0.340 s | 0.717 s |
| First update including batch wait | 31.090 s | 31.788 s |
| Second update including batch wait | 30.528 s | 31.347 s |
| Stop tail observed latency | 0.383 s | 0.770 s |
| Highest sampled sum of owned Chrome process RSS | 2856 MiB | 3733 MiB |

Focused extension regressions finished before these sequential inference runs.
These are observations, not isolated benchmarks or latency guarantees. RSS
includes browser, renderer and GPU processes and can double-count shared pages;
it is neither isolated model memory nor a measured peak. Process CPU times are
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

Actual-model fixtures are in `tests/fixtures/meeting-summary.js`. Japanese
interrogative variants, copular negation/retraction variants, attribution/subject
matching, batch boundaries, overflow and unchanged output use deterministic
tests with controlled faithful renderings. The actual-model fixture exercises
the negative venue statement, not the new interrogative variants; it does not
establish general interrogative, negation or translation accuracy. It tests
summaries rather than ASR accuracy. All actual-model batches are below the
2,000-code-unit trigger. Oversized evidence is covered by deterministic tests.

Both final outputs retain Mika's corrected proposal separately from Ken's
decision, an unspecified approval item, and repeated accessibility evidence.
The conservative actor/scope guard preserves these rather than guessing which
record to remove. Qwen renders the accessibility suggestion awkwardly as a
request. Lexical matching can retain stale/duplicate items, miss paraphrases or
conflate topics; models can omit/mistranslate facts or follow hostile text.
Bounded compression can lose earlier facts. Keep and verify the transcript.

English actual-model output, arbitrary long meetings, simultaneous heavy models
and other hardware were not newly measured. Each concurrent instance owns
separate weights and working memory; these runs do not establish safe concurrent
memory limits. Heavy real-inference smokes for unrelated ASR/translation/
IfCondition/TTS models were not rerun. Their unit and focused graph regressions
passed; those controlled checks do not verify their actual-model accuracy.
No human quality result, automatic winner or default preference is asserted.
No deployment-only or required post-merge verification was discovered.
