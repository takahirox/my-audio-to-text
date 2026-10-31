# Optional Parakeet v3 and Moonshine Medium English Streaming (#121)

These are independent Chrome extension processor Nodes. Add either or both in
Graph Editor. Existing ReazonSpeech, Whisper tiny, Zipformer, default graph,
Graph v10 preserves these ASR contracts and migrates saved display state into explicit TextAccumulator processors.
Successful fixture recognition is **not a quality comparison**, WER/CER result,
meeting-room validation or user acceptance.

## Setup and wiring

Run `npm run setup:extension` and load `dist/chrome-extension` as described in
[extension setup](chrome-extension.md). Setup packages about **41 MB** of optional
ASR JS/WASM plus license notices; it does **not** fetch these models' weights.
After updating an already prepared checkout, run:

```sh
npm ci
npm run prepare:optional-asr-assets
npm run build:extension
```

Search Add Node for **Parakeet** or **Moonshine**. Both consume the unchanged
`audio: MONO_16KHZ_PCM` (mono 16 kHz Float32Array) from Chrome tab, microphone or
selected-media capture. Capture and resampling use the existing helpers.

| Node | Outputs | Suggested wiring |
| --- | --- | --- |
| `SpeechToTextParakeetV3` | `final: TEXT` only | final → TextAccumulator.append |
| `SpeechToTextMoonshineMediumEn` | `provisional: TEXT`, `final: TEXT` | provisional → TextToDOM → DOMCombiner.second; final → TextAccumulator.append → TextToDOM → DOMCombiner.first |

Finals are ordinary committed strings. Fan out independently to TextFormatter,
OPUS-MT.text, focused text output or other TEXT consumers. Each Node owns a
Worker/runtime; multiple instances can coexist. No model selector, global model
registry or graph cardinality restriction is introduced.

Before Save, the editor shows download/storage/memory guidance for these Nodes.
**Save graph → prepare required weights** follows every saved model-bearing Node,
including disconnected/parked Nodes; repeated same-model Nodes share cached
weights, not inference Workers. Merely adding, loading or editing a Node does
not download weights. A parked Node does not allocate a runtime at Start.

| Model | Download | Storage guidance | Runtime guidance |
| --- | ---: | --- | --- |
| Parakeet v3 FP16/int8 | 1,257,264,588 bytes (1.26 GB) | Allow 3 GB including preparation/cache overhead | Allow 6 GB free RAM/GPU memory; WebGPU with shader-f16 and ≥128 MiB storage buffer bindings |
| Moonshine Medium English Streaming | 304,690,919 bytes (305 MB) | Allow 700 MB | Allow 2 GB free RAM; CPU SIMD/threaded WASM; extension cross-origin isolation |

Allow **at least 12 GB free memory** to try both together. These are conservative
starting allowances, not enforced quotas or guarantees. Browser/driver copies,
preparation and other paths add overhead. The M4 Max concurrent test sampled
roughly 9 GB across Chrome processes; see [measured evidence](evidence/optional-asr-121.md).
Parakeet has no CPU-only fallback or model substitution. GPU capability is checked
before loading weights; initialization/inference/device errors are visible.
Moonshine does not use the GPU. Both need a desktop Chrome version supporting
their capabilities; packaged inference was tested on Chromium 153/macOS/Apple
Silicon, not on Windows, Linux, mobile or low-memory hardware.

Graph Editor and Models provide progress, Cancel, Retry preparation, Check cache,
and model-specific errors. Models also offers Delete cached assets. Missing,
corrupt or evicted weights require **Save/Retry preparation before Start**.
Completed verified files survive a failed download and are reused on retry;
partial files restart from their beginning. A failure does not roll back the
saved graph. Free storage or delete unused cached models on quota errors. No
`unlimitedStorage`, host permission or recording permission was added.

## Exact artifacts, provenance and terms

The authoritative model manifests are
[`parakeet-v3-assets.json`](../extension/parakeet-v3-assets.json) and
[`moonshine-medium-en-assets.json`](../extension/moonshine-medium-en-assets.json).
They record origin, exact revision/source URLs, bytes, whole-file SHA-256 and
consecutive 1 MiB SHA-256 block hashes. Download, cache inspection and startup
use the existing streaming checksum-verifying cache. Runtime source and packaged
hashes, sizes, npm integrity and origins are in
[`optional-asr-runtime.json`](../scripts/optional-asr-runtime.json) and
`package-lock.json`; preparation/build fail on mismatches.

### Parakeet

- Model: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3),
  **CC BY 4.0**, not v2 or another Parakeet model.
- ONNX conversion: [ysdede/parakeet-tdt-0.6b-v3-onnx](https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx/tree/f88260fa0777fe0868dda6df85d1a98f012a4a7a),
  revision `f88260fa0777fe0868dda6df85d1a98f012a4a7a`.
  Its attribution identifies istupakov's v3 conversion at
  `8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce`; FP16 was derived from FP32 with
  cast fixes. Downloaded encoder/decoder SHA-256 values match the converter's
  published provenance/LFS hashes. The exact pinned vocabulary is 8,193 lines,
  102,132 bytes; the older generated provenance lists an earlier vocabulary, so
  the current revision's vocabulary is pinned separately and tested in inference.
  All 8,192 token/ID pairs match NVIDIA's tokenizer at revision
  `541d1f99c6b0c3cd0b11a95167540bb8edefd82b`, with only the extra `<blk>` entry
  at ID 8,192. [Provenance checks](evidence/optional-asr-121-provenance.json) also
  verify all seven Moonshine files against the pinned native catalog's CRC32C/size pairs.
- Files: `encoder-model.fp16.onnx` (1,238,960,452 bytes),
  `decoder_joint-model.int8.onnx` (18,202,004), `vocab.txt` (102,132).
- [parakeet.js](https://github.com/ysdede/parakeet.js) **1.4.4**, source
  `44fe54aaaaf8074f64c69f2647cfcd8f96f93a58`, MIT; ONNX Runtime Web **1.24.3**, MIT.
  GPU encoder, CPU WASM int8 decoder (one thread), JS 128-bin mel preprocessing.
  ORT may assign shape operations to CPU even with the GPU encoder provider.
- Evaluation found ORT 1.24.1 failed this FP16 encoder with a destroyed-GPU-buffer
  error. The package override pins **1.24.3**, which passed production inference.
  Local JS changes replace bare ORT import/CDN fallback with packaged paths and
  serialize strict-GPU session construction to avoid upstream's initWasm race.
  Source and patched hashes make those changes reviewable and reproducible.
- NVIDIA and converter attribution, the CC BY license/link and modification
  notices are retained in `web/licenses/parakeet-v3-*` and third-party notices.

### Moonshine

- Model: official **245M English Medium Streaming**, MIT, dated
  **`medium-streaming-en/quantized_26_07_30`** under
  [the publisher's model distribution](https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/streaming_config.json).
  This is not tiny, small, base or an older nonstreaming model. The official
  [model table](https://moonshine-voice.readthedocs.io/en/latest/models/available-models/)
  identifies its size/license; the pinned WASM's embedded dependency catalog
  identifies this exact seven-file checkpoint and sizes.
- Files: `adapter.ort` (3,651,296 bytes), `cross_kv.ort` (11,643,776),
  `decoder_kv.ort` (146,972,408), `encoder.ort` (94,705,376),
  `frontend.ort` (47,467,576), `streaming_config.json` (513),
  `tokenizer.bin` (249,974). The manifest's 64-character revision is the SHA-256
  of newline-joined `path:bytes:sha256` entries in file order, a content identity
  for the dated publisher checkpoint, **not a Git commit**. Source URLs are
  pinned explicitly. Changed publisher bytes fail verification.
- Official **`@moonshine-ai/moonshine-wasm@0.1.5`**, source
  `234f60faa0eb388b01cdf7e60aca232af37aefda`, MIT. `ModelArch.MediumStreaming`
  (5), `Transcriber.load({files,...})`, native `createStream` and native events;
  no MicTranscriber capture replacement, catalog download or CDN code loading.
- Its generated Emscripten JS uses two `new Function` invoker factories, forbidden
  by MV3. [`moonshine-csp.py`](../scripts/moonshine-csp.py) replaces those two
  factories with equivalent ordinary closures (synchronous bindings only).
  **The WASM binary is unchanged.** Package hash validation precedes the patch;
  output hashes are pinned too. Both standalone and native concurrent inference
  passed the real MV3 CSP with the adapter. No unsafe-eval relaxation is added.
- Retained MIT terms and bundled third-party notices are in
  `web/licenses/moonshine*.txt`. These include upstream ORT, fbank, kissfft,
  utf8proc and Eigen notices. Unmodified MPL-covered Eigen source is available
  at the exact source revision linked there. The upstream loader preallocates
  a pthread pool based on hardwareConcurrency (16 on the test machine), per Node;
  it is released with its owning Worker. No claim of single-thread inference.

## Recognition and lifecycle policies

**Parakeet** is an offline TDT model. parakeet.js offers live helpers that rerun
buffers with state/overlap merging; those helpers are not evidence of a native
streaming checkpoint. This Node commits non-overlapping chunks only, exposing no
provisional port. Twenty-millisecond RMS frames (threshold 0.003) endpoint after
800 ms of quiet once voice has occurred, or at a 12-second cap including leading
silence. Quiet-only chunks skip inference. There is no shared Silero gate.
Stop includes the incomplete last frame and recognizes the remaining voiced tail.
Quiet speech can be missed by this simple energy policy; continuous speech can
split mid-word at the cap. Chunk duration is not a latency guarantee.

**Moonshine** uses actual native incremental recognition. Only incomplete native
line-start/text-change events become provisional; only completed native lines
become final. Completed IDs are deduplicated; identical text in separate lines
remains separate. Native defaults govern VAD (0.5 threshold/window, 8,192-sample
look-behind, maximum 15-second lines). The JS stream requests updates from
0.5 seconds of new audio, adapting its interval to inference cost. Speaker
identification, word timestamps, spelling and returned PCM are disabled. Stop
calls native stop/forced transcription before closing. Every 30 seconds, the
Node drains/closes/recreates its stream to bound native transcript/diff history.
That hard boundary can split speech. IDs remain unique across renewals.

Both transports own copied ≤100 ms PCM blocks, with **one acknowledged block in
flight**. Queued plus in-flight input is bounded at **30 seconds**. Overload fails
visibly on that Node, preserving peer paths; it never silently drops/reorders
accepted input. Stop admits no new input and waits for all accepted blocks,
inference, final TEXT delivery and Worker disposal. Cancel invalidates delivery
and terminates the owning Worker, including pending load/inference; it emits no
new finals. Session tags reject stale replies. Repeated Start creates fresh
Nodes, clears previews/history and reloads from verified cached weights.

Optional model/Worker/GPU errors disable only the affected ASR path and clear its
preview. Live reports the Node ID and recovery instructions; other paths continue.
Previously committed text stays available. Fix cache/device/memory, then Stop and
Start again. Existing models retain their prior fail-session policy.

## Local execution and tests

MV3 uses the unchanged `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`
CSP. All executable JS/MJS/WASM comes from the package. Startup only inspects and
reads cached model bytes; it cannot fetch missing weights. No speech upload,
remote inference, recording-time runtime download or silent model fallback.

Deterministic validation: `npm test`, `npm run test:extension`; includes ports,
Graph v10/default/migrations, Save/reload, parked requirements, preparation retry,
bounded input, repeat/deduplication, tails, native-stream renewal, Cancel, crashes,
peer-path isolation and Worker release. Existing generic cache tests cover
corruption, quota, cancellation, cross-page locks and reuse.

For real packaged-model validation (about **1.56 GB** additional developer-only
weights; fixtures are prepared by the existing Zipformer script):

```sh
npm run setup:extension
npm run prepare:optional-asr-test-models
npm run test:optional-asr-real
```

The test preparation script fetches only pinned artifacts into `.cache/new-asr`,
verifying full and block hashes. It is never part of setup/build. The standalone
checks use unchanged packaged graph/Node/Worker/backend implementations with
pinned English LibriSpeech PCM replacing capture hardware; the native check uses
real toolbar invocation and tabCapture, two concurrent ASRs, Live, TextFormatter
and focused field output. A local development mirror feeds the production
checksum-verifying cache; inference then blocks HTTP(S). Native capture allows
only the loopback fixture site. Evidence JSON records texts/events, timing,
requests, hardware and resource observations. No fake backend establishes real
inference. Physical microphone, meeting audio, other devices, comparative
accuracy and user acceptance remain untested/out of scope. There is no required
post-merge verification for this Issue.

Live displays accept only `dom: DOM`. Route complete TEXT snapshots through `TextToDOM.text → dom → LiveTextDisplay.dom`. For history, accumulate final TEXT with TextAccumulator and compose provisional TEXT through separate TextToDOM and DOMCombiner branches. For paired translation, explicitly wire `translator.source → PairedTextToDOM.input1` and `translator.text → PairedTextToDOM.input2`, then dom to the display for the latest pair only. An unconnected side stays empty; either input update emits both latest values. An atomic group clears omitted siblings within that group only; specific translation errors stay in translation diagnostics. For optional comparison history, insert DOMAccumulator between formatter and display. Graph v12 requires review and Save for old paired ports: source/text become input1/input2, and any former formatter error route is explicitly removed in the draft. Saved TEXT display graphs also require reviewed conversion; exact originals remain recoverable. See [DOM contracts and recovery](extension-graph.md#dom-formatters-and-display-ownership).
