# Composable local processing architecture

[Issue #7](https://github.com/takahirox/my-audio-to-text/issues/7) defines the
long-lived product vision: reusable source and processing nodes connected into
local-first pipelines. The [minimal Node/Port runtime](pipeline-runtime.md)
implements code-level composition and an executable browser-tab transcription
example, and powers the Node Playground speech page's microphone/tab
transcription. Independent [OPUS-MT and TranslateGemma translation nodes](translation-nodes.md)
also compose text source → processor → text sink graphs. This document explains
the longer-lived architecture; further processors and a universal plugin SDK remain future work.
See the [README](../README.md#current-implemented-capabilities) for current status.

## Implemented foundation

The first concrete pipeline captures microphone, browser-tab or Chrome-extension
tab audio, normalizes it to mono 16 kHz PCM, passes it to the Local ASR Core and
displays provisional/final transcripts. The core currently uses ReazonSpeech
ja-en with sherpa-onnx, Silero VAD and hayamimi-inspired simulated streaming.
ReazonSpeech is an offline recognizer repeatedly decoding bounded snapshots;
this is not native streaming recognition.

The [Local ASR Core](local-asr-core.md) separates recognition from capture,
resampling and UI. The [Node Playground speech test page](node-playground.md)
reuses this capability through microphone/tab source nodes, a speech-to-text
node and a transcript sink connected by named ports. The Extension can run
several such paths concurrently. The
[Chrome extension](chrome-extension.md) uses the
same runtime and speech node with its own tab source and UI. OPUS-MT and
TranslateGemma provide separate local Japanese → English text nodes and test
pages. The extension implements ASR-to-translation graph integration with generic
DOM-only Live sinks and optional bounded text formatting. The extension also implements
two [bounded incremental meeting-summary draft processors](meeting-summary-nodes.md)
with recorded accuracy limitations. Topic processing, persistent history and
personalized ASR remain future capabilities.

## Node and port concepts

A node is an independently executable, configurable and
replaceable processing unit:

```text
Node
├─ typed input ports
├─ typed output ports
├─ configuration
├─ lifecycle
└─ implementation
```

- **Input/output ports** describe compatible data contracts, such as normalized
  audio streams, plain text, summaries or structured topic data.
  A node may have multiple typed inputs and outputs; no one-input/one-output
  restriction is imposed.
- **Configuration** describes the choices needed by that processing unit, such
  as a model or processing policy, without exposing another node's internals.
- **Lifecycle** describes readiness, starting, stopping/draining, cancellation,
  release and errors as applicable to the unit. Source and processor lifetimes
  must compose without delivering stale work into a new session.
- **Implementation** provides the processing behavior using an appropriate local
  model/runtime where practical, replaceable behind the relevant contracts.

Composition connects a node's output port to another node's compatible input
port. Contracts must describe the payload and meaning needed by the consumer:
for example, PCM format for audio or strings for ordinary text. Provisional
and committed semantics use port names, while both share `TEXT`. Adjacent nodes
should not need to know each other's model,
worker arrangement or UI. The runtime uses shared contract tokens and explicit
connections; new data contracts should follow real processor requirements.

Node granularity follows real independent processing boundaries. Today's ASR
core produces provisional and final text as part of one unit, even though it
uses separate VAD and ASR workers internally. Realtime and final outputs do not
force separate nodes. A future implementation with independently executable,
configurable and replaceable fast and accurate recognizers could use separate
nodes; the architecture should allow either shape.

## Streaming, committed and accumulated processing

The direction supports streaming updates, committed events, batches, windows
and accumulated/long-form documents in the same pipeline. Each processor decides
whether to react to every update, accept only committed data or accumulate a
larger input before processing. Future transport/orchestration should carry
data and lifecycle signals without deciding ASR, translation or summarization
policy for individual processors.

The transcription example is executable today. The extension uses generic display sinks and graph wiring for ASR/translation.
Further processors below remain architectural illustrations:

```text
Tab Audio → Speech-to-Text → Transcript

Speech-to-Text.final → Summarizer → Summary

Speech-to-Text.final → Translator → TextFormatter → Live translation

Article/Text → Summarizer → Summary

Speech-to-Text.final → Transcript/history → Rolling summary

Transcript/history → Topic extraction/analysis → Visualization
```

Capture and transcription are executable today, and final text can connect
directly to the independent translation, correction, TTS and text-output nodes.
Committed TEXT can also feed the extension's meeting-summary Nodes directly;
their complete summary snapshots feed TextToDOM.text → dom → LiveTextDisplay.dom. History
storage, article inputs and broader analysis connections remain future examples.
In particular,
`.provisional` is the SpeechToTextNode port for the existing core's `partial`
events. Provisional replacements and committed events may feed different
consumers from the same speech-to-text unit.

Ordinary text is primitive-first across the shared Pipeline, Playground and
extension. [The contract audit](port-contracts.md) explains internal bookkeeping,
correlated primitive output groups and the distinct audio formats. Separate
`emit()` calls remain independent; `emitOutputs()` groups values delivered directly
to one consumer through its serial queue. Independent processor branches are not joined.

## Local execution and platform direction

Prefer processing and storage on the user's device where practical. Sensitive
source data and derived state should remain local by default where feasible,
and derived output should not silently overwrite its source. Persistent source
and history preservation is future work; current transcript display does not
provide durable storage.

Future sources may include audio/files, Web/article text and platform-specific
inputs in addition to current microphone and tab audio. Personalized ASR remains
an important future capability/node that can evolve independently, learning
from corrections with held-out evaluation of improvement and regressions.

Contracts and behavior should be reusable across Web, browser extensions,
desktop and mobile while models, implementations and runtimes remain
replaceable. A native processor may use a native ONNX runtime rather than
browser WASM. This is a platform direction, not a claim that a common
cross-platform runtime or native applications exist.

## Next architectural step

Prove a small number of useful processors and pipelines before generalizing.
The minimal runtime proves composition against the existing tab source and ASR
core. Further contract changes should follow concrete processor requirements.

A graphical node editor, plugin marketplace and general workflow framework are
not current implementation priorities. A universal plugin SDK, workflow
language or distributed runtime is not currently required. Revisit broader
orchestration only when real implementations demonstrate a need.

## Graph-driven Live text (#99)

Apply the [design principles](../README.md#design-principles): formatting,
history, composition and rendering have explicit contracts and graph connections.

The extension separates producer, formatting and display responsibilities. Any
TEXT producer can connect to `TextToDOM.text → dom → LiveTextDisplay.dom`; a bounded
`TextFormatter` is optional. Live renders sink labels/output by active graph Node
order, not ASR/translation identity. Translation exposes only grouped source/text/error
primitives. Configurable TextFormatter composes latest values; TextAccumulator owns committed history. No status/index ports or model-specific formatter are needed.
See [graph migration and exact display/formatting semantics](extension-graph.md).
Independent streams update latest formatter values; only directly grouped
`emitOutputs`/`receiveInputs` updates preserve one producer's association.

Live displays accept only `dom: DOM` in Graph v11. Route complete TEXT snapshots
through `TextToDOM.text → dom → LiveTextDisplay.dom`. For text history, explicitly
use TextAccumulator.append upstream of TextToDOM. Compose provisional TEXT with
a separate TextToDOM feeding DOMCombiner.second; committed DOM feeds first. PairedTextToDOM
holds the latest input1/input2 TEXT, both initially empty, and emits a fresh pair
on either update, including duplicates and empty clears. Either side may be
unconnected. Independent producers can temporarily combine new and previous text;
send both values atomically for exactly one consistent snapshot. Explicit groups
clear omitted siblings within that group only. For translation, connect
translator.source to input1 and translator.text to input2. Specific errors stay in
translation diagnostics; no same-producer identity is required.

These implemented compositions differ only through explicit wiring (node names
abbreviate their compatible ports):

```text
TEXT inputs → PairedTextToDOM → LiveTextDisplay                   # latest pair only
TEXT inputs → PairedTextToDOM → DOMAccumulator → LiveTextDisplay  # explicit history
DOM history + latest provisional DOM → DOMCombiner → LiveTextDisplay
```

DOMCombiner uses `first` and `second` for the latest snapshots in that order;
it adds no history or preview-specific policy. LiveTextDisplay replaces its
supplied snapshot in every case; scroll-follow remains on the rendering surface.
The v12 migration renames old paired inputs under review and preserves direct
DOM display routes; it never inserts an accumulator.
Saved TEXT display graphs require review and Save of a conversion draft; exact
originals remain recoverable. See [DOM contracts, exact wiring and recovery](extension-graph.md#dom-formatters-and-display-ownership).
