# Issue #9 validation evidence

The delivered result is the complete local evaluation harness, a generated non-private pipeline fixture, and [manual real-audio collection/baseline instructions](README.md). No real speech recordings were present in the repository during implementation. No acoustic accuracy, speaker adaptation, or whisper improvement is claimed.

## Automated gate

`./scripts/verify.sh` runs the existing 36 Swift tests, builds the app, text evaluator and audio benchmark bridge in release mode, and runs 28 Python tests. The new tests cover:

- importing WAV files, relocation-stable manifests, exact-file/PCM hashes, changed references/splits/preprocessing, wrong formats/truncation, duplicate IDs, and output no-overwrite behavior;
- session/prompt/reference grouping, cross-split PCM copies with different WAV headers, same-group PCM duplicate rejection, nested complete groups and training provenance rejection;
- versioned normalized CER, edit counts, empty successful output, undefined denominators, all speech-condition buckets, exact expected prediction IDs, incomplete-run refusal and explicit layer selection;
- the real Swift `WhisperCLIBackend` process path using generated tones and a deterministic fake CLI/model, model/backend provenance and disabled baseline personalization;
- contextual curves using the actual Swift memory implementation, speaker isolation, combining multiple utterances without counting one source session twice, and preservation of cached baseline predictions;
- backend timeouts/malformed output/nonzero exits, nonzero incomplete-run CLI status, external adapted-result import and regression comparison.

## Reproduced pipeline fixture

The documented fixture commands were executed locally. They generated six distinct 0.1-second PCM tones: two training groups and four evaluation utterances, with simulated normal/quiet/whisper labels. The fake ASR supplied predetermined text; the Swift contextual-memory layer was real. The test setup deliberately produces this table:

| Output | Selected training groups | Audio seconds | Errors / reference characters |
|---|---:|---:|---:|
| Raw ASR fixture | 0 | 0 | 9 / 58 |
| Clean control | 0 | 0 | 9 / 58 |
| Contextual memory | 0 | 0 | 9 / 58 |
| Contextual memory | 1 | 0.1 | 9 / 58 |
| Contextual memory | 2 | 0.2 | 0 / 58 |

All rows use the identical evaluation digest. The two-group result contains one supported rule, while the one-group result abstains. The generated JSON/Markdown includes per-condition and per-utterance results, selection IDs, actual frame-derived durations, model/backend identities and applied-rule evidence. This is plumbing/scorer validation, **not a recognition-quality benchmark**.

Generated audio, fake executables and full local run artifacts are under the ignored `local-benchmarks/issue-9-fixture-*` directories. They are reproducible using `Tests/benchmark/fixtures.py` and are not committed. The committed files contain no private recordings or private transcripts.

## Limits of this milestone

- Real baseline measurements still require locally collected speech and a real configured whisper.cpp model. Interactive microphone recording and real-model accuracy testing were not performed.
- Exact audio-copy checks cannot detect every re-encoded, cropped or near-duplicate recording. Correct source session/prompt/group labels remain essential.
- Declared training IDs are checked against the manifest and group boundaries; the harness cannot prove an arbitrary external model's undisclosed training history.
- The baseline runs whole utterances in fresh CLI processes. Latency includes startup/model loading and is distinct from the app's streaming experience.
- Metric/Unicode/preprocessing identities are frozen. Dataset edits or incompatible run identities are rejected; create a new dataset/run version instead of overwriting historical results.
