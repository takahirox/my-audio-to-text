# Local streaming TTS (Issue #168)

**Qwen3-TTS 0.6B CustomVoice has a working local MV3 streaming path. CosyVoice3
remains unsupported; its remaining implementation and real-model verification
are tracked in [Task #172](https://github.com/takahirox/my-audio-to-text/issues/172),
as permitted by requirement 6 of [Issue #168](https://github.com/takahirox/my-audio-to-text/issues/168).**
Review of #168's bounded acceptance remains required. The split preserves the
CosyVoice3 work and does not establish that it shipped. Required post-merge
verification remains pending; no production verification is claimed.

## Graph and preparation

```text
Text.value / ASR.final / committed translation.text
  → Qwen3-TTS 0.6B · streaming.text
  → stream: AUDIO_STREAM
  → Speaker · streaming.stream
```

Choose language (`japanese`/`english`) and voice (`ono_anna`/`ryan`) explicitly
in the TTS inspector. Match the voice's native language for best pronunciation.
Save prepares the same 690 MB asset set for either voice/language, including
parked Nodes. The existing Models page provides Download / retry, verification
and deletion. Press Start in Live to activate audio and keep Live open. Start
reads verified cached weights only. Missing/evicted assets require Models
preparation; no recording-time download, server, Python process, remote code or
whole-model CPU/cloud fallback is provided.

Route committed utterances only. Plain TEXT has no revision identity: the Node
cannot recognize arbitrary unmarked previews. Explicitly provisional deliveries
are rejected; revisable ASR provisional outputs must go to a display instead.
Equal committed strings are separate utterances and are intentionally spoken
again. Saved edits/reconnections apply at the next session. Incremental text
input is not exposed.

Existing Supertonic3, Kokoro, `SYNTHESIZED_AUDIO`, completed-clip Speaker, Audio
player / WAV and saved graph version are unchanged. The new streaming output
cannot connect to a completed-clip input. No migration or hidden model switching
occurs.

## Actual incremental generation

The owned Worker runs the Qwen talker and code predictor to produce 16 codec
codes per 80 ms frame. Every eight frames it decodes and transfers 640 ms of
24 kHz PCM while generating later frames. Two frames of lookahead avoid decoder
right-boundary artifacts. EOS flushes the remaining tail. This never waits for
full synthesis before splitting PCM and does not split text into separately
synthesized sentences.

The first transfer needs ten codec frames. Very short utterances can reach EOS
before this first transfer; early playback is demonstrated with longer utterances,
not promised for every single-word input.

The selected codec export has no incremental cache inputs. Recomputing its
causal prefix preserves sample continuity. Retaining all generated frames is
bounded by a **256-frame/20.48-second generation limit**. A real decoder check
compares emitted prefix samples against full decoding through this limit.
Trimming to 128 or 192 historical frames was rejected during investigation
because stacked attention changed later samples. There is no speculative codec
state/cache protocol. Prefix recomputation can slow longer utterances; shorten
inputs if generation cannot keep up with playback.

The Worker waits for acknowledgment of each PCM transfer before generating further chunks;
only one chunk is in flight. This bounds transport, not end-to-end latency.
Speaker uses hard playback queue limits. If earlier speech is still playing,
a later utterance can finish generating before its playback starts. Hardware
speed and input rate determine sustainable operation.

## Public port, limits and lifecycle

`AUDIO_STREAM` is a producer-independent identity distinct from
`SYNTHESIZED_AUDIO`. Its read-only mono PCM events are:

| Event | Fields | Meaning |
| --- | --- | --- |
| `start` | `id`, `sampleRate`, `channels: 1` | Begin utterance; rate remains fixed until terminal event |
| `chunk` | `id`, `sequence`, `samples: Float32Array` | Nonempty finite PCM, at most two seconds |
| `end` | `id`, `sequence` | EOS; no more PCM follows |
| `abort` | `id`, `sequence`, `message` | Stop this failed utterance's pending/playing audio |

IDs are increasing positive safe integers over the producer's lifetime. Chunk
sequence starts at zero; terminal events carry the next expected sequence.
Speaker rejects replay, skipped/repeated/reordered chunks, cross-utterance data,
overlapping starts and missing terminal boundaries. Timing fields are diagnostics,
not required contract fields. Any producer can implement the port; Speaker never
examines producer type, output name, text or neighbors.

Speaker schedules buffers at successive ends on the AudioContext clock, without
waiting for main-thread `onended` delivery. Web Audio resamples the native rate
to the output device rate. A 40 ms lead applies only at idle/underflow; there is
no inserted silence between queued chunks. Underruns are observable. Existing
Start/Enable speaker activation recovery retains accepted PCM while suspended.

- TTS accepts 300 characters/256 text tokens per input, with at most 16 accepted
  utterances/4,800 characters including current work. Blank text emits nothing.
  Text overflow visibly rejects new utterances until restart; accepted work
  drains. Reaching the 20.48-second cap without EOS aborts visibly rather than
  silently presenting truncated speech as complete. Split longer text upstream.
- Speaker holds at most eight seconds, 64 chunks or 8 MiB including scheduled
  audio. Overflow visibly rejects further audio until restart; accepted chunks
  drain. This can leave speech partially spoken. Stop, reduce the input rate and
  Start again; no recovery replays samples.
- Stop drains accepted text, generation, terminal events and accepted playback
  in order. Cancel terminates the Worker immediately, discards pending text/PCM,
  stops scheduled sources and closes audio. Teardown releases the same resources;
  late replies/callbacks cannot restart disposed playback.
- Generation errors emit `abort`, remove that utterance's scheduled audio, discard
  queued generation and report through existing diagnostics. Earlier completed
  utterances can finish; independent graph paths continue.

## Reviewed assets and hardware

[Full digests/sizes/URLs](streaming-tts-artifacts.json) and
[cache chunk hashes](../extension/qwen3-tts-assets.json) identify all **689,926,071
model bytes**. `scripts/review-qwen3-tts-assets.py` reproduces the manifest from
those reviewed full digests, explicitly downloading weights.

| Component | Immutable selection | Role/license |
| --- | --- | --- |
| Model | [Danyal Malik CustomVoice ONNX](https://huggingface.co/danyalmalik/Qwen3-TTS-12Hz-0.6B-CustomVoice-ONNX-WebGPU/tree/ccdd14012062ee383dda616d7799cc955924af8a) | q4 float32 talker, q8 float32 predictor, q4 embeddings, config and Qwen2 tokenizer; Apache-2.0 |
| Codec | [Danyal Malik 12 Hz ONNX decoder](https://huggingface.co/danyalmalik/Qwen3-TTS-Tokenizer-12Hz-ONNX-WebGPU/tree/b2aa169358f3ba36110a9c9ce7d5a75209e39b7f) | `tok_decoder_q4.onnx`, 100,611,208 bytes; Apache-2.0 |
| Inference runtime | stock `onnxruntime-web` **1.31.1** | Separate packaged WebGPU/asyncify files; MIT |
| Tokenizer runtime | existing Transformers.js **3.8.1** | Construct Qwen2Tokenizer directly from reviewed JSON; Apache-2.0 |

[TTS staging](../scripts/prepare-tts-assets.py) verifies ORT archive SHA-256
`bdccdb9fbb9ab537247c0c734e9b1d2b1b338b4f2a09faa58f0dc1cfa27c312c`
and allowlists three runtime files. The npm archive omits notices; staging also
pins its MIT license/third-party notices from ORT commit
`6af1a932e2286d5c58166085d24c68783033edee` and the conversion's Apache license.
Existing TTS runtimes remain isolated. CSP remains
`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`.

This repository implements the model loop itself. It does not redistribute
Quick Inference's PolyForm Noncommercial runtime or use its patched ORT binaries.
The Apache model exports are reviewed independently. See
[attribution/notices](../web/licenses/qwen3-tts.txt). ORT may place shape/control
operators on CPU while neural inference uses WebGPU; an absent/failed GPU does
not trigger a whole-model CPU fallback.

Allow **2 GB free storage and 6 GB free RAM/GPU memory per active TTS Node** as
planning estimates for cache, host/GPU weights, KV caches and decoder workspaces,
not measured minimums. Acceptance used an Apple M4 Max, 64 GiB unified memory,
macOS 27.2, Chrome 156.0.8078.74, Apple Metal 3. Lower-memory devices, other GPUs,
mobile, other Chrome versions, long-session peak memory and GPU device-loss
recovery are unqualified. No minimum GPU can be certified from one machine.
Use current desktop Chrome with hardware acceleration; failures stay visible.

## Separate candidate conclusions

### Qwen3-TTS 0.6B CustomVoice: working local MV3 streaming

The [official checkpoint](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice/tree/85e237c12c027371202489a0ec509ded67b5e4b5)
contains BF16 weights: 1,811,626,576 bytes for the model plus 682,293,092 for its
speech tokenizer. Those are not browser ONNX. The
[pinned Python wrapper](https://github.com/QwenLM/Qwen3-TTS/blob/022e286b98fbec7e1e916cb940cdf532cd9f488e/qwen_tts/inference/qwen3_tts_model.py#L732)
explicitly describes `non_streaming_mode=False` as simulated text input and
returns completed waveforms; that flag is not streaming evidence. The
[ONNX Community snapshot](https://huggingface.co/onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice/tree/18b0bf898d211718bc33082fadc36a448e0cbc0c)
offers native CPU/CUDA configurations and Python inference, not a Transformers.js
streaming API. The selected WebGPU exports provide the full browser component
set. Real execution below establishes support, rather than a model card or
the presence of an ONNX file.

### Fun-CosyVoice3 0.5B: blocked; no runnable Node

The [official checkpoint](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/tree/29e01c4e8d000f4bcd70751be16fa94bf3d85a18)
includes `llm.pt` (2,024,669,519 bytes), `flow.pt` (1,329,116,148), `hift.pt`
(83,202,622), Qwen2 tokenizer files, CAM++ and speech-tokenizer ONNX graphs. Its
ONNX flow estimator is only one component. The
[native source examined](https://github.com/QwenAudio/CosyVoice/tree/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc)
provides Python streaming, not Chrome execution.

The [WebGPU conversion examined](https://huggingface.co/danyalmalik/Fun-CosyVoice3-0.5B-ONNX-WebGPU/tree/dcdb9df4bce4a47d318f5f8736de0b080efd944f)
does provide LLM, flow, HiFT, tokenizer, fixed noise and precomputed reference
voice assets. Its concrete streaming blocker is the
[pinned exporter](https://github.com/mdanyalmalik/quick-inf/blob/3a27ecbd9efaced7274231bf1d922d6827253d84/tools/export/export_cosyvoice3.py):
the flow encoder finalizes whole utterances (lines 148–169), flow calls
`streaming=False` (187), and HiFT exports `finalize=True` (204). Its
[matching runtime](https://github.com/mdanyalmalik/quick-inf/blob/3a27ecbd9efaced7274231bf1d922d6827253d84/src/runtime/speech/speech-engine.ts#L1430)
collects speech tokens to EOS before flow/vocoding. Splitting that completed PCM,
or separately synthesizing 80-token text segments, would fail this issue.
The [ayousanz ONNX snapshot](https://huggingface.co/ayousanz/cosy-voice3-onnx/tree/4ed032d72f396804d21b508bec7b6ad7c3b1b763)
also documents Python/native inference, not an MV3 streaming implementation.

No real CosyVoice3 inference, playback or hardware qualification was performed
here. The weights declare Apache-2.0; the WebGPU conversion's LibriTTS-R reference
voice separately requires CC BY 4.0 attribution. Tokenizer, flow/vocoder state
and memory must be reviewed as well as LLM weights.

**Remaining implementation in [Task #172](https://github.com/takahirox/my-audio-to-text/issues/172):**
export/review incremental flow masks,
lookahead/finalization and HiFT overlap/cache state, implement the matching
Worker/tokenizer/voice path, then prove real pre-EOS playback in MV3 with
memory/timing evidence and separate Japanese/English results where supported.
The Task remains draft while the browser export/runtime blocker is unresolved.
Do not expose a CosyVoice3 Node or mark its implementation complete until that
work passes validation. The parent Issue explicitly permits this follow-up;
no further Qwen-only scope approval is required solely for the split. All of
#168's bounded acceptance and required post-merge verification still apply.

## Reproduce checks

```sh
npm ci
npm run prepare:tts-assets
npm test
TTS_BROWSER_CHANNEL=chrome npx playwright test --config playwright.extension.config.js tests/extension/streaming-tts.spec.js

# Explicit real-model test preparation (~690 MB).
python3 scripts/review-qwen3-tts-assets.py
STREAMING_TTS_SMOKE=1 TTS_BROWSER_CHANNEL=chrome npx playwright test --config playwright.extension.config.js tests/extension/streaming-tts.spec.js
```

Omit `TTS_BROWSER_CHANNEL=chrome` for Playwright's installed Chromium.
`QWEN3_TTS_MODEL_DIR` can point to the same reviewed files elsewhere. The focused
fixture packages production manifest/CSP, UI, graph, cache, session, Nodes,
Workers and TTS runtime, omitting inactive ASR bundles. It serves real pinned
weights from loopback with **unchanged production sizes/hashes**, exercises
Save/Models verification, then asserts no recording-time HTTP. The controlled
transport mode is explicitly separate from real inference.

To test a complete build instead of the focused fixture, run the normal extension
setup/build and set `TTS_EXTENSION_ROOT=dist/chrome-extension` on either test
command. Tests copy that exact package before adding observation/asset-serving
fixtures; inference/runtime code stays unchanged.

The real test records native scheduling, first nonzero analyser-render timestamps,
PCM/WAV, consecutive utterances, Stop and Cancel. A separate real-codec reference
check compares incremental prefixes against full decoding. No synthesis or audio
clock is mocked in real mode; physical loudspeaker acoustics are not measured.
See [evidence report](evidence/streaming-tts-168.md),
[timestamps](evidence/streaming-tts-168.json),
[English WAV](evidence/streaming-tts-168-english.wav) and
[Japanese WAV](evidence/streaming-tts-168-japanese.wav).

**Required post-merge verification: pending.** Build/load the merged packaged
extension with the exact pins on documented hardware. Repeat both languages,
capture first chunk, first rendered/audible audio and EOS, exercise ordered
utterances and Stop/Cancel, and measure peak memory. Expect pre-completion audio,
contiguous playback and no recording-time downloads. Local pre-merge evidence
does not verify the merged package.
