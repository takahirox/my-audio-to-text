# Issue #6 evaluation report

On the committed synthetic post-ASR fixture, contextual correction memory reduced normalized character error rate from **13.59% to 5.57%** (39 → 16 edit errors over 287 reference characters), a **58.97% relative reduction**. Six of eighteen test sessions improved; none regressed. This demonstrates a repeat-error correction path on controlled text examples, not an acoustic-quality claim.

## Method and data

- Technique: context-anchored substitutions supported by at least two independent feedback sessions, with contrary-evidence veto and ambiguity abstention. No model or vocabulary is hard-coded into the correction engine.
- Dataset: [evaluation-examples.json](evaluation-examples.json), ten memory and eighteen held-out test sessions with fixed, disjoint UUIDs. Four supported rules result from the memory partition.
- The fixture was authored for this implementation. Its normal/quiet/whisper labels are simulated metadata; there are no audio recordings in this dataset. Real usage needs a separate held-out corpus before claiming product accuracy or quiet/whisper benefits.
- Metric: Levenshtein CER after width/case folding and excluding whitespace/punctuation. Formatting alone cannot reduce the measured errors. Counts are micro-averaged by reference characters.
- All test references are withheld from memory construction. The evaluation API also rejects session overlap across exported feedback revisions.

| Condition | Sessions | Baseline errors / characters | Personalized errors / characters | Baseline CER | Personalized CER | Relative reduction | Regressed sessions |
|---|---:|---:|---:|---:|---:|---:|---:|
| All | 18 | 39 / 287 | 16 / 287 | 13.59% | 5.57% | 58.97% | 0 |
| Normal (simulated) | 6 | 17 / 101 | 8 / 101 | 16.83% | 7.92% | 52.94% | 0 |
| Quiet (simulated) | 6 | 13 / 88 | 2 / 88 | 14.77% | 2.27% | 84.62% | 0 |
| Whisper (simulated) | 6 | 9 / 98 | 6 / 98 | 9.18% | 6.12% | 33.33% | 0 |

## Examples and limits

Improvements include:

- `今夜はGPTソールを使いますよ` → `今夜はGPT Solを使いますよ`
- `新しい処理は音声任式を使います` → `新しい処理は音声認識を使います`
- `今回は今日と市に向かいますよ` → `今回は京都市に向かいますよ`

Controls such as `今日は靴のソールを洗います` remain unchanged. No incorrect replacement occurs in this fixture. A regression counter is also tested explicitly using a known wrong personalized result.

Failure/abstention examples:

- `昨日はGPTソールについて話しました` remains incorrect because its right context does not match prior corrections.
- `今週はGPTソールを使い始めます` is also left unchanged: the fourth right-context character differs from the supported `を使います` context.
- The two `ニューラルネットわく` memory examples have different fourth right-context characters, so neither rule reaches the two-session threshold. Their test errors remain. This conservative choice was retained rather than tuning context length against test references.
- A phrase that has the same local context but a different meaning outside the context window can still be miscorrected. Repeated mistaken feedback can teach a wrong rule. Broader edits, changed line alignment, or multiple matches are intentionally skipped.

## Local compute and reproduction

Recorded on 2026-09-07 using the Swift release build on arm64 macOS. One CLI run measured **0.792 ms** to build memory from ten samples and **0.00484 ms per test session** for application. These are single-run, small-corpus timings; they exclude ASR, file parsing, and SQLite I/O and are not a large-corpus latency guarantee. The engine runs on CPU and does not load another model or use a network service. Corpus scanning and candidate validation will cost more as feedback grows.

```bash
./scripts/verify.sh
swift run -c release PersonalizationEval docs/issue-6/evaluation-examples.json
```

[The recorded JSON report](evaluation-result.json) includes predictions, applied rule IDs, exact metric counts, memory digest, and timings. Metrics and digest are deterministic for the fixture; timings vary. The verification suite covers memory generation, false-replacement avoidance, persistence and schema migration, baseline/personalized separation, the future ASR pipeline, and split leakage. Interactive microphone/model smoke testing was not performed.

For a real evaluation, export feedback, hold all revisions of each session in exactly one partition, then run the documented `--feedback memory.jsonl test.jsonl` mode. Use that independent corpus to decide whether broader matching or acoustic adaptation is justified.
