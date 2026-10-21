# Issue #130: current reconciliation and actual-model evidence

**Both reviewed factual smoke failures are resolved in this revision.** Both
actual pinned models pass all unchanged factual assertions across three sequential
English/Japanese batches in packaged offline Chrome MV3, with a real Live display,
graceful Stop and Cancel after an actual decoded token. This is fixture-specific
evidence, not a guarantee of general semantic accuracy or a model ranking.

## What changed

The old whole-note rewrite repeatedly invented names/completed work, lost approval
scope and retained corrected values. Bounded repair alone left both Live displays
empty. The Worker now renders only short new evidence excerpts and reconciles them
with a bounded previous note. Code preserves original speaker labels, proposal and
unknown-owner markers, explicit approval/completion state and numeric corrections.
A completed task replaces its matching open item without replacing a decision.
Unrelated or ambiguous topic matches are retained separately. No fixture-specific
content, model/inference mocks, replacement checkpoints or canned summaries are
used. Model/runtime revisions and integrity pins are unchanged.

Number/scale and named-weekday preservation checks reject mistranslations (including
250,000 yen becoming 250万円 or Friday becoming Saturday). Calendar translation
hints and short model-specific rendering instructions address the observed errors.
Repairs keep the evidence unchanged, place feedback in the system message and
commit no partial batch. Record/source/rendered-text bounds and lossy eviction are
described in [the processor guide](../meeting-summary-nodes.md).

## Reproduction and boundaries

After the asset preparation steps in the guide:

```sh
npm test
npm run build:extension
MEETING_SUMMARY_CHANNEL=chrome npm run test:meeting-summary-real -- --output .cache/reconciled-final-values
npm run test:extension -- --output .cache/extension-regressions
```

Recorded 2026-10-21T04:44:35.521Z / 2026-10-21T04:46:22.803Z, macOS 26.6.2/arm64,
Apple M4 Max, 64 GiB physical RAM, Google Chrome 155.0.8059.85 (headless).
The reduced browser user agent is retained in the raw evidence.
Playwright 1.63.0; cross-origin isolation and Worker WebGPU shader-f16 were active.
ANGLE used Metal / Apple M4 Max. Other browser regressions ran on the host, so
latencies are observations rather than controlled benchmarks or promised targets.

Each smoke used the production graph, owned Worker, tokenizer, packaged runtime,
exact verified model bytes and LiveTextDisplay.replace. Save fetched unchanged
pinned bytes over loopback, reused cache on a second Save, and graph reload retained
Japanese settings and wiring. Both processor options appeared in the palette.
Chrome was made offline before Start. The controllable committed TEXT producer
is the only source fixture; ASR/native capture and the other heavy inference paths
are outside this smoke. HTTP(S) requests after Start, CSP violations and console
errors were zero. No inference/runtime/model mocks were used.

Updates 1 and 2 used the normal 30-second timer. Stop drained update 3 before its
timer, retained the final snapshot and released the Worker. A new session cleared
context; Cancel was triggered on its first actual decoded token, released the
Worker and emitted no new result or Live write. This replaces a polling assertion
that could miss a subsecond generation status, while exercising real inference.

Exact built Worker/policy/Node SHA-256 hashes are included in each JSON, and the
smoke checks built bytes against source before execution. Model byte counts,
immutable revisions, runtime/file integrity pins, all outputs/factual checks,
Worker replies and process observations are in:

- [LFM current run](meeting-summary-lfm2-130-reconciled.json)
- [Qwen current run](meeting-summary-qwen35-130-reconciled.json)

## Observed results

| Measurement | LFM | Qwen |
| --- | ---: | ---: |
| Prepared model bytes | 748,958,502 | 1,402,859,425 |
| Worker initialization | 1.036 s | 2.462 s |
| Start to active | 1.325 s | 2.831 s |
| First decoded token, first update | 0.737 s | 0.945 s |
| First generation | 1.272 s | 1.981 s |
| Second generation | 0.484 s | 1.384 s |
| Stop tail generation | 0.320 s | 0.708 s |
| First update including batch wait | 31.033 s | 31.652 s |
| Second update including batch wait | 30.496 s | 31.400 s |
| Stop tail observed latency | 0.369 s | 0.747 s |
| Highest sampled sum of owned Chrome process RSS | 3646 MiB | 4390 MiB |

RSS includes browser, renderer and GPU processes and can double-count shared pages;
it is not isolated model allocation or measured peak memory. Process CPU times
are recorded, but utilization, GPU kernel load, free VRAM and peak GPU allocation
were not measured. Concurrent model instances still require their own weights and
working memory; the guide’s 4/6 GB allowances remain planning estimates.

All per-batch factual checks pass: proposal remains unapproved initially; the
250,000-yen pilot becomes approved while venue approval remains pending; Friday
invitations remain open before becoming completed; accessibility ownership stays
unknown; repetition does not invent people or completed administrative work.

Final LFM snapshot:

```text
議論の要点
- なし
決定事項
- Ken: 承認済み。11月12日に予算250,000円でパイロットを開始することを決定しました。
完了事項
- ミカ: 招待状は送信済みです。
未解決の質問・対応事項
- 【担当者不明】ケン: アクセシビリティの確認担当者は不明です。
- ケン: 会場はまだ承認されていません。（承認待ち）
```

Final Qwen snapshot:

```text
議論の要点
- なし
決定事項
- Ken: 承認されました。11 月 12 日に 25 万円でのパイロット事業を開始することになりました。
完了事項
- ミカ: 招待状は送信済みです。
未解決の質問・対応事項
- 【担当者不明】ケン: アクセシビリティの確認担当者は不明です。
- ケン: 会場はまだ未承認です。（承認待ち）
```

## Checks and limitations

- `npm test`: **456 passed**, including **27 meeting-summary tests**. Controlled
  renderings test reconciliation, ambiguity, number/weekday guards, memory bounds
  and transactional failure; they do not establish model quality.
- `npm run build:extension`: **passed**, including runtime integrity validation.
- Final actual-model offline smoke: **2 passed**; no factual assertions relaxed.
- Full extension regressions: **172 passed, 16 skipped**. Heavy inference
  smokes remain opt-in; the two summary skips are superseded by the explicit
  passing real-model run above. Other heavy inference paths were not rerun.
- `git diff --check`: **passed**.

Extraction is conservative and lexical, not general semantic verification. Models
can still mistranslate, omit detail or follow hostile text, and matching can miss
paraphrases or conflate similar subjects. Unfamiliar approval/completion phrasing
may remain in discussion rather than being promoted. Ambiguous corrections can
leave older items alongside new evidence. History eviction can omit earlier facts.
English output, arbitrary long meetings, simultaneous heavy model instances and
other hardware were not newly measured by these real-model runs. Keep the source
transcript and verify AI drafts. Subjective comparison and model preference remain
out of scope; no human acceptance result or automatic winner is asserted.

The previous failures remain available as historical diagnostics:
[LFM completion guard](meeting-summary-lfm2-130-completion-guard.json) and
[Qwen completion guard](meeting-summary-qwen35-130-completion-guard.json).
They describe the superseded whole-note implementation, not the current successful
path. No deployment-only or required post-merge verification was discovered.
