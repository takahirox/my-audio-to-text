# Minimal Node/Port runtime

[`web/pipeline.js`](../web/pipeline.js) implements the code-level runtime from
[Issue #57](https://github.com/takahirox/my-audio-to-text/issues/57), following
the [composable processing vision](processing-pipeline.md). It has no processing
policy, payload envelope, model registry, shared runtime manager or plugin system.

## Contract

A node is an independently executable/configurable/replaceable object. It declares
`inputs` and `outputs` as maps from named ports to shared contract tokens:

```js
const TEXT = portContract('text');
const node = {
  inputs: { original: TEXT, translation: TEXT },
  outputs: { display: TEXT },
  async start(context) { /* initialize resources */ },
  async receive(port, value, context) { /* process an input */ },
  async stop(context) { /* flush background work and emit final values */ },
  async dispose() { /* cancel work and release resources */ },
};
```

Hooks are optional, except that a connected input needs `receive`. Each hook may
return a promise. `context` has `emit(outputPort, value)`, `fail(error)` and an
`AbortSignal` named `signal`. An input handler may emit zero, one or many values,
including later from a Worker callback. Background work must finish within the
node's `stop()` promise. Implementations should observe `signal` and release
background resources in `dispose()`; for example, pass it to `fetch()`.

`portContract(name)` creates a small shared identity. Both endpoints must declare
the **same token**, including agreement on payload semantics (PCM format,
replacement versus commitment, etc.). Names are descriptive, not structural
schema matching. Tokens impose no fields on payloads and do not validate values
at delivery time. Nodes own validation of their data contracts. Unknown nodes,
unknown ports, incompatible tokens, duplicate connections, duplicate node
instances and cycles fail during construction. Unknown output emissions report
a node error. Graphs are fixed acyclic graphs for this minimal implementation.

```js
const pipeline = new Pipeline({
  nodes: { source, processor, view },
  connections: [
    { from: ['source', 'text'], to: ['processor', 'original'] },
    { from: ['source', 'text'], to: ['view', 'original'] },
    { from: ['processor', 'translation'], to: ['view', 'translation'] },
  ],
  onError(error, nodeId) { /* report failure */ },
});
```

Node IDs identify graph endpoints and error reports; they are never injected
into payloads. Dependencies are explicit connections. Every connected consumer
receives the same value by reference, so treat values as read-only or copy before
mutation/transfer. An output may fan out; a node may have multiple inputs and
outputs. Delivery is asynchronous and ordered across all inputs of each node,
using one serial promise queue per node. A slow receiver does not delay another
branch receiving the same output. Queue limits/coalescing remain processing
policy; this runtime does not provide generic backpressure or durable storage.

## Lifecycle and errors

- `await pipeline.start()` starts consumers before producers. Outputs emitted
  during startup can reach already initialized downstream nodes. Async loading
  and readiness belong in the node's `start()` promise.
- `await pipeline.stop()` stops nodes in connection order. Before stopping each
  node it waits for its queued inputs. The source's `stop()` may emit a final
  tail; the processor consumes it before flushing; sinks consume all final
  outputs before stopping. Emissions after a node's stop has resolved are ignored.
  Stop is idempotent. A Stop during startup waits for startup; use Dispose to
  interrupt pending loading/permission or other work immediately.
- `await pipeline.dispose()` immediately closes every emitter, aborts all node
  signals and skips queued inputs, then waits only for resource cleanup hooks.
  It does not wait for pending input/start/stop work. Running input code must
  cooperate with the signal to prevent its own external side effects. Late
  outputs are discarded even if that code ignores cancellation. Pending Start
  rejects with cancellation; pending Stop exits when disposal interrupts it.
  Dispose is idempotent and attempts every cleanup even if one fails.
- Input or background failures (`context.fail`) disable the failing node and
  abort its signal. `onError(error, nodeId)` reports it once; independent nodes
  continue. `pipeline.errors` retains reported errors. Stop drains healthy nodes
  and rejects with an `AggregateError` for failures. Startup failures reject
  Start and dispose the whole graph. Disposal errors reject Dispose. Callers
  should always dispose after completion or error to release resources.

A pipeline/node graph is single-use: `idle → starting → running → stopping →
stopped`, with Dispose allowed at any point. Construct fresh node instances for
a new run. Old context closures cannot feed a replacement graph. Graceful Stop
does not itself dispose model resources. Restarting/rewiring graphs and sharing
node instances between graphs are outside this contract.

## Node Playground speech page integration

[`web/nodes/speech-to-text/app.js`](../web/nodes/speech-to-text/app.js) uses the
runtime for both input choices:

```text
MicrophoneAudioNode / BrowserTabAudioNode
        ↓ audio (mono 16 kHz Float32Array)
SpeechToTextNode
        ├─ provisional → TranscriptOutputNode.provisional
        └─ final       → TranscriptOutputNode.final
```

The source nodes wrap the existing capture/resampling helpers. Their optional
`onAudio(pcm)` observer supplies signal/RMS and captured-duration diagnostics;
PCM reaches ASR only through the connected audio port. `MicrophoneAudioNode`
stops on page hiding, including during pending permission; tab capture continues
in the background. Source end during setup closes capture and settles startup
so downstream nodes can drain without waiting for a late grant/worklet setup.
Both nodes discard late callbacks on disposal.

Load preloads `SpeechToTextNode` before enabling Start. Start executes
`pipeline.start()` from the capture gesture. The UI observes core configuration,
loading, pending-audio and speech events, while transcript rendering consumes
only the sink's provisional/final ports. Stop awaits `pipeline.stop()` through
the source tail, ASR finals and sink before showing Ready or measuring Stop
latency. Cancel, source changes, reload, errors and page teardown dispose the
graph and invalidate its UI observer generation.

Repeat uses fresh nodes and contexts without reloading the model. After a
successful **whole-pipeline drain**, `speech.nextSession({ onEvent })` transfers
sole ownership of its ready core to a fresh `SpeechToTextNode`. The old node
loses the core and cannot transfer it again; disposing its old graph releases
source/sink resources without terminating the transferred workers. The new
node's disposal owns worker release. This explicit adapter handoff retains the
same two workers and the core's session checks; it is not graph restart, node
reuse between graphs, worker pooling or a change to the generic runtime. Failed,
canceled, already-transferred or undrained speech nodes cannot hand off a core.
The playground builds its replacement graph before enabling Start again.

## Executable browser-tab transcription example

[`web/transcription-nodes.js`](../web/transcription-nodes.js) exports the real
adapters and `createTabTranscriptionPipeline()`:

```text
BrowserTabAudioNode.audio (mono 16 kHz Float32Array)
        ↓
SpeechToTextNode.audio
        ├─ provisional → TranscriptOutputNode.provisional
        └─ final       → TranscriptOutputNode.final
```

`BrowserTabAudioNode` uses the existing `BrowserTab` capture/resampling helper.
`SpeechToTextNode` owns exactly one existing `LocalAsrCore`, including its
dedicated ASR worker and dedicated VAD worker. The existing two-worker internal
boundary is retained; there is no worker pool or implicit resource sharing.
Lightweight source/sink wrappers create no processing workers. `partial` events
map to the `provisional` port; `final` events map to the `final` port. Both carry
the core's `{ text, id }` utterance data without adding graph metadata. The core's
ReazonSpeech ja-en/Silero/hayamimi policy and provisional fallback are unchanged.
`onEvent` optionally observes original core diagnostics/lifecycle events;
transcript processing belongs on the ports. `TranscriptOutputNode` accepts an
async callback `(port, value, signal)` and can serve as a UI, storage or test sink.

After [preparing assets and serving the playground](asr-manual-testing.md#local-setup),
open the Speech-to-Text test page from the Node Playground list and allow its
isolation setup to complete. The following executable
example can be entered in the browser console; leave the playground's own model
unloaded. Load before clicking the example button to preserve the capture gesture:

```js
const { createTabTranscriptionPipeline } = await import('../../transcription-nodes.js');
const flow = createTabTranscriptionPipeline({
  onTranscript: (port, transcript) => console.log(port, transcript),
  onEvent: event => { if (event.type === 'progress') console.log(event.message); },
  onError: error => console.error(error),
});
await flow.speech.load(); // optional preloading; start also loads if necessary
const button = document.createElement('button');
button.textContent = 'Start pipeline tab capture';
button.onclick = () => flow.pipeline.start().catch(console.error);
document.body.append(button);
// Click the button, select a tab, and enable Share tab audio.
```

Later, stop and drain before releasing:

```js
await flow.pipeline.stop();
await flow.pipeline.dispose();
// Or cancel immediately with flow.pipeline.dispose().
```

The helper gracefully stops when sharing ends. Catch Start/Stop failures and
dispose the graph; a new run creates a new helper instance. Tab permissions,
HTTPS/localhost, cross-origin isolation, model assets and browser limitations
are the same as the playground. No external API integration is required.

The Chrome extension uses the same runtime and speech node with its own capture
adapter and UI; the Node Playground does not host or package its UI. Deterministic
tests exercise the playground and adapters using real microphone/tab helpers,
capture worklet, resampling and `LocalAsrCore`, with browser permission APIs and
model worker replies controlled. Browser tests execute the playground and
helper with native Web Audio, native worklet/fallback capture and real Worker
messaging in Chromium and WebKit. They verify provisional/final fallback, PCM,
draining and resource release. Unit tests additionally cover validation,
fan-out, multiple inputs/outputs, async lifecycle, independent branches,
failures, disposal during load/input/drain and stale output across fresh graphs.

Run `npm test`, `npm run test:browser -- --workers=2` and the existing
[extension checks](chrome-extension.md). These deterministic checks do not claim
new recognition accuracy or physical-device performance.

## Independent text translation nodes

[`web/translation-nodes.js`](../web/translation-nodes.js) declares a shared `TEXT`
contract for plain strings. `TextInputNode.text` connects to either
`OpusMtTranslationNode.text` or `TranslateGemmaTranslationNode.text`, whose text
output connects to `TextOutputNode.text`. Each translation node owns its dedicated
module Worker. The adapters use correlated load/translate/drain replies;
`receive()` waits for and emits all returned strings in order. Blank input has
zero output. The worker serial queue and Pipeline queue preserve arrival order.
`stop()` drains; signal abort/dispose terminates the Worker and settles pending
requests without stale emission. Graphs are single-use and repeat creates fresh
nodes. Model selection, tokenizer/template, inference and GPU checks live in the
individual worker entry points. The generic runtime is unchanged. See
[translation nodes](translation-nodes.md) for limits, runtime/model pins and tests.

## Independent text-to-speech Nodes

`Supertonic3TextToSpeechNode` and `KokoroTextToSpeechNode` in
[`web/tts-nodes.js`](../web/tts-nodes.js) consume `text: TEXT` plain strings and
emit `audio: SYNTHESIZED_AUDIO`. The new shared audio token carries
`{ samples: Float32Array, sampleRate: positive integer, channels: 1 }`, a
read-only, nonempty finite mono waveform at the model's own rate (44.1 kHz or
24 kHz). It is separate from the bare 16 kHz capture/ASR token. No graph metadata
is added. `AudioOutputNode` validates and delivers audio to an independent
consumer; `audioToWav` supplies the pages' playback/download adapter.

Each Node owns one inference Worker (including its frontend). Start loads on
explicit Run, receive waits for generated audio, Stop drains and Dispose
terminates pending inference/downloads and ignores stale replies. Repeat uses
fresh graphs and cached assets. See [TTS Nodes](tts-nodes.md) for pins, languages,
licenses, capability/errors and opt-in real-model tests. The generic runtime
requires no TTS policy or modification.

## Extension visual graph composition

The [extension graph editor](extension-graph.md) saves a version 1 description
with concrete production Node types and explicit named-port edges. The extension
builder constructs this shared Pipeline at each session boundary. ASR, OPUS-MT
directions, Supertonic 3 and Kokoro remain independent production processors;
final-text adapters and audio playback are separate Nodes. No editor, model
selection, storage or inference policy is added to the generic Pipeline runtime.

## Optional transcript correction

`SpeechTranscriptCorrectionNode` owns a Qwen3 0.6B Worker and exposes plain
`TEXT` input/output. Connect `SpeechToTextNode.final` through the explicit
`FinalTranscriptTextNode` adapter; preserve a separate original transcript
branch. It can be omitted or explicitly bypassed, with no default graph or
extension change. See [model, lifecycle, conservative policy and evaluation](correction-node.md).
