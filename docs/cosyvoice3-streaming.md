# Local CosyVoice3 streaming (Issue #172)

`CosyVoice3Streaming` runs Fun-CosyVoice3-0.5B-2512 in an extension-owned
WebGPU Worker. It generates speech tokens and transfers mono 24 kHz PCM before
token generation completes. English and Japanese have separate real packaged
MV3 results in the [validation report](evidence/cosyvoice3-172.md). This does
not rely on the Qwen3-TTS evidence. Required verification of the merged revision
remains **pending**, so Issue #172 must remain open.

```text
Text.value / ASR.final / committed translation.text
  → CosyVoice3 0.5B · streaming.text
  → AUDIO_STREAM
  → Speaker · streaming.stream
```

Save prepares **916,881,956 model bytes**, including parked Nodes. Models provides
Download / retry, verification and deletion. Start reads verified cached bytes;
missing, corrupt or evicted assets require preparation again. Keep Live open
and press Start to activate Speaker. There is no recording-time model download,
remote inference, remote code, Python process or whole-model CPU fallback.
Supertonic3, Kokoro, Qwen3-TTS, completed-clip Speaker and manual WAV remain
separate workflows.

## Concrete export and runtime changes

The reviewed Apache-2.0 conversion has all five neural components, tokenizer,
fixed flow noise and a licensed reference voice. All five graphs execute with
stock packaged ORT under the unchanged production MV3 CSP. The original
conversion still cannot stream correctly without these changes:

1. **Flow attention.** Its exporter specializes `streaming=False`. The Worker
   verifies the complete graph digest, then exposes the bias condition of all
   22 DiT attention blocks as `streaming_mask`. The mask permits the current
   50-mel-frame chunk and all preceding chunks, matching the native trained
   chunk grid. Weights and Euler computation remain intact. ONNX input dimensions
   being dynamic alone do not establish these causal semantics.
2. **Flow lookahead.** The exported encoder pads the right boundary for final
   inference. For a nonfinal prefix, supply three real future speech tokens,
   then discard their six mel outputs. Retain already accepted mel instead of
   updating it when a later prefix is recomputed. Align the initial hop to the
   reference prompt: 109 prompt tokens require 41 generated tokens plus three
   lookahead tokens, followed by 25-token hops. Run ten cosine-scheduled guided
   Euler steps over each bounded prefix, with the same noise at each position.
3. **HiFT WebGPU overflow.** Stock ORT 1.31.1's nearest `Resize` asymmetric
   coordinate helper multiplies two `u32` values before division. For the last
   upsampler at 1,000 mel frames, input length is 40,000 and output length is
   120,000; position 107,375 overflows the product. This changed earlier
   waveform samples in the long-prefix check (maximum difference about 0.5085).
   Replace all three integer upsamplers, scales 8/5/3, with equivalent
   `Unsqueeze → Tile → Reshape`. This avoids the product without a patched ORT
   binary. The source and transformed graph digests are pinned.
4. **HiFT finalization.** Recompute the retained mel prefix using fixed source
   noise and withhold eight mel frames of right context: three for F0, four for
   conv-pre and one for iSTFT. Transfer only newly available samples. On real
   token EOS, flush the withheld tail. No completed utterance is cut into chunks
   to simulate streaming, and input text is never split into separate synthesis
   requests.

[`cosyvoice3-onnx.js`](../web/cosyvoice3-onnx.js) performs the two transformations
in memory after explicit asset preparation. Only the reviewed full graph digests
are accepted; all 22 attention sites and all three upsamplers must match.
Original verified bytes stay in Cache Storage. This avoids requiring a new
hosted derivative model release to use the repaired export.

The independent JavaScript generation loop follows the pinned native model's
prompt assembly, 24-layer Qwen2 KV cache, repetition-aware top-p/top-k sampling,
silent-token filtering and flow/vocoder algorithm. It does not redistribute
Quick Inference's PolyForm Noncommercial runtime or patched ORT. The original
conversion is an approximate float32/quantized model, not bit-identical native
Python inference. Differential testing separates small flow rounding differences
from HiFT continuity: retained identical mel and noise must preserve emitted
samples through the full token limit.

## Assets, languages and limits

[All source URLs, immutable revisions, full hashes, sizes and derived graph
hashes](cosyvoice3-artifacts.json) and [1 MiB cache hashes](../extension/cosyvoice3-assets.json)
cover the complete set:

| Component | Selection |
| --- | --- |
| Model | `danyalmalik/Fun-CosyVoice3-0.5B-ONNX-WebGPU`, revision `dcdb9df4bce4a47d318f5f8736de0b080efd944f` |
| Neural graphs | q4 embedding, q8 LLM, q4 flow encoder, q8 flow step, q4/int8-convolution HiFT |
| Tokenizer | Conversion's Qwen2 `tokenizer.json`; packaged Transformers.js 3.8.1 |
| Vocoder/noise | Conversion's HiFT and `[80,3000]` fixed flow noise; per-utterance source noise remains fixed across prefixes |
| Voice | `voice_default.json`, LibriTTS-R speaker 4446, utterance `4446_2275_000002_000009`; CC BY 4.0 |
| Runtime | Stock `onnxruntime-web` 1.31.1, MIT; existing separately pinned TTS WebGPU/asyncify files |
| Native reference | CosyVoice source `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`; official checkpoint `29e01c4e8d000f4bcd70751be16fa94bf3d85a18` |

The model/conversion declares Apache-2.0. The reference features have separate
CC BY 4.0 attribution to LibriTTS-R, Koizumi et al. (2023). See
[notices and attribution](../web/licenses/cosyvoice3.txt) and the included Apache
license. No reference audio is redistributed and no arbitrary voice cloning is
exposed. The ORT/tokenizer pins, licenses and checks remain in
[`scripts/qwen3-tts-runtime.json`](../scripts/qwen3-tts-runtime.json); the directory
name identifies shared runtime files, not another synthesis model.

- English/Japanese text is exposed with one reference voice. The model infers
  the spoken language from the text; the saved language choice describes the
  intended input. Only NFKC normalization is applied. Spell out numbers and
  symbols; the native wetext normalizer is not included. Other languages,
  arbitrary control tags and pronunciation quality across domains are unqualified.
- The shared stream owner accepts 300 characters per utterance, 16 accepted
  utterances and 4,800 characters including current work. The tokenizer also
  enforces 128 text tokens. Repeated strings are separate utterances; provisional
  input is rejected. Queue overflow visibly rejects new work while accepted work
  drains. Saved graph edits apply next session.
- Generation is capped at 500 speech-token steps, at most 20 seconds of audio.
  Reaching the text-dependent token cap or hard cap without EOS visibly aborts
  instead of reporting truncated audio as successful. Model KV history, flow
  masks (at most 1,218 frames), mel, source noise and waveform recomputation are
  bounded. The first PCM normally covers 1.48 seconds, later chunks one second,
  and EOS flushes the tail. Very short utterances can finish before first PCM.
- PCM transfers require acknowledgment, with one chunk in flight. The existing
  producer-independent Speaker enforces eight seconds/64 chunks/8 MiB. Stop
  drains accepted generation and playback. Cancel or teardown terminates the
  owned Worker and stops audio immediately; retired replies cannot replay PCM.
- Prefix recomputation can fall behind playback even on the tested M4 Max.
  Speaker reports underruns and applies its normal 40 ms restart lead when the
  queue is empty. Available consecutive chunks still share the audio clock.
  This path does not promise uninterrupted real-time synthesis or unlimited
  input throughput. Reduce input length/rate when it cannot keep up.
- Desktop Chrome with working Worker WebGPU is required. Allow **3 GB storage
  and 6 GB free RAM/GPU memory per active Node** as planning estimates, not
  measured minimums. Acceptance covers only the documented Apple M4 Max,
  64 GiB unified-memory machine. Other GPUs, low-memory devices, mobile,
  sustained multi-Node use and GPU device-loss recovery are unqualified.

## Reproduce validation

```sh
npm run setup:extension
python3 scripts/review-cosyvoice3-assets.py  # explicit ~917 MB model download
npm test

# Controlled transport checks, no model inference claim:
STREAMING_TTS_MODEL=cosyvoice3 TTS_BROWSER_CHANNEL=chrome \
  npx playwright test --config playwright.extension.config.js tests/extension/streaming-tts.spec.js

# Actual built package, real pinned models and native audio clock:
STREAMING_TTS_MODEL=cosyvoice3 STREAMING_TTS_SMOKE=1 \
  TTS_EXTENSION_ROOT=dist/chrome-extension TTS_BROWSER_CHANNEL=chrome \
  npx playwright test --config playwright.extension.config.js tests/extension/streaming-tts.spec.js
```

`COSYVOICE3_MODEL_DIR` can select another directory containing the same reviewed
files. The fixture serves weights over loopback only during explicit Save/Models
preparation, retaining production sizes/hashes. It then starts offline and checks
that neither the page nor Worker downloads weights. The copied package keeps
production inference, graph, cache and CSP code. Observation hooks record Worker
generation state, first chunk, scheduling, nonzero analyser rendering, EOS,
consecutive utterances, Stop, Cancel and WAV. A separate real graph check covers
flow masks, right context and the long-prefix Resize regression through the cap.
The sampled process RSS includes browser overhead/shared pages and does not
isolate GPU driver allocations; it is an observation, not a minimum-memory claim.

Required **post-merge verification: pending**. Rebuild the merged revision with
the same asset/runtime pins, repeat English and Japanese packaged checks on
documented hardware, and record first chunk/render/EOS timing and memory. Expect
nonzero playback while generation is incomplete, ordered boundaries, bounded
queues, Stop drain, immediate Cancel and no Start-time model network requests.
Record underruns rather than treating them as gap-free real-time evidence.
