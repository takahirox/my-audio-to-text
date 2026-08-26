# Issue #2 plan: evaluate realtime ASR lessons from hayamimi

Status: design and benchmark proposal; no backend, model, dependency, or threshold is approved.

Primary issue: <https://github.com/takahirox/my-audio-to-text/issues/2>

Upstream references:

- hayamimi: <https://github.com/oboroge0/hayamimi>
- sherpa-onnx: <https://github.com/k2-fsa/sherpa-onnx>
- ReazonSpeech Japanese Zipformer model page: <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html#sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01-japanese>

The references identify systems to investigate, not APIs or behavior that this document assumes. Before implementation, pin reviewed upstream commits/releases and record findings, licenses, and reproducible experiments in the decision record below.

## Decision this work should enable

Determine whether one or more lessons from hayamimi—especially speech-aware endpointing, bounded context before speech, incremental recognition, maximum-utterance finalization, and optional refinement—improve this application's Japanese dictation experience enough to justify their complexity. Possible outcomes include adopting only the state-machine design, adding a new backend, retaining the current implementation, or running another experiment. “Investigate hayamimi” is not an adoption decision.

Approval is required twice: first for benchmark corpus, metrics, and numeric gates; then, after measurements, for any production dependency, model, or architecture change.

## Goals

- Specify a backend-neutral realtime contract with stable partial/final semantics.
- Compare the existing fixed-window Whisper CLI path with speech-aware candidates on identical, legally usable Japanese fixtures.
- Measure user-visible latency, recognition accuracy, CPU, and memory reproducibly on representative Apple Silicon Macs.
- Investigate sherpa-onnx feasibility separately for desktop, web, and mobile rather than inferring portability from its name or repository.
- Define safe model acquisition, verification, update, offline, rollback, and licensing gates before distributing any artifact.
- Produce evidence sufficient for a reversible go/no-go decision.

## Non-goals

- Selecting hayamimi, sherpa-onnx, or ReazonSpeech Zipformer in advance.
- Replacing the existing Whisper backend during exploration.
- Claiming mobile or web support in the current macOS-only package.
- Inventing upstream APIs, performance, licenses, or redistribution rights.
- Benchmarking semantic cleanup, polishing, or LLM synthesis; ASR raw text is the accuracy target.
- Training or fine-tuning a model, cloud ASR, speaker diarization, or system-audio capture.

## Current implementation: capabilities and gaps

### Existing capabilities

- `Sources/MyAudioToTextApp/AudioCaptureService.swift` captures microphone input through `AVAudioEngine`, converts it to 16 kHz mono PCM, writes continuous audio plus chunk WAV files, emits snapshots at `partialIntervalSeconds`, and finalizes fixed windows at `chunkSeconds`.
- `Sources/AudioTextCore/Configuration.swift` defaults those intervals to 2 and 8 seconds, validates final chunks in 2–60 seconds, and requires a configured Whisper executable and model.
- `Sources/AudioTextCore/WhisperCLIBackend.swift` defines `TranscriptionBackend.transcribe(audioURL:sessionID:baseOffsetMilliseconds:startingOrdinal:)`. It invokes `whisper-cli` once per complete WAV and returns only `[TranscriptSegment]`; parsed segments are marked final.
- `Sources/MyAudioToTextApp/TranscriptionPipeline.swift` serializes backend work. It permits at most one pending snapshot transcription, drops additional partial snapshots while busy, treats snapshot results as display-only text, transcribes every final chunk again, removes adjacent equal cleaned segments, and persists final segments.
- `Sources/AudioTextCore/Models.swift` defines `ASREvent.partial` and `.final`, and `TranscriptTimeline` replaces a single partial tail, requires contiguous final ordinals, makes repeated identical final IDs idempotent, and clears the partial tail on final.
- `Sources/AudioTextCore/SessionStore.swift` accepts durable final segments; `Tests/AudioTextCoreTests/SessionStoreTests.swift`, `Tests/AudioTextCoreTests/LongSessionRecoveryTests.swift`, and `Tests/AudioTextCoreTests/TranscriptTimelineTests.swift` cover final-only persistence, recovery, partial replacement, idempotence, and ordinal gaps.
- `Sources/MyAudioToTextApp/AppController.swift` wires capture, pipeline, timeline, and store. It can retain continuous audio, displays partial text separately, and waits for queued final transcription after recording stops.
- `Package.swift` currently targets macOS 14 and contains no sherpa-onnx dependency or web/mobile product.

### Gaps relevant to Issue #2

- No VAD, speech onset/offset detector, configurable pre-roll, hangover, or speech-aware endpointing exists.
- Fixed chunks can split speech and can repeatedly recognize silence; snapshot and final recognition repeat work over overlapping audio.
- The backend interface is file/batch-shaped. It has no stream lifecycle, audio-frame ingestion, cancellation, reset, endpoint, capability discovery, or event stream.
- Partial events do not have stable IDs or revision numbers, and `TranscriptTimeline` discards their timestamps. Pipeline partials bypass `ASREvent` entirely.
- “Final” means completion of a fixed WAV invocation, not a VAD endpoint. There is no configured maximum utterance or explicit forced-final reason.
- There is no second-pass refinement or defined fallback from it.
- There is no ASR benchmark harness, fixture manifest, model registry, integrity check, atomic updater, or backend-specific resource telemetry.

These are observed gaps, not evidence that a candidate solves them.

## Preserve the batch abstraction; add a streaming boundary

Do not silently mutate `TranscriptionBackend`: its synchronous file-to-final-segments contract is useful for the current baseline and optional refinement. Introduce a separate experimental protocol, with exact Swift names subject to implementation review:

```swift
protocol StreamingTranscriptionSession: Sendable {
  func accept(_ frame: AudioFrame) throws -> [StreamingASREvent]
  func flush(reason: FinalizationReason) throws -> [StreamingASREvent]
  func cancel()
}

protocol StreamingTranscriptionBackend: Sendable {
  var capabilities: StreamingASRCapabilities { get }
  func makeSession(_ context: ASRSessionContext) throws -> any StreamingTranscriptionSession
}
```

The application owns VAD and utterance boundaries unless investigation proves a backend-native endpoint detector can honor the same observable contract. A backend adapter may use native streaming internally, but must not leak unverified upstream types into the portable event model. `WhisperCLIBackend` remains the baseline `TranscriptionBackend`; an adapter can buffer one utterance and call it at finalization, enabling state-machine comparison independently of a new engine.

Capabilities should explicitly report streaming partials, timestamps, confidence, accepted PCM format, cancellation, and refinement support. Unsupported fields remain absent; adapters must not synthesize confidence or timing.

## Proposed VAD and configurable pre-roll state machine

All durations and thresholds below are configuration fields whose defaults are **TBD pending corpus inspection and gate approval**. VAD operates on monotonically indexed frames after conversion to the canonical benchmark/capture format. Keep a ring buffer bounded by `preRollMs` even while idle.

| State | Event/condition | Action | Next state |
| --- | --- | --- | --- |
| `idle` | nonspeech frame | Replace oldest pre-roll frame; emit nothing | `idle` |
| `idle` | speech probability crosses onset rule for `onsetFrames` | Open utterance at earliest retained pre-roll frame; feed retained frames exactly once | `inSpeech` |
| `inSpeech` | speech/brief nonspeech and duration below limits | Feed frame; backend may revise one partial | `inSpeech` |
| `inSpeech` | nonspeech satisfies `offsetFrames`/`hangoverMs` | Include configured trailing audio; flush with `.vadEndpoint` | `finalizing` |
| `inSpeech` | duration reaches `maxUtteranceMs` | Cut at the exact frame boundary; flush with `.maximumDuration` even if speech continues | `finalizing` |
| `finalizing` | primary final available or primary error recorded | Commit at most one primary final; schedule optional refinement; reset backend utterance state | `idle` or `continuedSpeech` |
| `continuedSpeech` | speech remains active after a forced cut | Start the next utterance with bounded overlap `forcedCutOverlapMs`; do not wait for silence | `inSpeech` |
| any active state | user stop/end of input | Flush buffered speech with `.endOfInput`; discard pre-roll-only silence | `finalizing` |
| any active state | cancellation/fatal capture error | Emit no fabricated final; preserve already committed finals and record failure | `idle` |

Required rules:

- `preRollMs`, `hangoverMs`, onset/offset rules, `maxUtteranceMs`, and `forcedCutOverlapMs` are logged in every run manifest.
- Pre-roll is context for the utterance, not a second timestamp origin. It is inserted once and memory remains bounded.
- VAD timestamps use captured sample counts, not callback wall-clock time.
- Empty/whitespace recognition does not create a transcript segment, but endpoint and error telemetry remain observable.
- The forced-cut overlap, if nonzero, must be resolved by timestamp-aware deduplication; adjacent cleaned-text equality is insufficient. If reliable alignment is unavailable, set overlap to zero for the first slice.
- VAD inference failure falls back to the approved fixed-window baseline for the current session and exposes a warning; it must not stop capture.

## Partial and final transcript invariants

1. A session has monotonically increasing `utteranceID`s; each utterance has zero or more revisions of one unstable partial and at most one committed primary final.
2. A partial carries `utteranceID`, increasing `revision`, sample-derived start/end times, raw text, and backend identity. A newer revision replaces, never appends to, the visible unstable tail.
3. Partials are never persisted as committed evidence and never advance final ordinals.
4. A final carries a stable segment/event ID, contiguous ordinal, nondecreasing valid time range, raw text, optional confidence only when supplied, backend/model identity, and finalization reason.
5. Replaying the same final ID with identical content is idempotent; the same ID with different content is an error. A second primary final for an utterance is an error.
6. Committing a final atomically clears that utterance's partial. Late partials or lower/equal revisions are ignored and counted.
7. Finals never change because a later partial arrives. Optional refinement is a distinct, traceable revision described below, not mutation disguised as another primary final.
8. Forced-final segments preserve continuous sample time. The next utterance begins at the cut, or at the recorded overlap start with deterministic reconciliation; no audio may be silently lost.
9. Backend failures do not reorder later finals. Persistence assigns ordinals in utterance order after resolving pending earlier finalization.
10. Raw ASR text remains evidence. Cleaning stays downstream and must not affect WER/CER calculation.

Property and deterministic tests should exercise duplicate, reordered, late, empty, error, stop, continuous-speech, and boundary-overlap event sequences.

## Maximum-utterance forced-final behavior

`maxUtteranceMs` bounds decoder context, final latency, and memory. Its numeric value is proposed/TBD. At the limit, snapshot the exact sample index, flush the primary decoder with reason `.maximumDuration`, and immediately continue capture. Never wait for a silence endpoint after reaching the limit. Record `forced_final_count`, cut sample, overlap samples, flush start/end, and whether speech was still active.

If the decoder cannot flush synchronously, capture continues into a bounded next-utterance buffer while finalization runs. Define an explicit buffer-overflow policy before implementation: the proposed safe behavior is to retain audio on disk, mark realtime degradation, and recover through batch transcription rather than drop audio. Benchmark continuous speech longer than twice the proposed maximum and assert complete, ordered sample coverage.

## Optional two-pass refinement

Pass 1 is the latency-critical primary result. After it is durably committed, an optional batch backend may refine the exact utterance audio plus approved bounded context. Pass 2 must never block capture or primary persistence.

- Store refinement as a new revision linked to the primary segment, with backend/model/version, source-audio digest, and completion time. Preserve the primary raw text.
- Display policy (primary immediately, refined replacement, or explicit comparison) is an open product decision. Synthesis must declare which revision it consumed.
- On timeout, crash, unavailable model, invalid output, checksum failure, or resource pressure, retain the primary unchanged and record a categorized refinement failure.
- Refinement retries must be bounded and idempotent. Offline operation uses already verified local artifacts only.
- Benchmark primary-only and primary-plus-refinement separately. Do not attribute refinement accuracy to realtime pass 1.

## Benchmark corpus and fixtures

### Representative, legally usable Japanese corpus

Create a versioned evaluation set whose redistribution and evaluation permissions have been reviewed before audio or transcripts enter the repository or CI. Candidate sources may include permissively licensed public Japanese speech datasets and purpose-recorded contributor audio with explicit written consent. Dataset names and license conclusions are **TBD investigation tasks**; the ReazonSpeech model name does not establish permission to redistribute any evaluation audio.

Target strata, with counts approved before collection:

- clean read speech and spontaneous dictation;
- short commands, ordinary sentences, and continuous speech exceeding the proposed maximum utterance;
- multiple adult speakers and pitch ranges, without inferring sensitive attributes;
- standard Japanese plus approved regional/accent variation;
- quiet room, fan/keyboard noise, and reproducibly mixed public/owned noise at recorded SNR;
- near-field and laptop-microphone conditions;
- numbers, dates, punctuation intent, proper nouns, English/code-switch terms, fillers, corrections, and long pauses.

Use speaker-disjoint development and locked evaluation splits. Development fixtures tune VAD/configuration; the locked split is evaluated once per approved candidate configuration. Keep a small redistributable smoke subset for tests. If the main set cannot be redistributed, store only its manifest and acquisition recipe where permitted, and require operators to provision it locally.

Human references must follow a written Japanese transcription policy covering orthography, numerals, punctuation, hesitations, partial words, code switching, and inaudible spans. Double-annotate a planned sample, adjudicate disagreements, and version both policy and references. Report accuracy both with the frozen scoring normalization and, where useful, raw-form sensitivity; never tune normalization per backend.

### Reproducible fixture manifest

Use JSON Lines or another reviewed machine-readable format, one record per audio item:

```json
{
  "fixture_id": "stable-id",
  "split": "dev|locked-eval|smoke",
  "audio_path_or_dataset_key": "...",
  "audio_sha256": "...",
  "reference_path": "...",
  "reference_sha256": "...",
  "license_id": "TBD-after-review",
  "license_evidence": "path-or-URL",
  "consent_record": null,
  "speaker_pseudonym": "...",
  "sample_rate_hz": 16000,
  "channels": 1,
  "duration_samples": 0,
  "condition_tags": ["..."],
  "source_version": "..."
}
```

The run manifest additionally pins repository commit, dirty-state flag, OS/build, device identity, power mode, thermal start/end, backend adapter commit, runtime/library versions, model ID/version/SHA-256, all decoder/VAD parameters, fixture-manifest digest, scoring-tool version, warmup policy, repetitions, random seeds, and command line. Reject missing files, digest mismatch, duplicate IDs, train/evaluation leakage where detectable, or unresolved license evidence.

## Exact metric definitions

All time values use `CLOCK_MONOTONIC_RAW` or the closest documented monotonic clock and are reported per fixture plus median, p90, p95, and p99 where sample size supports them. The harness records audio presentation time so faster-than-realtime replay cannot masquerade as realtime latency.

| Metric | Definition |
| --- | --- |
| First-partial latency | `timestamp(first nonempty partial visible to consumer) - presentation timestamp(last sample required by that partial)`. Also report recording-start-to-first-partial separately. |
| Endpoint-to-primary-final latency | `timestamp(primary final delivered) - presentation timestamp(VAD endpoint sample)`. For `.maximumDuration` or `.endOfInput`, use the cut/final input sample. |
| Speech-end-to-final latency | `timestamp(primary final delivered) - ground-truth speech-end presentation timestamp`; diagnostic of VAD plus decoding. Ground-truth boundaries follow a frozen annotation procedure. |
| Partial churn | Sum of character-level Levenshtein distances between successive normalized partials, divided by characters in the primary final; report fixtures with no partial separately. |
| Realtime factor | Total backend processing CPU-independent wall duration divided by presented audio duration, reported for primary and refinement separately. |
| Character error rate (CER) | Aggregate corpus `sum(character substitutions + deletions + insertions) / sum(reference characters)` after the frozen Japanese normalization. Report per-stratum CER too. |
| Word error rate (WER) | Aggregate corpus word errors divided by reference words using one pinned Japanese tokenizer/version/dictionary and frozen normalization. CER is primary if tokenization sensitivity makes WER unstable. |
| VAD false activation | A finalized nonempty utterance with no annotated speech overlap; report count per hour of annotated nonspeech. |
| VAD missed speech | Annotated speech samples not covered by any emitted utterance divided by total annotated speech samples. |
| Boundary loss | Reference characters aligned to speech within the pre/post-boundary audit window that are deleted, reported by onset and offset. Alignment procedure must be pinned before use as a gate. |
| CPU utilization | Process CPU time (`user + system`) divided by elapsed presentation time and logical-core count, ×100; also report unnormalized core-equivalents to avoid ambiguity. Include child processes. |
| Peak memory | Maximum resident set size of app plus attributable backend child processes over a run, in MiB (`bytes / 2^20`); state sampling/API and avoid double-counting shared processes. |
| Steady memory | Median and p95 combined RSS sampled at the approved interval after warmup during a fixed-duration continuous run. |

Report crashes, timeouts, forced finals, dropped/late frames, queue high-water mark, fallback count, and missing outputs as counts, never exclude them from summaries. Energy may be exploratory, but is not a gate until its collection method is approved.

## Apple Silicon device matrix

Run release builds on physical machines, plugged in, with Low Power Mode, competing workloads, temperature controls, and microphone/audio replay method documented.

| Class | Concrete device | RAM | macOS | Purpose |
| --- | --- | --- | --- | --- |
| Oldest supported low tier | TBD | TBD | TBD | Binding latency/resource gate |
| Current mainstream | TBD | TBD | TBD | Primary development comparison |
| Higher-performance tier | TBD | TBD | TBD | Scaling and long-session behavior |

At least one machine must represent the minimum supported Apple Silicon target. Exact models, RAM, OS versions, repeat count, cooling/warmup, and availability require approval. Simulator results do not substitute for physical mobile feasibility measurements.

## Baseline-versus-candidate results (no measurements yet)

Baseline is the current fixed-window `WhisperCLIBackend` configuration. Candidate A is the new VAD/endpoint state machine feeding the same batch backend, isolating segmentation effects. Candidate B is a streaming engine/model selected after feasibility and license review. Candidate C adds optional refinement.

| Configuration | First partial p50/p95 | Endpoint→final p50/p95 | CER | WER | RTF | CPU | Peak/steady RSS | Failures |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline: current fixed windows | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Candidate A: VAD + current backend | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Candidate B: streaming primary | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Candidate C: primary + refinement | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

| Configuration | False activations/hour | Missed-speech rate | Boundary loss | Forced finals | Dropped frames | Fallbacks |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | TBD | TBD | TBD | TBD | TBD | TBD |
| Candidate A | TBD | TBD | TBD | TBD | TBD | TBD |
| Candidate B | TBD | TBD | TBD | TBD | TBD | TBD |

Raw per-fixture records and run manifests are decision artifacts; summary tables alone are insufficient.

## Proposed go/no-go gates—approval required before measurement

Numeric thresholds are intentionally **TBD**. Owners must approve them before locked evaluation to prevent moving gates after seeing results.

| Gate | Proposed comparison | Threshold/status |
| --- | --- | --- |
| Correctness | No invariant violation, audio loss, ordinal gap, duplicate primary final, corrupt store, or unrecoverable model update in fault tests | Zero; proposed, approval required |
| Accuracy | Candidate primary CER non-inferior to baseline overall and within approved critical strata | Margin TBD; approval required |
| Latency | Candidate endpoint→primary-final p50/p95 and first-partial p50/p95 on binding device | Targets/improvement TBD; approval required |
| VAD | Missed-speech, false-activation, and boundary-loss limits | TBD; approval required |
| Resources | CPU and peak/steady RSS on binding device | Ceilings TBD; approval required |
| Reliability | Crash, timeout, dropped-frame, fallback, and long-session success limits | TBD; approval required |
| Distribution | All artifacts pinned, hash-verified, atomically installed, rollback-tested, and usable offline | Required; approval required |
| Legal | Written approval for every code/model/data license and intended distribution/use | Required; no technical override |

A “go” requires every binding gate and an explicit maintainer decision. A miss yields no-go or a newly approved experiment; refinement cannot hide a failing realtime-primary gate. Report confidence intervals or paired bootstrap intervals for accuracy deltas, with the method fixed before locked evaluation.

## sherpa-onnx and model feasibility investigations

Treat all upstream behavior below as unverified until recorded against pinned documentation/source and a minimal spike.

### Desktop/macOS

- Verify supported macOS architectures, Swift/C/C++ integration surface, static/dynamic packaging, minimum OS, threading, cancellation, streaming transducer support, timestamps, endpoint controls, and model format.
- Build a minimal arm64 release spike that consumes the canonical PCM frames and emits the proposed events. Measure binary size, startup/model-load time, RSS, CPU, and teardown/repeated-session behavior.
- Inspect transitive dependencies, notices, code signing/notarization implications, and whether sandboxed offline execution works.

### Web

- Verify official WebAssembly/browser support, build recipe, worker/thread/SIMD requirements, cross-origin isolation, browser storage, model download size, streaming audio transport, and supported browsers.
- Prototype only after confirming the product actually intends a web surface; current `Package.swift` provides none. Measure initial download, compile/load memory, single-thread fallback, and offline caching on physical representative hardware.

### Mobile (iOS first; Android separately if scoped)

- Verify official platform/architecture support, package integration, microphone lifecycle, background/interrupt behavior, memory pressure, thermal/battery impact, model storage limits, and App Store/license constraints.
- Test a physical low-tier supported device. Do not infer mobile feasibility from macOS results or simulator execution.

For all platforms, capture exact upstream commit/release, source links, build flags, observed API signatures, and a pass/fail result. If required functionality needs a fork, estimate maintenance and security-update ownership before candidacy.

### ReazonSpeech Japanese Zipformer candidate

`sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01` is one candidate because the linked upstream page identifies it as Japanese; that does not establish suitability, accuracy, streaming semantics, license compatibility, or redistribution permission. Investigate exact model files, architecture/mode, tokenizer, sample rate, runtime compatibility, size, provenance, upstream checksums, license texts for model/training data/runtime, and intended-use restrictions. Compare it with at least the current baseline and any other approved candidate; do not make it the default before gates pass.

## Model distribution and lifecycle gates

Before any model is offered to users:

1. Maintain a signed/reviewed model manifest containing stable model ID, semantic manifest version, upstream version/URL, runtime compatibility range, file sizes, SHA-256 for every file, license identifiers/text locations, notices, and benchmark decision ID.
2. Download into a unique staging directory. Enforce HTTPS, expected byte limits, and SHA-256 before extraction/use; reject path traversal, unexpected files, digest mismatch, or insufficient disk space.
3. Store immutable versions under an application-owned model directory; never overwrite the active version in place. Avoid bundling until redistribution approval exists.
4. Fully validate and smoke-test staged files, then atomically switch a small active-version pointer/manifest. A crash before the switch leaves the prior version active.
5. Retain at least the last known-good compatible version subject to an approved storage cap. Rollback atomically on failed load/health check or explicit user action; never roll back across an incompatible runtime without validation.
6. Keep application, adapter, runtime, and model versions independently visible in diagnostics and benchmark records. Define migration and garbage-collection rules before automatic updates.
7. Offline behavior: recording and an already configured verified backend continue without network; update checks/downloads fail closed without disabling the last known-good model. First-run absence produces an actionable choice, not an implicit download.
8. License gate: counsel/authorized reviewer records permission for runtime linking, model use, modification, redistribution/download mechanism, notices, and benchmark dataset use. “Open source,” an upstream URL, or a model card is not a conclusion.

Fault tests must cover interrupted download, corrupt archive, wrong digest, disk full, concurrent launch/update, crash before/after atomic switch, incompatible manifest, deleted active model, offline first run, offline normal run, and rollback.

## Staged implementation, tests, and rollback points

1. **Measurement foundation.** Add fixture/run manifests, deterministic audio replay, scorers, telemetry, and baseline runner. Tests validate hashes, normalization/tokenization gold cases, clocks, aggregation, and missing-output accounting. Rollback: tooling only; no app runtime change.
2. **Event contract.** Add backend-neutral streaming events, utterance IDs/revisions/finalization reasons, and strengthen timeline/store invariants without changing the active backend. Unit/property tests cover ordering, idempotence, late events, and crash recovery. Rollback: keep legacy event path behind a build/runtime flag and migrations additive.
3. **VAD state machine in shadow mode.** Feed captured/replayed frames to VAD while current fixed chunks remain authoritative. Compare endpoints without affecting transcripts. Tests use sample-exact synthetic speech/silence and corpus annotations, including stop and continuous speech. Rollback: disable shadow processor.
4. **VAD with baseline backend.** Endpoint utterance WAVs and call existing `WhisperCLIBackend`; retain a configuration switch to fixed windows. Integration tests assert sample coverage, pre-roll once, maximum-duration cuts, queue bounds, and fallback. Rollback: switch sessions to fixed-window capture.
5. **Streaming candidate adapter.** Land only after platform/license investigation. Conformance tests run the same event suite for every adapter; stress repeated start/stop, cancellation, malformed output, slow decoder, and long sessions. Rollback: remove from selectable backends; stored transcripts remain readable.
6. **Model manager.** Implement pinned manifest, staged verification, atomic activation, offline use, and rollback before general distribution. Run the fault matrix above. Rollback: disable updates and select last known-good/local manually provisioned model.
7. **Optional refinement.** Add revision linkage and bounded background scheduling. Tests prove primary durability, source digest linkage, idempotent retry, timeout/failure fallback, and synthesis revision selection. Rollback: stop scheduling refinement; retain primary and historical revisions.
8. **Locked evaluation and decision.** Freeze code/config/manifests, obtain threshold approval, run the device matrix, archive raw results, and complete the decision record. No default switch occurs as part of measurement.

Each slice should be independently reviewable, preserve current session data, and expose an off switch. Any schema migration needs forward/backward compatibility and a backup/restore test before release.

## Validation commands

Existing repository validation:

```sh
./scripts/verify.sh
swift test
swift build -c release --product MyAudioToText
```

Proposed tooling commands (names are design targets and do not exist yet):

```sh
swift run ASRBenchmark validate-fixtures --manifest Benchmarks/fixtures.jsonl
swift run ASRBenchmark run --plan Benchmarks/plans/apple-silicon.json --output .benchmark-runs/DATE-ID
swift run ASRBenchmark score --run .benchmark-runs/DATE-ID
swift run ASRBenchmark compare --baseline BASELINE-RUN --candidate CANDIDATE-RUN
swift run ModelManager verify --manifest Models/manifest.json
```

The benchmark command must refuse a dirty tree unless `--allow-dirty` is explicit and recorded. CI may run only the redistributable smoke set; locked evaluation runs on controlled physical devices and archives manifests, logs, and raw results outside source control as approved.

## Risks and mitigations

| Risk | Mitigation/evidence required |
| --- | --- |
| VAD clips Japanese morae or quiet speech | Bounded pre-roll/hangover, boundary annotations, stratum metrics, sample-coverage tests |
| Partials flicker or duplicate finals | Revision/utterance invariants and backend conformance/property tests |
| Forced cuts lose or repeat content | Sample-exact cut log, zero-overlap initial option, timestamp-aware reconciliation, long-speech fixtures |
| New engine improves latency but harms accuracy | Pre-approved paired gates; isolate VAD, engine, and refinement comparisons |
| Refinement changes trusted evidence | Immutable primary, linked revisions, explicit display/synthesis provenance |
| Decoder blocks capture or grows memory | Bounded queues/buffers, capture priority, persisted-audio recovery, stress/resource gates |
| Benchmark leakage or normalization bias | Speaker-disjoint locked split, frozen policy/tokenizer/scorer, manifest hashes |
| Nonrepresentative corpus/device results | Approved strata, per-stratum reporting, binding low-tier physical device |
| Upstream API/platform assumptions are wrong | Pinned-source investigation and minimal spikes before architecture commitment |
| Model/runtime/data licensing blocks shipping | Written artifact-by-artifact legal gate before download or bundling |
| Corrupt or interrupted updates strand users | SHA-256 verification, immutable storage, atomic activation, last-known-good rollback, offline tests |
| Dependency/fork maintenance becomes costly | Record footprint, release cadence, security ownership, and fork delta in decision |

## Decision record template

```text
Decision ID/date/owners:
Issue and scope:
Approval of corpus, metric definitions, and gates (who/when):
Repository commit and benchmark run IDs:
Fixture-manifest/scorer/tokenizer versions and SHA-256:
Devices/OS/power/thermal controls:
Baseline configuration/model/runtime hashes:
Candidate configuration/model/runtime hashes:
Upstream commits/releases and verified API/platform findings:
License review records for code, models, and data:
Gate table with raw-result links and pass/fail:
Statistical method and uncertainty:
Failures, exclusions (if any), and missing outputs:
Operational footprint (binary/model/storage/update/offline/rollback):
Decision: adopt / adopt slice only / reject / more investigation
Rationale and rejected alternatives:
Approved implementation slices and default/off-switch policy:
Rollback trigger and owner:
Follow-up date:
```

## Open questions requiring explicit resolution

- Which concrete lessons from a pinned hayamimi revision are architectural versus tied to its engine or UI?
- Who approves the benchmark corpus, transcription policy, numeric gates, and legal reviews?
- What is the minimum supported Apple Silicon Mac, and which physical devices are available?
- Which Japanese datasets or contributor recordings can legally be used, stored, and redistributed for smoke and locked evaluation?
- What canonical Japanese normalization and tokenizer should define CER/WER?
- Should application VAD or backend-native endpointing own boundaries, and how will equivalent behavior be demonstrated?
- What proposed values and tuning ranges should be approved for onset, offset, pre-roll, hangover, maximum duration, and forced-cut overlap?
- Should partial timestamps/confidence be required capabilities or optional UI diagnostics?
- How should a refined revision appear to users, and which revision should cleaning, insertion, and synthesis consume?
- What bounded queue and persisted-audio recovery policy is acceptable when decoding falls behind capture?
- Is web/mobile feasibility merely architectural research, or is there an approved product timeline and target hardware/browser matrix?
- Are sherpa-onnx and the referenced ReazonSpeech model compatible with intended platforms and distribution after source and license review?
- Who hosts model artifacts, signs/reviews manifests, responds to upstream security/model updates, and owns storage limits?
- What measurement deltas justify dependency size, maintenance, model download, and migration complexity?
- What exact result triggers automatic runtime fallback or release rollback?
