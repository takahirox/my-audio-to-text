# Issue #130: meeting-summary validation

## Batch-boundary correction (2026-10-21)

The Node now packs whole committed fragments instead of cutting at exactly
2,000 code units. An oversized fragment remains intact for the Worker's existing
sentence/speaker segmentation, so negation and conditional context survive the
batching threshold. The 32,768-code-unit active-plus-pending cap remains enforced;
token, output, note and generation-time budgets are unchanged. Evidence that
cannot fit those budgets fails explicitly rather than being truncated.

Deterministic regressions cover both processors with English/Japanese evidence,
the review's `We have not approved the venue.` reproduction, conditional claims,
oversized fragments and single long sentences. Faithful controlled renderings
run through production reconciliation and verify that the final snapshot has no
confirmed decision or completed task. An additional regression verifies that
oversized in-flight evidence counts toward overflow and that Stop drains the
accepted tail. These checks test batching/state invariants, not model quality.

Current-source validation after the batching fix: `npm ci`, all seven asset
preparation scripts, `build:extension`, all **478 unit tests** (including **49
meeting-summary tests**), Chromium regressions and both actual pinned-model
smokes passed. Packaged extension regression results are recorded below. The
new inference recordings verify the Worker, policy and Node bytes from reviewed
checkpoint `2fd805516be470f9470d07e219c26635887747db`; only evidence files changed
during this validation. Earlier recordings are historical. No model pins,
runtime pins, production code or factual smoke assertions changed.

## Attribution/subject review fixes (2026-10-21)

Reaffirmations from different speakers remain separate records. For example,
`Alice: I approved the pilot on November 12.` followed by
`Bob: The pilot is approved.` retains Alice's first-person statement under Alice
and Bob's statement under Bob. Unlabelled reaffirmations also cannot take over
an earlier speaker's words. Same-speaker repetitions still deduplicate.

Ordinary record matching now compares both keyword sets instead of dividing by
the smaller set. `The report has been sent.` and
`The report appendix has not been sent.` remain separate completed/open records
in either arrival order. Approval transitions receive the same protection.
Pending/yet are status modifiers rather than subject words. Shorter statements
with omitted scope remain separate and retain earlier dates/budgets. Explicit
numeric corrections still permit partial matching, with quantity/date checks
before patching the existing record.

Four new parameterized tests cover both processors, English/Japanese rendering,
English/Japanese evidence, labelled/unlabelled speakers, repetitions, subject
scope in both orders, and unchanged prior records. Existing reaffirmation tests
now expect separate records when subject equivalence is unclear. These tests use
controlled faithful renderings to verify policy, not model quality.

## Reproduction and checks

Run from the repository root with Node/npm, Python 3 and Playwright Chromium
installed. Runtime/model pins were unchanged by preparation.

```sh
npm run setup:extension
python3 scripts/review-meeting-summary-assets.py
npm test
npm run test:browser -- --project=chromium --workers=1 --output=test-results/browser-130
npm run test:extension -- --output=test-results/extension-130
npm run test:meeting-summary-real -- --output=test-results/summary-130
```

- `npm ci`, all seven asset preparation scripts and `build:extension`: passed.
  Missing dependencies/assets no longer block checks.
- Asset review/download: existing manifests reproduced without a diff;
  748,958,502 LFM bytes and 1,402,859,425 Qwen bytes verified locally.
- `npm test`: **478 passed**, including **49 meeting-summary tests**.
- Chromium browser suite: **119 passed, 9 skipped** (opt-in inference/benchmark
  tests). Port 8000 was already occupied; a temporary configuration
  importing the repository configuration used port 8127 for this worktree's
  unchanged PagesHandler server/base URL and the repository root as its server
  working directory. Repository-prefix coverage remained enabled. No
  unrelated server was stopped. WebKit was not rerun.
- Packaged extension suite: **172 passed, 16 skipped**, covering graph storage,
  pipeline/ASR, translation, IfCondition, TTS, asset preparation and lifecycle.
  Heavy model inference tests remain opt-in.
- Both actual pinned-model offline MV3 smokes: **2 passed**; all factual assertions
  retained. The packaged Worker, policy and Node matched current source bytes.
- `git diff --check`: passed.

## Fresh actual-model runs

Completed at 2026-10-21 09:44 UTC (LFM) and 09:46 UTC (Qwen), on macOS arm64,
Apple M4 Max / Metal, Playwright 1.63.0 Chromium 153.0.0.0, cross-origin isolated,
with 16 reported logical cores. The isolated packaged runtime is Transformers.js
4.2.0 / ORT 1.26.0-dev.20260416-b7804b056c, WebGPU q4f16.

| Model | Immutable revision | Prepared bytes |
| --- | --- | ---: |
| LiquidAI/LFM2.5-1.2B-JP-202606-ONNX | `01b5a0a33d22253d5ee52b367d2375eeb113b7cd` | 748,958,502 |
| onnx-community/Qwen3.5-2B-ONNX-OPT | `ed446636739bf426e73c5a00714fd8e010d36c21` | 1,402,859,425 |

Full per-batch outputs, Worker replies, runtime pins, hashes, timings and process
observations are saved in [LFM evidence](meeting-summary-lfm2-130-batching.json)
and [Qwen evidence](meeting-summary-qwen35-130-batching.json).
Both report these current-source SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `web/meeting-summary-worker.js` | `667c64884a5000767020de23fc4f566882829e56cc179ec5473e60e32ddc1793` |
| `web/meeting-summary-policy.js` | `5f8d9f642e64b5cddaa269c8a1009d78d27269820a8843ae6e91d55e4ab8f732` |
| `web/meeting-summary-node.js` | `1b2a3c52b35dead5176d7f61423eab6b94523f02f8fda6c23e3082f36bdb76f5` |

The smoke compared packaged Worker/policy/Node bytes to source before running;
all three evidence hashes were verified against source again before recording.
All earlier recordings, including `*-130-attribution-scope.json` (policy
`480a6b9b…`), are historical and do not verify this batching revision.

Each test verifies both palette entries, saves its production graph, prepares the
exact pinned model from loopback, checks cache reuse on a second Save and reloads
the saved graph. A controllable committed TEXT producer supplies the three
English/Japanese fixture batches. Actual owned Workers, packaged runtimes,
verified cache and real `LiveTextDisplay.replace` handle inference and output;
there are no model/inference mocks. This tests summaries, not ASR accuracy.

The browser context is offline before Start. Each model emits a nonempty Japanese
snapshot, updates it on a second batch and drains the third accepted batch on
Stop. The final snapshot remains visible and all owned Workers are released.
A fresh session clears prior context; Cancel on its first actual decoded token
terminates the Worker with no result or late Live write. Both observed **zero
HTTP requests after Start**, **zero recorder CSP violations** and **zero console
errors**.

| Measurement | LFM | Qwen |
| --- | ---: | ---: |
| Worker initialization | 1.425 s | 2.787 s |
| Start to active | 1.829 s | 2.839 s |
| First decoded token, first update | 1.052 s | 1.312 s |
| First generation | 1.668 s | 2.541 s |
| Second generation | 0.635 s | 2.064 s |
| Stop tail generation | 0.364 s | 1.179 s |
| First update including batch wait | 31.191 s | 32.539 s |
| Second update including batch wait | 30.664 s | 32.097 s |
| Stop tail observed latency | 0.423 s | 1.274 s |
| Highest sampled sum of owned Chrome process RSS | 3069 MiB | 4066 MiB |

Extension regressions ran concurrently on the host; these are observations,
not isolated benchmarks or latency guarantees. RSS includes browser, renderer and
GPU processes and can double-count shared pages. It is not isolated model memory
or a measured peak. Process CPU times are recorded; utilization, GPU kernel load,
free VRAM and peak GPU allocation were not measured. Concurrent summary-model
inference was not tested; instances own separate weights/working memory.

All per-batch factual checks pass: the initial pilot remains a proposal, its
corrected 250,000-yen budget becomes approved, venue approval stays pending,
invitations remain open until reported sent, and accessibility ownership remains
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
- Ken: 私たちはパイロットではなく、会場の承認をまだ必要としています。（承認待ち）
- ケン: 会場はまだ承認されていません。（承認待ち）
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
- Ken: 会場への承認は必要ですが、パイロットへの承認は不要です。（承認待ち）
- ケン: 会場はまだ未承認です。（承認待ち）
- 【担当者不明】ケン: アクセシビリティの確認担当者は不明です。
```

## Boundaries and limitations

Actual-model fixtures are in `tests/fixtures/meeting-summary.js`; the
batch-boundary and attribution/subject regressions use controlled faithful
renderings. Actual-model batches are below the 2,000-code-unit trigger; oversized
fragments, conditional/negative claims at the boundary and overflow are covered
by deterministic tests, not additional actual-model boundary fixtures. Together
they verify current-source local inference, lifecycle and fixture-specific behavior,
not general semantic accuracy or subjective quality. Both outputs retain an
unspecified approval item and repeated accessibility evidence. Preserving
separate speaker labels now also retains separate Ken/ケン venue evidence; Qwen
renders the accessibility suggestion awkwardly as a request. Conservative scope
matching can retain shorter duplicate or stale statements rather than guessing
which fact to replace. Lexical checks can miss paraphrases, misclassify unfamiliar
wording or conflate topics; models can omit/mistranslate facts or follow hostile
text. Bounded eviction can lose earlier facts. Keep and verify the transcript.

English actual-model output, arbitrary long meetings, simultaneous heavy models
and other hardware were not newly measured. Heavy real-inference smokes for
unrelated ASR/translation/IfCondition/TTS models remain opt-in and were not rerun;
their available unit/browser/extension regressions were run. The meeting-summary
skips in the general extension suite are superseded by the two explicit real
smokes above. No human quality result, automatic winner or default preference is
asserted. No deployment-only or required post-merge verification was discovered.
