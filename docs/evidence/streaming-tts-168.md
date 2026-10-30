# Issue #168 — local streaming TTS evidence

Status: **partial**. Qwen3-TTS has a real local MV3 streaming implementation;
CosyVoice3 remains unsupported. Its remaining implementation and verification
are now explicitly tracked in [Task #172](https://github.com/takahirox/my-audio-to-text/issues/172),
as permitted by requirement 6 and the tracking update in
[Issue #168](https://github.com/takahirox/my-audio-to-text/issues/168).
[PR #170](https://github.com/takahirox/my-audio-to-text/pull/170) remains draft
pending review of the parent's bounded acceptance. Use `Refs #168` and keep the
Issue open while acceptance and required post-merge verification are pending.
The measurements below are implementation-stage evidence, not new runs or
post-merge results.

## Environment and assets

- 2026-10-30; Apple M4 Max, 64 GiB unified memory, macOS 27.2.
- Chrome 156.0.8078.74, Apple / Metal 3 WebGPU, native Web Audio output.
- Qwen3-TTS 0.6B CustomVoice conversion `ccdd14012062ee383dda616d7799cc955924af8a`
  and codec `b2aa169358f3ba36110a9c9ce7d5a75209e39b7f`;
  [full reviewed manifest](../streaming-tts-artifacts.json).
- Stock ORT Web 1.31.1 and Transformers.js 3.8.1 tokenizer; the runtime and all
  notices are hash-pinned, staged locally and checked by the extension build.
- The final real tests load the complete output of `npm run build:extension`
  (`TTS_EXTENSION_ROOT=dist/chrome-extension`), including all normal runtime
  bundles. Production manifest/CSP, UI, graph, cache, session, Nodes and Workers
  are preserved.
  Weights are served from loopback with unchanged production sizes/chunk hashes
  and prepared through Save/Models. Inference uses the actual pinned assets;
  no synthesizer, WebGPU backend, audio renderer or clock is mocked.

## Real incremental playback

[Raw timestamps](streaming-tts-168.json) include Worker start/chunk/EOS, native
source schedule times, and the first nonzero Web Audio analyser render for each
utterance. Each language has two committed utterances handled in order by one
Worker; the second is accepted while the first is generating. Save/reload,
cache-only Start, Stop-drain and a new session's immediate Cancel are exercised.
The browser is explicitly offline during Start, generation, playback and Cancel;
no HTTP requests occur. Queue bytes reach
zero on Stop; AudioContexts close. Sources schedule exactly at the previous
source's end, without overlap or inserted gaps.

All times below are milliseconds after the corresponding Worker's utterance
start; they include real model computation, not an artificial completion delay.

| Language / utterance | First PCM | First nonzero render | Synthesis EOS | Chunks |
| --- | ---: | ---: | ---: | ---: |
| English 1 | 1922.96 | 1966.45 | 5316.54 | 9 |
| English 2 | 450.59 | 2409.24 | 2695.61 | 7 |
| Japanese 1 | 577.25 | 619.21 | 5324.40 | 12 |
| Japanese 2 | 505.75 | 2734.29 | 3127.67 | 8 |

Second utterances wait behind accepted playback; their PCM nevertheless arrives
incrementally, and in these runs their actual first rendered audio precedes EOS.
This cannot be promised for every queued or very short utterance. These are
measured samples on one machine, not latency or real-time guarantees.

The [English WAV](streaming-tts-168-english.wav) and
[Japanese WAV](streaming-tts-168-japanese.wav) contain the actual emitted PCM,
concatenated in stream order and encoded as 16-bit WAV by the existing helper.
Their SHA-256 digests are in the JSON evidence. Physical loudspeaker acoustics
are not measured by an analyser on the browser's render graph.

An independent browser-local Whisper tiny q8 sanity check, using the repository's
pinned `scripts/whisper-assets.json` model and packaged translation runtime,
transcribed these WAVs as:

- English: “Hello, this speech has generated locally while the first audio is
  already playing. Thank you. This is the second committed utterance.”
- Japanese: “こんにちはこれは日本語の音声です。音声を作りながら順番に再生します。
  次の文章も同じワークアで順番に読み上げます。”

The automatic transcript differs from the inputs (“has” versus “is”, ワークア
versus ワーカー). This sanity check does not separate synthesis errors from
recognition errors, measure speech quality or establish perfect pronunciation.
Exact input sentences and generated audio are retained for review.

## Decoder continuity and deterministic checks

[Real decoder reference](streaming-tts-168-decoder.json): 256 frames/20.48 seconds,
fixed valid codec IDs, prefix decoding in eight-frame emissions with two-frame
lookahead versus a full decode. Maximum absolute sample difference:
**0.000013753771781921387**, below the `0.0001` tolerance. This exercises actual
pinned ONNX/WebGPU decoding, including later boundaries. Shortening the left
context was rejected because stacked attention changed the waveform; the shipped
implementation retains a bounded full prefix instead.

Deterministic tests cover independent typed producers, port incompatibility,
sequence/boundary/replay checks, native sample rates, snapshot/fan-out safety,
queue saturation, persistent overflow diagnostics, paused audio/activation,
Stop-drain, abort, Cancel, load cancellation, late replies and callbacks, repeated
committed strings, explicit provisional rejection, Save/reload without migration,
shared preparation and gesture-before-model-loading. Cache tests verify missing,
evicted, corrupt and inaccessible assets never trigger weight downloads.

Final checks:

| Check | Result |
| --- | --- |
| `npm test` | **736 passed**, zero skipped/failed |
| `npm run prepare:tts-assets` | All archives, runtime/tokenizer files and notices verified; 106,440,918 bytes staged |
| Normal asset preparation + `npm run build:extension` | **Passed**; 375 MiB complete extension; packaged source compared byte-for-byte to the worktree |
| `STREAMING_TTS_SMOKE=1 TTS_BROWSER_CHANNEL=chrome TTS_EXTENSION_ROOT=dist/chrome-extension npx playwright test --config playwright.extension.config.js tests/extension/streaming-tts.spec.js` | **2 passed** in 51.2 s: real decoder reference and real English/Japanese saved-graph playback, including consecutive utterances and Stop/Cancel; browser explicitly offline during Start/playback |
| Controlled MV3 transport test | **Passed**; real-model-only decoder check intentionally skipped in this mode |
| `TRANSLATION_CHANNEL=chrome npx playwright test tests/browser/speaker.spec.js --project=chromium` | **3 passed**, existing completed-clip Speaker automatic ordering, activation recovery and Cancel/restart |
| Reviewed model files versus full and 1 MiB chunk hashes | **All 9 match**, 689,926,071 bytes |
| Python syntax and `git diff --check` | **Passed** |

The real run resampled 24 kHz model PCM into a **48 kHz AudioContext**. Stop
released all queued bytes and closed the context; Cancel did the same during
generation without any subsequent scheduling. Reproduction and limitations are
in [streaming TTS documentation](../streaming-tts.md#reproduce-checks).

## Remaining scope and post-merge verification

CosyVoice3 is unsupported and absent from the palette/runtime. Its reviewed
browser export bakes in whole-utterance flow/HiFT finalization. The
[candidate conclusions](../streaming-tts.md#separate-candidate-conclusions)
record exact official/community revisions, tokenizer/vocoder and licensing
considerations, and the export/runtime work needed. No CosyVoice3 browser
inference, pre-EOS audio or hardware claim is made. [Task #172](https://github.com/takahirox/my-audio-to-text/issues/172)
preserves that work, including pinned browser assets, streaming Worker execution,
stream/Speaker lifecycle regressions and real-model verification. This allowed
split requires no additional scope approval solely for delivering Qwen3-TTS;
the parent's original bounded acceptance still requires review.

**Post-merge verification: pending.** Build/load the merged extension and repeat
real Japanese/English first-chunk/render/EOS timing, consecutive utterances,
Stop/Cancel and offline Start with exact pins. Record hardware and peak memory.
Other GPUs/browsers, lower-memory/mobile devices, long-session peak memory and
GPU-loss recovery remain unqualified. Planning estimates are not measured
minimum hardware requirements. The follow-up does not waive implementation or
verification requirements, and pending post-merge checks prevent a claim of
fully verified Issue completion.

## Tracking reconciliation and acceptance review — 2026-10-31

Read the live #168, draft PR #170 and open draft Task #172, together with the
repository's development flow and review guidelines. Task #172 explicitly
retains the CosyVoice3 export/runtime implementation and real-model verification.
The checked-in PR-description artifact now uses `Refs #168`, links that Task,
and removes the obsolete claim that the split still needs a scope decision.
Keep the PR draft for acceptance review and keep post-merge verification pending.
No GitHub metadata was changed during this revision.

Fetched and merged current `origin/main` at
`7c4442d1bb5cad2cf15ab619b38be9c5c0870efc` without conflicts. This includes #169's
provisional paired-text fix. Reviewed the original bounded acceptance against
the implementation and evidence, rather than inferring completion from the split:

| Original acceptance | Implementation and evidence reviewed |
| --- | --- |
| Real saved-graph Japanese/English speech before synthesis completes | The owned Qwen Worker runs the talker/predictor loop and decodes prefixes every eight frames with two-frame lookahead; it does not wait for EOS to split a finished waveform. The implementation-stage packaged-extension JSON records first nonzero render before EOS for both languages and both utterances. Rechecked those timestamps, chunk sequences, scheduled continuity and WAV hashes against the retained files. This is existing real-model evidence, not a fresh inference run. |
| Separate browser feasibility conclusions | The candidate report pins the Qwen model/tokenizer/codec/runtime set and documents the CosyVoice3 export's whole-utterance flow/HiFT finalization. CosyVoice3 has no palette/runtime Node; #172 retains its implementation and verification. No CosyVoice3 inference or hardware result is claimed. |
| Ordered boundaries, bounded queues, Stop/Cancel and late replies | Reviewed `audio-stream.js`, `qwen3-tts-node.js`, its owned Worker and `speaker-output.js`: explicit start/chunk/end/abort events, increasing IDs/sequences, one PCM transfer awaiting acknowledgement, bounded text/audio queues, Stop-drain, Worker termination and late-reply guards. The deterministic suite includes overflow followed by abort, replay/order errors, repeated committed strings, activation recovery and independent producers. The controlled MV3 test checks native scheduling, ordered utterances, Stop and Cancel. |
| Graph, preparation, CSP, diagnostics and existing paths | `AUDIO_STREAM` remains distinct from completed clips; graph version is unchanged. Save/Models prepares reviewed assets and the Worker verifies cached bytes only at Start. Missing/corrupt/evicted cache tests pass. The controlled MV3 test saves/reloads explicit ports under the production CSP. Existing Supertonic3/Kokoro, player/WAV and completed-clip Speaker browser checks pass. Main's DOM/translation regression checks also pass; provisional text remains rejected by Qwen. |
| Real browser checks plus deterministic coverage and honest limits | Existing real-model playback and decoder evidence are retained separately from this revision's controlled transport tests. No pinned Qwen model weights are present here (0 of 9 files), so the real-model tests were not rerun. Hardware, minimum/peak memory and long-session limits above still apply. The decoder reference remains finite and below its documented continuity tolerance. |
| Local-only genuine streaming, with no speculative framework | Reviewed the Worker/runtime, cache preparation and packaging paths: local pinned runtime imports, explicit model preparation, cache-only Start, required WebGPU and no server/cloud or whole-model CPU fallback. Streaming Speaker is a distinct typed input on the existing Speaker path. Existing pre-EOS evidence supports the Qwen streaming label; CosyVoice3 remains unsupported. |

Revision checks after main integration:

| Check | Result |
| --- | --- |
| `npm test` | **749 passed**, zero failed/skipped |
| `TTS_BROWSER_CHANNEL=chrome npx playwright test --config playwright.extension.config.js tests/extension/streaming-tts.spec.js` | **1 controlled MV3 test passed**, **1 real decoder test intentionally skipped** without `STREAMING_TTS_SMOKE=1`; no new real inference claim |
| `ASR_BASE_URL=http://127.0.0.1:18768 TRANSLATION_CHANNEL=chrome npx playwright test tests/browser/speaker.spec.js tests/browser/tts.spec.js tests/browser/dom-display.spec.js tests/browser/translation-ports.spec.js --project=chromium --workers=1` | **35 passed** on Chrome 156, served from this worktree using the existing Pages handler on an isolated local port because 8000 was occupied |
| `npm run prepare:tts-assets` | **Passed**, 106,440,918 bytes staged; pinned Qwen runtime/tokenizer/notices sizes and hashes rechecked |
| Model manifests and retained evidence consistency | **Passed**: nine model paths/URLs/sizes and chunk-hash counts agree; retained WAV hashes, timing/order/drain records and real decoder tolerance agree. Model weight hashes were not rechecked without the files. |
| PR artifact and whitespace | **Passed**: valid JSON, non-closing `Refs #168`, #172 link, unsupported status and pending post-merge verification retained; `git diff --check` and `git diff --check origin/main...HEAD` |

The complete extension build and real-model tests were not rerun in this
revision; their earlier implementation-stage results above remain historical.
Required verification of the merged packaged extension is still **pending** with
the expected results specified above. This review creates no substitute human
result, CosyVoice3 completion claim or waiver of the parent's bounded acceptance.
