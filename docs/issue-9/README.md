# Real-audio evaluation harness

This harness imports local WAV utterances, freezes their references and splits, runs the existing whisper.cpp backend, and produces reproducible JSON/Markdown scores. It also compares external adapted recognizers and the current contextual memory on the identical held-out set. No model training, audio upload, or access to the application's live feedback corpus occurs.

Requirements: macOS/Swift as for the app, Python 3.9+ with its standard library, and a configured local `whisper-cli`/model for real recognition. Dataset validation and external-result scoring require only Python. Build with `swift build -c release --product AudioBenchmarkBridge`; `./scripts/verify.sh` runs the complete offline test gate.

## Collect the first real set

1. Choose one speaker initially. Record naturally at normal volume, quietly, and whispering; reducing file amplitude does not turn voiced speech into whisper speech. Keep microphone position/environment consistent where possible and note them in your collection log.
2. Use short utterances and a mix of parallel sentences across conditions, technical terms, and unseen sentences. Start with a few utterances per condition; aim for 20–50 held-out utterances per condition when practical. Split long session recordings into utterance files using your recorder/editor, retaining the original recording/session ID for every clip.
3. Export **uncompressed PCM WAV, mono, 16 kHz, 16-bit**. The importer rejects other formats, empty files and truncation; it does no resampling, gain changes, silence trimming, or denoising. Make any conversion once before preparing a dataset, and preserve your originals locally.
4. Transcribe what was actually said, including fillers, repetitions, and false starts. Correct a reading mistake in the reference, rather than using the intended prompt as ground truth. Use ordinary Japanese orthography, Arabic digits for numbers, and consistent technical-name spellings. Keep the exact reference text in the manifest; width/case/spacing/punctuation differences are normalized by the fixed metric. The recognizer never receives evaluation references.
5. Plan train/evaluation partitions before adapting or tuning. All clips from one recording/session and all parallel renditions of a prompt must stay in one `groupID` and one split, including normal/quiet/whisper versions. Different speakers' references to the same prompt also share its group. Use distinct prompt groups for held-out generalization. The validator additionally links identical normalized references and rejects duplicate PCM audio even within one split to avoid double weighting. Label near-duplicates manually with the same group, as hashes cannot detect every near-duplicate.
6. Keep private audio, references, run files, and reports below **`local-benchmarks/`**, which is ignored by Git. Only synthetic metadata and test code belong in the repository. The app's retained WAV files can be copied/exported into this workflow; private recordings are not required in CI.

## Draft and immutable dataset

Create `local-benchmarks/source/draft.json` with one object per utterance:

```json
{
  "samples": [
    {
      "id": "train-001",
      "speakerID": "speaker-a",
      "sessionID": "recording-001",
      "groupID": "train-group-001",
      "promptID": "prompt-001",
      "split": "train",
      "condition": "normal",
      "audio": "train-001.wav",
      "reference": "今日は音声認識を試します"
    },
    {
      "id": "eval-001",
      "speakerID": "speaker-a",
      "sessionID": "recording-002",
      "groupID": "eval-group-001",
      "promptID": "prompt-002",
      "split": "eval",
      "condition": "whisper",
      "audio": "eval-001.wav",
      "reference": "明日の予定を確認します"
    }
  ]
}
```

IDs contain only letters, digits, `_`, `-`, or `.` (1–80 characters), and are dataset-global. `sessionID` identifies the original recording/session, not an arbitrary new ID for each fragment. `groupID` is the complete connected leakage group: shared sessions, prompts, or normalized references cannot have different group IDs; exact PCM duplicates are rejected. A group may never cross splits. `condition` is `normal`, `quiet`, `whisper`, or `unknown`; unclear/mixed speech should be `unknown`. An empty reference is allowed for an intentional non-speech control. Audio paths are relative to the draft or absolute at import time.

```bash
python3 scripts/audio-benchmark.py prepare local-benchmarks/source/draft.json local-benchmarks/dataset-v1
python3 scripts/audio-benchmark.py validate local-benchmarks/dataset-v1/manifest.json
```

`prepare` copies the audio into a new directory and emits a sorted `manifest.json`. It records exact-file and decoded-PCM SHA-256, frame counts/durations, schema/metric/preprocessing versions, and dataset/evaluation digests. Both digests cover references, partitions, speaker/session/group/prompt identity, conditions and audio hashes. Audio paths inside a sealed dataset are relative and confined to its directory, so moving the entire dataset preserves its identity.

Every execution and scoring command revalidates the files and digests. Editing any reference, split, preprocessing or audio requires preparing a new dataset version; incompatible results are rejected. Existing destinations are never overwritten. Hashes detect accidental changes, not a malicious actor deliberately replacing and re-signing a manifest.

## Run the raw baseline

Use an app-format configuration JSON with the local model and executable paths, for example the existing app configuration. Personalization is explicitly disabled in an isolated temporary copy regardless of the app setting.

```bash
python3 scripts/audio-benchmark.py run \
  local-benchmarks/dataset-v1/manifest.json \
  "$HOME/Library/Application Support/MyAudioToText/config.json" \
  local-benchmarks/baseline-v1 \
  --hardware 'Apple Silicon model/chip and RAM; fill in this machine' \
  --include-training
```

The Swift bridge calls the existing `WhisperCLIBackend` once per entire utterance. It bypasses the app's rolling partial/chunk deduplication and never runs polishing/synthesis. The subprocess receives only audio, local settings and a derived session UUID. The primary score is **Raw ASR**. `clean-control.json` reports the same predictions after the existing cleaner; it is a separate control, not the acoustic baseline. The optional `--include-training` also recognizes the training partition for later contextual curves; its references are not ASR prompts.

Output files include `run.json`, `report.json`, `report.md`, and `clean-control.json`. The run stores model/backend/bridge hashes, model name, language, exact explicit decoding arguments, evaluator Git commit and source hash, hardware/OS, and per-utterance inference timings and available segment confidence. Unspecified decoder options are the defaults of the hashed whisper executable. Keep that executable/model/config to reproduce a run. Model/backend/dataset changes during execution invalidate the result.

Latency includes process launch and model loading for each utterance, plus parsing; RTF is the sum of timed inference seconds divided by the sum of corresponding audio seconds. It excludes dataset/model hashing and import. It is not a measurement of the app's interactive latency or battery use. `--timeout` defaults to 660 seconds per utterance; the existing backend also has its own 600-second bound.

## Fixed scoring and failure policy

The primary metric is **`ja-cer-codepoint-v1`**: NFKC, Unicode case folding, NFC, then retain alphanumeric Unicode codepoints; compute Levenshtein substitutions/deletions/insertions divided by reference characters, micro-averaged. Python's Unicode database version is part of the metric identity, so incompatible runtime versions are rejected. This is explicitly a codepoint metric after normalization, separate from the earlier Swift text-only evaluator. It does not normalize synonyms, readings, or Arabic digits versus spelled-out numbers. Raw references and hypotheses remain in reports for inspection.

Reports contain overall, per-condition (including unknown/absent conditions), per-speaker and per-utterance metrics, edit counts, exact-match rate and available RTF. Empty-reference denominators produce `null` CER. Successful empty ASR output incurs deletion errors against a nonempty reference. Missing/duplicate/unexpected evaluation IDs, changed digests, unsupported metrics, or missing requested output layers are rejected; there is no fallback to another text layer.

Evaluation timeouts, malformed backend output and nonzero exits are explicit `status: error` predictions. Their IDs remain in the report, the run is marked **incomplete**, and aggregate CER is withheld rather than silently dropping failures. The CLI saves this diagnostic result and exits **2**. Validation/configuration errors exit **1**; complete runs exit **0**. Incomplete runs cannot be compared. Optional training-recognition failures remain in `trainingPredictions` in `run.json` and block curve subsets requiring those samples; they do not invalidate successful held-out baseline inference. Correct the cause and create a new run directory.

## Nested contextual learning curves

```bash
python3 scripts/audio-benchmark.py curve \
  local-benchmarks/dataset-v1/manifest.json \
  local-benchmarks/baseline-v1/run.json \
  local-benchmarks/curve-v1 --groups 0,1,2
```

Counts are unique ascending whole training-group counts, starting with zero. Groups are ordered lexicographically by fixed `groupID`; each larger subset includes all earlier groups. Choose counts within the available number of groups. All steps reuse the exact same cached evaluation predictions and evaluation digest. The report records selected training IDs, actual audio seconds overall/per speaker, metrics for every condition, and applied-rule provenance. No recognition or training is rerun for evaluation references.

Memory uses training references only and is built separately for each speaker. Multiple utterances of one source session are combined to preserve the current memory's one-session-one-vote rule. Condition becomes `unknown` for a mixed-condition combined session; original utterance labels remain in the manifest. Existing memory abstains when reference lines do not align with ASR segments; short single-segment utterances are the easiest first corpus. Nested data may still produce no improvement, and that is a valid result.

Benchmark feedback uses deterministic IDs and an epoch timestamp, not inferred recording dates. Applied-rule segment IDs resolve back to utterances in the baseline cache; original grouping and condition metadata remain in the dataset manifest.

The zero-data contextual step equals the Clean control; report Raw separately so cleaning improvements are not attributed to memory. `curve.json`/`curve.md` provide the learning-curve table, and `groups-N.json` files are independently comparable run artifacts. Memory/build timings are recorded per speaker, including the bridge process; no acoustic adaptation is trained here.

## Future adapted systems and scorer reuse

```bash
python3 scripts/audio-benchmark.py template local-benchmarks/dataset-v1/manifest.json local-benchmarks/adapter-template.json
# Fill in system hashes/settings/commit and declare the exact train-only trainingSampleIDs.
# For every eval ID, supply {"sampleID":"...","status":"ok","text":"recognized text"},
# or an explicit error. Remove placeholder metadata; do not insert reference transcripts as predictions.
python3 scripts/audio-benchmark.py import-results \
  local-benchmarks/dataset-v1/manifest.json local-benchmarks/adapter-template.json \
  local-benchmarks/adapted-v1 --layer text
python3 scripts/audio-benchmark.py compare \
  local-benchmarks/dataset-v1/manifest.json local-benchmarks/baseline-v1/run.json \
  local-benchmarks/adapted-v1/run.json local-benchmarks/comparison-v1
```

The adapter consumes the fixed audio set using its own model, then returns predictions keyed by sample ID. Imported system metadata must include backend/model SHA-256 (a weight-manifest digest for multi-file models), settings, evaluator commit, hardware if latency is supplied, and the exact personalization/adaptation sample IDs. The importer rejects eval/unknown IDs in declared training, partial leakage groups, and any mismatch in the held-out prediction set. It cannot prove the training history of an arbitrary external model; the declared provenance is the experimenter's responsibility. Avoid tuning on test references; use another development partition outside this frozen test experiment when choosing model parameters.

`compare` recalculates both scores against the current validated dataset, reports condition-specific metrics, relative error reduction and improved/regressed utterances, and rejects incompatible or incomplete runs. `--baseline-layer`/`--candidate-layer` explicitly select `raw`, `clean`, or `text`. `score` can regenerate reports from sealed runs without invoking ASR.

## Automated non-private fixture

```bash
python3 Tests/benchmark/fixtures.py local-benchmarks/fixture-source
python3 scripts/audio-benchmark.py prepare local-benchmarks/fixture-source/draft.json local-benchmarks/fixture-dataset
python3 scripts/audio-benchmark.py run local-benchmarks/fixture-dataset/manifest.json local-benchmarks/fixture-source/config.json local-benchmarks/fixture-baseline --include-training --hardware 'generated tones with fake ASR'
python3 scripts/audio-benchmark.py curve local-benchmarks/fixture-dataset/manifest.json local-benchmarks/fixture-baseline/run.json local-benchmarks/fixture-curve --groups 0,1,2
```

This generates distinguishable PCM **tones**, a fake model and a deterministic fake `whisper-cli`; it tests actual file import, real Swift process integration, scoring and contextual-memory plumbing. It is **not speech**, and its condition labels and recognition results are synthetic. See [validation evidence](VALIDATION.md). No real recordings were supplied in the repository during implementation, so no real-audio baseline or speaker/whisper improvement is claimed. The harness, automated fixture and collection/reproduction steps are the accepted deliverables for this milestone.
