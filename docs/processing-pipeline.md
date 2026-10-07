# Composable local processing architecture

[Issue #7](https://github.com/takahirox/my-audio-to-text/issues/7) defines the
long-lived product vision: reusable source and processing nodes connected into
local-first pipelines. The [minimal Node/Port runtime](pipeline-runtime.md)
implements code-level composition and an executable browser-tab transcription
example. This document explains the longer-lived architecture; additional
processors and a universal plugin SDK remain future work.
See the [README](../README.md#current-implemented-capabilities) for current status.

## Implemented foundation

The first concrete pipeline captures microphone, browser-tab or Chrome-extension
tab audio, normalizes it to mono 16 kHz PCM, passes it to the Local ASR Core and
displays provisional/final transcripts. The core currently uses ReazonSpeech
ja-en with sherpa-onnx, Silero VAD and hayamimi-inspired simulated streaming.
ReazonSpeech is an offline recognizer repeatedly decoding bounded snapshots;
this is not native streaming recognition.

The [Local ASR Core](local-asr-core.md) separates recognition from capture,
resampling and UI. The [Web playground](asr-manual-testing.md) and
[Chrome extension](chrome-extension.md) reuse this capability through its
existing methods and event callback. The minimal runtime also exposes tab capture,
speech-to-text and transcript sink nodes connected through named ports. Translation,
summarization, topic processing, persistent history and personalized ASR are
future capabilities.

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
  audio streams, transcript events, text, summaries or structured topic data.
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
for example, PCM format for audio or replacement versus committed semantics for
transcript events. Adjacent nodes should not need to know each other's model,
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

The first example is executable today; the other processors below are
architectural illustrations:

```text
Tab Audio → Speech-to-Text → Transcript

Speech-to-Text.final → Summarizer → Summary

Speech-to-Text.provisional → Translator → Live translation

Article/Text → Summarizer → Summary

Speech-to-Text.final → Transcript/history → Rolling summary

Transcript/history → Topic extraction/analysis → Visualization
```

Only the first example represents an existing end-to-end capability, via both
the capture/core/UI integration and the new Node/Port example. All other
processors, history storage, article/text inputs and connections above are future
examples. In particular,
`.provisional` is the SpeechToTextNode port for the existing core's `partial`
events. Provisional replacements and committed events may feed different
consumers from the same speech-to-text unit.

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
