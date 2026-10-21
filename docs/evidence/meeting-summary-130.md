# Issue #130: implementation and real-model evidence

**Status: partial Issue completion.** Both requested processors, pinned local
runtimes, preparation and bounded lifecycle are implemented. Both actual models
passed the packaged offline Google Chrome MV3 inference/lifecycle smoke.
**The required semantic fidelity criterion is not met by the recorded fixtures.**
Do not claim to close #130 on the basis of passing lifecycle tests. This is an
objective fixture discrepancy, separate from the user's later subjective
quality comparison or choice of model. No automatic winner is selected.

## Reproduction and environment

Run the commands in [the processor guide](../meeting-summary-nodes.md), ending in:

```sh
MEETING_SUMMARY_CHANNEL=chrome npm run test:meeting-summary-real
```

Recorded on 2026-10-21, macOS 26.6.2, arm64, Apple M4 Max, 64 GiB physical RAM,
Google Chrome 155.0.8059.85 (headless), Playwright 1.63.0. The extension was
cross-origin isolated. ANGLE used Metal / Apple M4 Max; Worker WebGPU shader-f16
was required and available. Other regression browsers were running on the host,
so these single-run measurements are not controlled performance benchmarks.

Models and exact byte counts:

| Model | Revision | Prepared bytes |
| --- | --- | ---: |
| LiquidAI/LFM2.5-1.2B-JP-202606-ONNX, q4f16 | `01b5a0a33d22253d5ee52b367d2375eeb113b7cd` | 748,958,502 |
| onnx-community/Qwen3.5-2B-ONNX-OPT, q4f16 text sessions | `ed446636739bf426e73c5a00714fd8e010d36c21` | 1,402,859,425 |

Isolated runtime: Transformers.js 4.2.0 and ONNX Runtime Web
1.26.0-dev.20260416-b7804b056c, native WebGPU asyncify JS/WASM. Archive/file hashes
are committed in the preparation script and `scripts/meeting-summary-runtime.json`.
Model manifests contain exact sizes and immutable 1 MiB SHA-256 chunk pins.
The model review script verified upstream LFS whole-file hashes. Model configs,
tokenizers, chat templates and external-data filenames were inspected.

Raw, reproducible outputs and process observations:

- [LFM evidence](meeting-summary-lfm2-130.json)
- [Qwen evidence](meeting-summary-qwen35-130.json)

## Actual inference and lifecycle results

Save streamed the **unchanged pinned model bytes** from a loopback server into
the production verified cache. The source override changes only where Save gets
the bytes; canonical revision URLs, sizes and hashes remain unchanged. A second
Save reused the verified cache with no new downloads. Graph reload retained the
selected processor, Japanese setting and TEXT wiring. Both named options were
present in the Processors palette.

The browser was made offline **before Start**. The production Graph, packaged
runtime, production owned Worker, actual pinned ONNX weights/tokenizer and real
Live display were used. No inference/runtime/model mocks or replacement
summaries were involved. Only the committed TEXT source was controllable;
this smoke does not exercise ASR or native audio capture.

Each model generated three nonempty Japanese plain-text notes: the first two
updates used the 30-second batch timer, and Stop flushed the third batch before
the timer. Every emitted snapshot reached `LiveTextDisplay.replace` exactly as
the Worker returned it, and Stop retained the final note. The second snapshot
changed. A new session reset the note, and Cancel during real generation
terminated the owned Worker without publishing a new note. HTTP(S) requests
after Start: **zero** for each model. CSP violations and console errors: **zero**.

| Measurement (one observed run) | LFM | Qwen |
| --- | ---: | ---: |
| Worker initialization, first load | 1.437 s | 2.207 s |
| Start to processing active (includes UI overhead) | 1.830 s | 2.564 s |
| Approx. Start to first visible note | 33.464 s | 35.464 s |
| First generation | 1.992 s | 3.168 s |
| Second generation | 1.616 s | 2.435 s |
| Second update including batch wait | 31.640 s | 32.446 s |
| Stop tail generation | 1.819 s | 2.265 s |
| Stop tail observed latency | 1.867 s | 2.314 s |
| Prompt tokens across batches | 450 / 675 / 773 | 383 / 535 / 510 |
| Generated tokens across batches | 175 / 291 / 294 | 112 / 129 / 126 |
| Highest sampled sum of owned Chrome process RSS | 3,498 MiB | 4,347 MiB |

RSS includes browser, renderer and GPU processes and can double-count shared
pages; it is neither isolated model allocation nor a measured peak. Process CPU
times are recorded in the JSON snapshots. Per-model CPU utilization, GPU kernel
utilization, free VRAM and peak GPU allocation were not measured. The UI's 4/6 GB
free RAM/GPU allowances are planning estimates. Do not infer a latency target,
hardware minimum, throughput guarantee or quality ranking from these samples.

## Semantic fixture findings: unresolved acceptance

Inputs are maintained in `tests/fixtures/meeting-summary.js`:

1. English proposal: November 12 pilot, 300,000 yen, not approved; accessibility
   owner unknown.
2. English correction and approval: 250,000 yen replaces 300,000; pilot approved;
   Mika will send invitations by Friday; venue approval remains pending.
3. Japanese update: invitations sent; venue still unapproved (repeated);
   accessibility owner still unknown.

The smoke asserts language, plain-text format, successful changed update,
snapshot delivery and lifecycle. It **does not assert factual correctness**.
Reviewing the actual outputs against these explicit facts found:

| Check | LFM observation | Qwen observation |
| --- | --- | --- |
| Initial proposal versus decision | Notes proposal status, but puts approval-necessity text under decisions | Incorrectly states pilot launch/budget as a decision before approval |
| Corrected 250,000 yen | Incorporates corrected amount | Adds corrected amount to discussion, but retains stale 300,000-yen decision |
| Newly confirmed approval | Misses the approval transition | Does not reliably reconcile the prior proposal/decision with new approval |
| Completed invitations | Omits the actual completed invitations and invents other completed work | Records invitations as sent in the final discussion |
| Names/owners | Leaves accessibility owner unknown, but invents procedural work | Replaces Mika/Ken with unsupported Japanese names and attributions |
| Unresolved venue | Misses the pending venue approval | Preserves pending venue approval and unknown accessibility owner in final note |

Representative **actual output defects**, not expected/gold summaries:

- LFM batch 1 invents completed work: `提案内容の記録と提案者への確認依頼が完了した。`
  No participant reported completing that work.
- LFM batch 3 still says `正式実施には追加承認が必須` about the pilot after the explicit
  approval in batch 2, and does not retain the invitations/venue facts faithfully.
- Qwen batch 2 retains `予算 30 万円でのパイロット運用を開始する` under decisions after
  the 250,000-yen correction, and invents the speaker names `米田` and `山田`.

Prompts explicitly prohibit these behaviors, prioritize new corrections and
approval/completion statements, require unknown owners to stay unknown and ask
for original name spellings. These instructions did **not** establish reliable
fidelity for the pinned models. Further model-specific prompt/inference or
verification work, followed by the same real fixtures, is required to meet the
Issue's semantic acceptance criterion. The UI labels successful notes as AI
drafts and asks users to verify facts, decisions and owners against the transcript.
No checkpoint switch, cloud service or canned summary was used to hide failures.

## Validation and boundaries

- `npm test`: **445 passed**, including 16 meeting-summary tests. These use
  controlled Worker replies for deterministic ports, batching, timer, repeats,
  coalescing, Unicode splits, bounded backlog, accepted-text drain on overflow,
  Stop, Cancel, stale replies, missing assets, malformed output, timeouts,
  concurrent instances, languages, v9 Save/reload/default preservation and pins.
- Full extension suite: **172 passed, 16 skipped**. This includes graph,
  pipeline, ASR adapters, translation, IfCondition, TTS and cache regressions,
  plus both parked summary processors' Save failure/persistence, settings,
  cancellation/retry and cache reuse. Heavy existing real-model smokes remain
  opt-in; they were not rerun as part of that suite. Its two meeting-summary
  smoke skips are superseded by the explicit real run below.
- Browser Chromium suite: **119 passed, 9 skipped**. Existing real-model and
  benchmark opt-in tests were skipped; WebKit/Firefox were not run for this
  Chrome-only feature.
- `MEETING_SUMMARY_CHANNEL=chrome npm run test:meeting-summary-real`:
  **2 passed** with the real models and packaged runtime. These are functional
  inference/lifecycle passes, **not semantic accuracy passes**.
- Runtime preparation, production extension build, and `git diff --check` passed.
  An old Models test expected eight cards; it now correctly expects ten.

Earlier integration runs exposed two corrected runtime issues: AutoTokenizer
discovery in 4.2 probes mutable `main` without forwarding revision, so tokenizers
are now constructed directly from verified pinned JSON; native WebGPU in this
ORT version requires asyncify assets rather than the older JSEP configuration.
Earlier prompts also produced English/JSON notes and one exhausted Qwen output
budget. The final prompt uses quoted evidence, escaped chat delimiters and a
prefilled heading/list marker. Output-budget exhaustion now fails explicitly
instead of publishing a truncated note. These iterations are not quality proof.

Not measured: simultaneous real inference of both summary models or summary
plus heavy ASR/translation; physical GPU OOM/loss; actual OS disk exhaustion;
non-Apple hardware; real English-summary accuracy; long-meeting factual retention.
Failure/cancel/backlog/quota behavior is covered with deterministic faults and
the shared asset-cache tests, not claims of real hardware exhaustion. Each
concurrent Node owns separate tensors and a Worker; substantial additional
memory is needed. No deployment-only verification has been identified.

LFM 1.0 license text and commercial/redistribution conditions are packaged and
linked. Qwen's source license is Apache 2.0; the optimized export has an empty
card and does not publish its exact converter command/version. That provenance
boundary is disclosed in the guide; it was not reconstructed or invented.
