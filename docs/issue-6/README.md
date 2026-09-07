# Personalization memory v1

Enable **Settings → Personalization → Use correction memory for new recordings**, then save settings. The default is off, including when loading older configuration files. At the start of each new recording, the app snapshots memory from saved feedback. After final ASR segments commit, it applies that snapshot locally, saves an audited result, and uses the result for Quick Dictation paste. Partial text remains baseline ASR.

The **Personalized** tab shows the saved result and expandable applied corrections. **Clean Transcript** provides the baseline for the same audio; **Raw Transcript** retains ASR output. Copy copies the selected tab. The Corrections editor starts with the personalized result, while saving feedback continues to snapshot the original Raw/Clean source. New feedback influences subsequent recordings. Changing settings does not recompute historical runs. Polish and synthesis continue to use Clean Transcript.

## Technique and abstention

Memory is rebuilt from the local feedback corpus; it requires no network, extra model, or model-weight changes. The last appended revision per session supplies at most one vote per rule. When corrected lines still align with source segments, the miner extracts the span between the longest common prefix and suffix. It considers only substitutions of 2–32 source characters and 1–32 replacement characters, with at least four unchanged context characters in total. Empty edits, insertions/deletions, formatting-only edits, and segments over 512 characters are excluded.

A rule retains four literal characters of context on each side where available, plus start/end anchors when the context reaches a segment boundary. At least two independent sessions must support the same context and correction. A matching contrary example, including an explicit unchanged correction, vetoes it. Application requires exactly one match across all rules and positions in the original segment; multiple matches cause abstention, and replacements never cascade. Non-user or partial segments and a rule's own source sessions are excluded.

Each rule records its source/replacement, context, stable ID, feedback/session/segment IDs, raw/baseline/corrected text, dates, and speech conditions. `sessionCount` and `lastSeen` expose frequency and recency. Current speaking conditions are not inferred from audio; rules can apply across conditions, and evaluation reports conditions separately.

Schema version 3 adds `personalization_runs`, separately from transcripts, synthesis, outputs, and feedback. Each append-only run records whether personalization was enabled, memory/source digests, per-segment baseline and result, abstention/application reason, and complete provenance for applied rules. No rules are hard-coded for particular user vocabulary. `SessionStore.personalizationMemory()` rebuilds the same memory after restart, and `latestPersonalizationRun(sessionID:)` loads the historical audit.

## Reproducible evaluation

```bash
swift run -c release PersonalizationEval docs/issue-6/evaluation-examples.json
```

`evaluation-examples.json` is an explicitly **synthetic text-only** regression fixture: ten memory sessions and eighteen held-out test sessions. It contains deliberately misspelled Japanese technical terms and names, repeated errors in changed contexts, correctly recognized controls, and contexts where the algorithm should abstain. Normal/quiet/whisper labels are fixture metadata, not acoustic measurements. The dataset establishes deterministic post-ASR behavior; it does not establish accuracy improvements on real recordings or whisper audio.

Session IDs and split assignments are fixed. Each row is a different simulated session, and the evaluator rejects duplicate session IDs, missing partitions, and unknown split names. Test references never enter memory construction. Similar recurring phrases in different simulated sessions intentionally test repeat-error correction.

The metric is micro-averaged character error rate (Levenshtein errors divided by reference characters) over Unicode grapheme clusters after width/case folding and removal of punctuation/whitespace. Formatting-only changes therefore cannot account for improvement. The report includes baseline/personalized CER, relative error reduction, improved/regressed sample counts, applied corrections, per-condition results, predictions, memory construction time, and application time per sample. A zero denominator produces an absent rate, not an artificial zero.

For real data, export feedback with the existing UI, partition JSONL by **session ID**, keeping every revision together, and run:

```bash
swift run -c release PersonalizationEval --feedback memory.jsonl test.jsonl
```

Both files use the existing feedback export format and ISO 8601 dates. The evaluator rejects any overlapping session ID even if different revisions were selected, and evaluates only the latest appended test revision per session. Do not choose contexts or thresholds after inspecting the test references; reserve another held-out set for later changes.

## Known limits

- Context matching is literal and local: changed inflections, segment boundaries, multiple errors, or short edits may remain uncorrected. Line-count changes are skipped rather than guessed.
- A matching phrase can still mean something different outside the four-character context. Repeated incorrect user corrections can also teach a wrong rule. This is not semantic understanding; inspect the saved audit and disable personalization or save contrary feedback when necessary.
- Memory currently scans the corpus and candidate contexts at recording start. The small-fixture latency is not a large-corpus performance guarantee.
- Historical polished/synthesized output and baseline feedback are preserved. This milestone does not do acoustic adaptation, speaker identification, or automatic training.

See [the measured report](EVALUATION.md) and [acceptance checks](../ACCEPTANCE.md).
