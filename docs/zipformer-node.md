# Streaming Zipformer English ASR (#113)

The extension's **Streaming Zipformer English ASR** palette item is
`SpeechToTextZipformerEn`. It uses a real sherpa-onnx **OnlineRecognizer** in its
own classic Worker, with incremental features, encoder state and decoder state.
Each new PCM block is accepted once. Changed nonempty hypotheses can appear
while speech is still arriving; these are not completed transcripts replayed as
partials. A hypothesis can also retract to empty. Outputs remain plain strings.

## Use in Graph Editor

Remove the current ASR, add Streaming Zipformer English ASR (search `Zipformer`
or `English`), then connect:

```text
ChromeTabAudio.audio       → SpeechToTextZipformerEn.audio
SpeechToTextZipformerEn.final → TextAccumulator.append → TextToDOM.text → DOMCombiner.first
SpeechToTextZipformerEn.provisional → TextToDOM.text → DOMCombiner.second
DOMCombiner.dom → LiveTextDisplay.dom
```

Save, then Start in Live. Selected media and microphone sources provide the same
PCM contract. There is no language or maxDuration input: this is English-only,
with a fixed policy. Remove any now-unused Number/Text source and configuration
wire from the old ASR. Multiple ASRs can coexist or share a compatible source. Finals can feed existing
TEXT formatters, OPUS-MT, focused fields and TTS. All downstream contracts and
sinks are unchanged. Default/reset remains the ReazonSpeech → TextAccumulator → LiveTextDisplay graph.
Zipformer adds no separate migration. Current version 10 graphs retain these ASR
contracts; older graphs use the [translation/formatter migration and recovery
rules](extension-graph.md), preserving unrelated ASR routes and settings.

## Segmentation and ownership

- Every **192,000 real samples (12 seconds)** commits one independent stream.
  Silence counts toward the cap. There is **no Silero VAD gating or recognizer
  silence endpoint**; both are deliberately disabled for this node. A final can
  therefore take 12 seconds plus processing/backlog to appear during capture.
- The Worker accepts at most 1,600 real samples before checking decode readiness.
  Each available online decoder step runs before reading the current hypothesis.
  Only changed partials emit; they remain replaceable until the segment commits.
- At the cap or graceful Stop, append **12,800 zero samples (0.8 seconds)** for
  model right context, call `inputFinished()`, decode to exhaustion, read exactly
  one final, then free the stream. Padding never counts as captured audio or
  enters the next segment. The next real sample starts a fresh stream with no
  audio overlap or stale hypothesis. Empty text produces no final item.
- Finals have internal monotonically ordered segment IDs. The public Node
  suppresses duplicate IDs before fan-out; identical text in different segments
  is preserved. No transcript-prefix subtraction or text-based deduplication is
  used. Independent segments can split words and degrade acoustic recognition;
  complete audio ownership does not guarantee complete/correct recognized text.
- Producers retain their PCM buffers. The core copies bounded chunks before
  returning, transfers only its own buffers, and sends **one unacknowledged
  chunk** to the Worker at a time. Pending plus in-flight real audio is bounded
  at **480,000 samples (30 seconds / 1.92 MB of Float32 PCM)**. Exceeding this
  bound fails visibly and releases the Worker; it never silently drops oldest
  audio. Capture/source and downstream queues retain their existing policies.
- Stop first flushes capture, drains accepted chunks, commits the tail, then
  drains downstream consumers. Cancel immediately terminates the Worker and
  discards uncommitted output. Worker exceptions, load errors, message errors and
  crashes reject pending readiness/drain and propagate to the session. Late
  callbacks cannot revive a released core. Live starts fresh workers each time;
  the shared Node lifecycle also supports moving a successfully drained warm
  core to a new single-use Node through `nextSession()`.

## Concrete model and packaged runtime

Model: [csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/tree/d42f2d9f7ca24806fb667456a18a9f1b60f70d16),
revision `d42f2d9f7ca24806fb667456a18a9f1b60f70d16`, epoch 99, average 1.
The [pinned model card](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/blob/d42f2d9f7ca24806fb667456a18a9f1b60f70d16/README.md)
declares **Apache-2.0** and identifies the original
`desh2608/icefall-asr-librispeech-pruned-transducer-stateless7-streaming-small`
model. [Sherpa's online model documentation](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#csukuangfj-sherpa-onnx-streaming-zipformer-en-20m-2023-02-17-english)
identifies English LibriSpeech training and this int8-encoder/int8-joiner plus
float-decoder configuration. It is an older, small English read-speech model,
chosen for a relatively small local CPU bundle, not a demonstrated accuracy win.

| Packaged artifact | Bytes |
| --- | ---: |
| int8 encoder | 42,845,182 |
| float decoder | 2,092,272 |
| int8 joiner | 259,572 |
| tokens | 5,048 |
| packed model `.data` | 45,202,074 |
| online SIMD `.wasm` | 12,434,212 |
| complete generated bundle, excluding manifest | 57,804,207 |

Runtime: [sherpa-onnx v1.13.2 online English SIMD archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-wasm-simd-v1.13.2-en-asr-zipformer.tar.bz2),
SHA-256 `0ae9f835b956e43200231ad6820e6ce3c8f2225411af55c51f017266d3552caa`.
The archive download is 175,014,741 bytes because upstream includes larger
weights; preparation discards those and rewrites only the Emscripten preload
table with the selected 20M files. Online JS/WASM is preserved. Inference uses
16 kHz / 80-bin features, `modelType: zipformer`, greedy search, CPU, one thread,
no endpointing, no WebGPU or multi-thread dependency. This is separate from the
offline ReazonSpeech Worker. All source, runtime and generated bundle checksums
are pinned in [zipformer-assets.json](../scripts/zipformer-assets.json).

The runtime/model use [Apache-2.0](../web/licenses/sherpa-onnx.txt); existing
ONNX Runtime and upstream dependency licenses also apply. The packaged model
card and [third-party notices](../web/third-party-notices.txt) retain provenance.
Development WAV fixtures `test_wavs/0.wav` (6.625 s), `1.wav` (16.715 s) and their
reference text are pinned from the same revision. They are upstream English
read-speech fixtures; the model card declares Apache-2.0. Corpus attribution:
[LibriSpeech / OpenSLR 12](https://www.openslr.org/12), Panayotov et al., derived
from LibriVox, CC BY 4.0. No WAVs are packaged or published by preparation.

## Offline setup and verification

```sh
npm run setup:extension
```

For an already prepared checkout, run `npm run prepare:zipformer-assets` **after**
`prepare:assets` (which resets `web/vendor`), then `npm run build:extension`.
The new preparer verifies the runtime archive, each source model/card/fixture,
and every generated bundle file before writing the staged bundle. The extension
build separately checks the pinned specification, file sizes and hashes and
fails with preparation instructions for missing/invalid assets. The prepared
bundle and complete source modules are copied into `dist/chrome-extension`.

No executable code, model or inference service is fetched from the network at
load or recording time. Worker `importScripts`, dynamic local imports, preload
XHR and WASM instantiation use packaged extension URLs. The unchanged MV3 CSP
uses `script-src 'self' 'wasm-unsafe-eval'` and `worker-src 'self'`; no host
permission or remote-code exception is added. Missing/incompatible local files
produce a visible startup failure. Optional translation/TTS downloads retain
their existing explicit preparation policy.

```sh
npm test
npm run test:browser
npm run test:extension
npm run test:zipformer-real
```

The real check is opt-in to avoid silently downloading large model assets in a
normal test run. Preparation downloads and checksum-verifies its fixtures too;
there is no manual deployment prerequisite. It launches the built extension
under its actual CSP, substitutes pinned PCM only for capture hardware, and
retains the production graph, Node, core, Worker, online runtime, model and Live
sinks. It verifies changing partials before final, cap followed by a new stream,
Stop tail including the final English phrase, silence, empty audio, repeat
sessions, worker disposal and zero HTTP requests. Irregular accelerated chunks
also exercise capture block boundaries independently of model decode chunks.
Deterministic tests cover exact audio accounting, repeated equal finals,
backlog, failure/crash cleanup, Cancel, warm transfer, typed connections,
unchanged v8 saves/defaults and existing migrations. The deterministic recognizer
is a fake and supplies no acoustic accuracy evidence.

## Measured behavior and limits

See [Issue #113 evidence](evidence/graph-113.md) and its saved JSON for browser,
fixture hashes, transcripts, event order, audio consumed at first partial,
wall-clock timing and WASM heap size. The real packaged compatibility check was
completed before commit. This is fixture-based inference validation, **not** a
WER/CER benchmark, comparison against ReazonSpeech/Whisper, or real-world English
accuracy guarantee. The fixtures demonstrate omissions and errors; fixed cap
splits can damage words near a boundary. No tests establish robustness to accent,
noise, overlapping speakers, music, punctuation/casing, unbounded recordings or
all desktop CPU speeds. The pinned runtime reserves a 512 MiB WASM heap (observed at readiness and
after drain); the small model does not shrink that compiled initial allocation.
WASM heap is not total process memory. This is a desktop Chrome extension
configuration; constrained/mobile devices are not a supported target.

ReazonSpeech still exposes both outputs through repeated **offline prefix
snapshot** decoding and its Number-configured cap. Whisper still exposes
**final only**, using Silero-completed segments. This Zipformer node retains
online acoustic/decoder state between incoming blocks within each capped segment;
its provisional output comes from that real incremental inference.

Live displays accept only `dom: DOM`. Route complete TEXT snapshots through `TextToDOM.text → dom → LiveTextDisplay.dom`. For history, accumulate final TEXT with TextAccumulator and compose provisional TEXT through separate TextToDOM and DOMCombiner branches. For paired translation, explicitly wire `translator.source → PairedTextToDOM.input1` and `translator.text → PairedTextToDOM.input2`, then dom to the display for the latest pair only. An unconnected side stays empty; either input update emits both latest values. An atomic group clears omitted siblings within that group only; specific translation errors stay in translation diagnostics. For optional comparison history, insert DOMAccumulator between formatter and display. Graph v12 requires review and Save for old paired ports: source/text become input1/input2, and any former formatter error route is explicitly removed in the draft. Saved TEXT display graphs also require reviewed conversion; exact originals remain recoverable. See [DOM contracts and recovery](extension-graph.md#dom-formatters-and-display-ownership).
