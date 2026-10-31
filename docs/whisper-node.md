# Local Whisper ASR and Text configuration

The extension's **Whisper tiny (multilingual) ASR** palette item is
`SpeechToTextWhisper`. It uses real, local multilingual Whisper tiny inference,
including English. It is not an English-only `.en` model. This release exposes
a deliberately limited language choice: `en` or `ja`, with **English (`en`)**
when the input is unconnected. There is no automatic language detection in this
configuration. Other codes, blank text, uppercase and whitespace are rejected
before model loading with instructions to correct the value or disconnect the configuration input.

## Use in Graph Editor

Remove ReazonSpeech, add Whisper, connect the audio source's `audio` to Whisper's
`audio`, and connect `final → TextAccumulator.append` only. Multiple independent ASRs are
allowed. Whisper's final text can also feed the existing TextFormatter, OPUS-MT, focused-field output or TTS
ports directly. You can deliberately connect final to `TextToDOM.text → dom → LiveTextDisplay.dom`
for latest-value replacement instead of committed history. No translator is
required. Remove any old maxDuration edge and unused Number Node when replacing ReazonSpeech; Whisper has a fixed 6-second
cap. Defaults/reset still use ReazonSpeech.

For Japanese, add **Text**, select its heading, edit value to `ja`, and connect
`Text.value → SpeechToTextWhisper.language`. Use `en` for explicit English.
ReazonSpeech retains its optional Number-configured maxDuration and has no
language port. Its ja-en name does not imply controllable inference language.

Text is a generic literal string source, including empty text, newlines, emoji
and markup characters. The editor saves it as JSON and displays literal text.
Ordinary TEXT consumers get one emission at session start, after they start.
Any compatible TEXT producer can supply language through ordinary delivery.
Whisper waits for its first value before model loading, validates `en`/`ja`, then
freezes the value. Pending audio is bounded at 30 seconds. Missing configuration
on Stop or overflow fails visibly; updates after loading begins are rejected.
Incomplete graphs stay saveable. Saved edits affect the next session. See
[startup configuration semantics](pipeline-runtime.md#executable-browser-tab-transcription-example).

## Saved graph migration

Graph version 8 migrates version 7 by removing only outgoing
`SpeechToTextWhisper.provisional` connections, which never emitted events. IDs,
positions, settings, final routes and unrelated routes are preserved. No edge
is automatically redirected to final. Valid results are saved in the same
storage key. For Whisper-only graphs without these edges, only the version changes.
Current version 10 also applies the [translation/formatter migration and visible
recovery rules](extension-graph.md) when those processors occur in an older graph.

If removal leaves a missing input, the destination remains in the saved draft
and stays inactive until connected. Optional warnings and explicit Validate draft
explain the incomplete branch. Choose `final → append` for committed Whisper
text, or `final → replace` for replacement semantics. No route is silently
redirected. Structural wiring/settings errors still prevent saving or execution.
ReazonSpeech keeps its provisional/final outputs and default wiring.

## Recognition policy

Whisper's audio port accepts the same mono 16 kHz Float32Array PCM as ReazonSpeech.
Silero segmentation uses 0.8-second idle pre-roll, 0.35-second trailing silence
and a **fixed 6-second segment cap** including pre-roll. Continuous speech resumes
at the next sample without overlapping already committed segments. Inference is
serial; total pending audio is bounded at 30 seconds. Overflow fails visibly and
stops capture instead of silently dropping committed speech.

This implementation performs **completed segment inference only**, exposing
exactly `final: TEXT` in the editor and runtime. There is no provisional output
or streaming preview. It does not promise real-time latency. Every final
is a committed segment, including equal strings in successive segments. Existing
core session/request IDs reject stale/duplicate finals before fan-out. Stop
flushes the source/VAD tail and drains all queued inference and downstream TEXT
consumers before releasing resources. Cancel terminates both workers and rejects
pending work; late callbacks cannot revive the session. A new Start creates
fresh resources and empty display state.

## Pinned assets and offline packaging

- Model: [onnx-community/whisper-tiny](https://huggingface.co/onnx-community/whisper-tiny/tree/ff4177021cc41f7db950912b73ea4fdf7d01d8e7),
  revision `ff4177021cc41f7db950912b73ea4fdf7d01d8e7`, q8 encoder and merged decoder,
  tokenizer, generation/processor configuration. Eight files total **43,615,928
  bytes**; exact sizes and SHA-256 pins are in [whisper-assets.json](../scripts/whisper-assets.json).
- Runtime: the existing checksum-pinned Transformers.js `4.0.0-next.3` and ONNX
  Runtime Web `1.25.0-dev.20260212-1a71a5f46e` distribution from
  [prepare-translation-assets.py](../scripts/prepare-translation-assets.py).
  CPU WASM, one thread, no proxy Worker or WebGPU requirement.
- VAD: existing pinned Silero/sherpa WASM bundle. Its preload contains ReazonSpeech
  weights even though the Whisper VAD Worker creates only a detector.
- License: OpenAI Whisper MIT, retained in [whisper.txt](../web/licenses/whisper.txt)
  and third-party notices. Existing runtime/VAD licenses continue to apply.

`npm run setup:extension` prepares all three ASR models and runtimes then builds.
For an existing checkout:

```sh
npm ci
npm run prepare:assets
npm run prepare:translation-assets
npm run prepare:whisper-assets
npm run prepare:zipformer-assets
npm run prepare:tts-assets
npm run build:extension
```

Run Whisper preparation **after** prepare:assets, which resets `web/vendor`.
Preparation verifies every file before replacing a previously staged Whisper
bundle, using an ignored `.cache/whisper/<revision>/` download cache. The build
checks each Whisper file's size and checksum and packages the complete model.
All executable runtime code is packaged under MV3's existing `self` and
`wasm-unsafe-eval` CSP; no permission or remote-code exception is added.
The Whisper module Worker disables remote models and browser model caches and
loads only `web/vendor/whisper/tiny/`. No model fetching from the network happens
during loading or recording. Missing/incompatible assets produce a visible
error naming preparation and rebuild commands; Cancel/failed startup releases
partially loaded workers. Optional translation/TTS model download behavior is
unchanged.

## Tests and evidence

```sh
npm test
npm run test:browser
npm run test:extension
python3 scripts/prepare-reazon-ja-en-fixtures.py
npm run test:whisper-real
```

Unit tests cover version 7 dead-edge migration and retained incomplete drafts,
lossless version 6 migration, earlier migrations, defaults and
invalid recovery; literal Text persistence, configuration order and invalid
types/codes; model replacement, formatter compatibility; final-only segmentation,
audio boundary accounting, repeated text, Stop, Cancel, overflow, worker errors
and retry. Packaged deterministic browser tests retain the production Whisper
Worker, graph, source routing, core and lifecycle, replacing only model inference
and VAD classifications. **Those mocks do not establish recognition accuracy.**

The opt-in real smoke uses the checksum-pinned English and Japanese WAVs already
listed in [reazon-ja-en-assets.json](../scripts/reazon-ja-en-assets.json). English
is 16 kHz; Japanese is 48 kHz and passes through the production Resampler with a
tail flush. Only capture hardware is replaced with fixture PCM at the production
source output. Packaged Whisper/ONNX/Silero inference, segmentation, graph,
language token selection and final sinks are real, under the actual extension
CSP. It verifies English → Japanese → English saved configurations and worker
load requests, expected output scripts/an English fixture keyword, Stop/repeat,
resource disposal and zero HTTP requests. It saves a JSON artifact with observed
texts, timings and browser version. See [Issue #107 evidence](evidence/graph-107.md).

The smoke is not WER/CER evaluation or comparative accuracy evidence. No broad
English/Japanese quality, accents, noise, silence hallucination resistance,
mixed-language behavior or long-recording throughput is established. Tiny q8
and fixed segment boundaries can misrecognize or split sentences. Whisper is
supported here in desktop Chrome MV3; WebKit cannot load this extension and has
no Whisper support claim. Real fixtures and models must be prepared before the
opt-in check; otherwise its explicit skip is not evidence of passing inference.

Live displays accept only `dom: DOM`. Route complete TEXT snapshots through `TextToDOM.text → dom → LiveTextDisplay.dom`. For history, accumulate final TEXT with TextAccumulator and compose provisional TEXT through separate TextToDOM and DOMCombiner branches. For paired translation, explicitly wire `translator.source → PairedTextToDOM.input1` and `translator.text → PairedTextToDOM.input2`, then dom to the display for the latest pair only. An unconnected side stays empty; either input update emits both latest values. An atomic group clears omitted siblings within that group only; specific translation errors stay in translation diagnostics. For optional comparison history, insert DOMAccumulator between formatter and display. Graph v12 requires review and Save for old paired ports: source/text become input1/input2, and any former formatter error route is explicitly removed in the draft. Saved TEXT display graphs also require reviewed conversion; exact originals remain recoverable. See [DOM contracts and recovery](extension-graph.md#dom-formatters-and-display-ownership).
