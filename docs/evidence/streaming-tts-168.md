# Issue #168 — local streaming TTS evidence

Status: **partial**. Qwen3-TTS has a real local MV3 streaming implementation;
CosyVoice3 does not. Keep #168 open until CosyVoice3 ships or its remaining
scope is explicitly split. No push, PR, merge, comment or external follow-up
issue is part of this checkpoint. Required post-merge verification is pending.

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
inference, pre-EOS audio or hardware claim is made.

**Post-merge verification: pending.** Build/load the merged extension and repeat
real Japanese/English first-chunk/render/EOS timing, consecutive utterances,
Stop/Cancel and offline Start with exact pins. Record hardware and peak memory.
Other GPUs/browsers, lower-memory/mobile devices, long-session peak memory and
GPU-loss recovery remain unqualified. Planning estimates are not measured
minimum hardware requirements. These limits and the CosyVoice3 scope decision
prevent a claim that all of #168 is complete.
