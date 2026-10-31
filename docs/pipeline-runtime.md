# Minimal Node/Port runtime

[`web/pipeline.js`](../web/pipeline.js) implements the code-level runtime from
[Issue #57](https://github.com/takahirox/my-audio-to-text/issues/57), following
the [composable processing vision](processing-pipeline.md). It has no processing
policy, payload envelope, model registry, shared runtime manager or plugin system.

## Contract

A node is an independently executable/configurable/replaceable object. It declares
`inputs` and `outputs` as maps from named ports to shared contract tokens:

```js
import { TEXT } from './port-contracts.js';
const node = {
  inputs: { original: TEXT, translation: TEXT },
  outputs: { display: TEXT },
  async start(context) { /* initialize resources */ },
  async receive(port, value, context) { /* process an input */ },
  async stop(context) { /* flush background work and emit final values */ },
  async dispose() { /* cancel work and release resources */ },
};
```

Hooks are optional, except that a connected input needs `receive` or
`receiveInputs`. Each hook may return a promise. `context` has
`emit(outputPort, value)`, `emitOutputs(values)`, `fail(error)` and an `AbortSignal`
named `signal`. An input handler may emit zero, one or many values,
including later from a Worker callback. Background work must finish within the
node's `stop()` promise. Implementations should observe `signal` and release
background resources in `dispose()`; for example, pass it to `fetch()`.

`portContract(name)` creates a small shared identity. Both endpoints must declare
the **same token**, including agreement on payload format (for example PCM sample rate). Names are descriptive, not structural
schema matching. Tokens impose no fields on payloads and do not validate values
at delivery time. Nodes own validation of their data contracts. Unknown nodes,
unknown ports, incompatible tokens, duplicate connections, multiple incoming
edges per input, duplicate node instances and cycles fail during construction. Unknown output emissions report
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

## Correlated primitive outputs

A producer can publish named values in one logical emission:

```js
context.emitOutputs({ original: 'Hello', translated: 'こんにちは' });
// Opt-in consumer, connected directly to both outputs:
const view = {
  inputs: { source: TEXT, text: TEXT },
  async receiveInputs(values, context) {
    // { source: 'Hello', text: 'こんにちは' } for this emission only
    await render(values.source, values.text, context.signal);
  },
};
```

The output map is an internal API argument, never a port payload or contract.
Each connected port still carries its declared value. The runtime snapshots the
map, validates **all** output names before any delivery, maps connected output
names to input names, and enqueues **one item per target**. An unknown output
fails the producer without partially publishing the group. Empty maps do nothing.
Each target sees only its connected subset; absent outputs stay absent. The
mapped input map is frozen, while payload references remain read-only by convention.

`receiveInputs(values, context)` opts into complete groups and takes precedence
over `receive`. It runs once per emission, including singleton `emit()` calls.
Ordinary Nodes still use `receive(port, value, context)` unchanged: for a group,
the runtime awaits each connected input in output-map enumeration order within
that single queue item. Nodes with multiple independent inputs need not opt in.
Two successive `emit()` calls remain **two singleton groups**.

Per-target queue order is publication order, including equal primitive values
in consecutive groups. Async input hooks finish before the next item starts.
Independent fan-out targets have their own queues: a slow or failed branch does
not delay another. Background inference completing out of order publishes in
completion order; the producer owns any required input-order buffering. The
translation scheduler uses a FIFO of committed utterances before publishing,
rather than asking consumers to compare source text.

Correlation is supported between ports emitted together by **one producer and connected
directly to one receiver**. Separate processor branches are not joined: the runtime does
not merge groups, wait for missing ports, or synchronize independent consumers. A
forwarding context retains only immediate delivery causality, which a consumer may
validate without joining unrelated streams. A processor may explicitly publish a new
group, but has to own its association. For an explicit `emitOutputs()` delivery,
`context.groupInputs` is a frozen list of receiver inputs wired directly from that
producer, including omitted siblings. A Node may declare independent atomic output
families with `outputGroups: [['source', 'text', 'error'], ['provisionalSource',
'provisionalText', 'provisionalError']]`. In that case groupInputs includes only the
families represented in the emission, so an omitted preview sibling never clears a
committed input. Nodes without outputGroups retain their single-family behavior. It is
delivery-local context, not a port payload or cross-hop correlation ID. `TextFormatter`
treats this as a producer snapshot and clears omitted siblings; ordinary `emit()`
deliveries carry no groupInputs and retain other latest values. A receiving group can
otherwise be a partial update by design; consumers must not infer a pair from separate
groups or assume required graph inputs are included in every emission.

Errors abort the failing target and skip its remaining queued groups; ordinary
per-port fallback also stops the current group on failure/abort. Previously
performed side effects are not rolled back. Healthy branches still drain. Dispose
invalidates queued groups and late outputs immediately, and running hooks must
observe their signal for external side effects. Graceful Stop drains whole queue
items and includes groups emitted by upstream Stop hooks before closing consumers.
These are local delivery guarantees, not transactions or distributed synchronization.

A delivery context also carries opaque `delivery` identity and `cause` (the
immediate incoming delivery of a forwarding emission). Values remain primitive.
Using the supplied receive context to emit a result preserves its causal link;
asynchronous processors retain that context with the job. These tokens contain
no Node names, port names or public IDs, and are never joined by text equality.
TranslationCommit uses them to verify that a grouped result derives from its
next boundary event, while generic delivery infers no translation semantics.

Producers can mark unfinished results with
`context.emitOutputs(values, { provisional: true })`. The receiver sees immutable
`context.provisional` provenance, separate from primitive payloads and port names.
Ordinary emissions default to false. Forwarding through the receive context
retains true across async work, including `emit()` and grouped emissions; passing
false cannot clear inherited provisional provenance. Independent source emissions
do not inherit it. The translation scheduler marks preview jobs this way.
PairedTextToDOM formats provisional and committed deliveries identically. It holds
the latest input1/input2 strings, both initialized to empty on Start. An update to
either input emits one fresh pair, including duplicate and empty values. Unconnected
or never-supplied inputs stay empty. Independent producers and ordinary `emit()`
deliveries retain the other side's latest value; no group identity is required. As
with TextFormatter, explicit producer snapshots clear omitted siblings in
`context.groupInputs` only. All updates in one atomic delivery apply before exactly
one snapshot emits. Independent inputs can temporarily combine new and previous
text; producers needing a consistent pair should send both values atomically.
Stop/Cancel/dispose close input handling; Start resets both held values. The graph
editor allows compatible drafts, and either available input enables execution
without requiring a producer type, output name or same-producer connection.

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
- `await pipeline.cancel()` aborts pending work and skips queued deliveries,
  then invokes optional Node-owned `cancel(context)` hooks in topological order,
  awaiting each hook and its upstream cleanup deliveries before canceling consumers.
  Their cleanup snapshots travel through ordinary routes with a cleanup signal,
  including formatters and sinks; aborted model/side-effect Nodes discard pending
  work. It then disposes.
  TextAccumulator uses this to clear previews consistently across fan-out. Bare
  Dispose emits no cleanup snapshots.
- Input or background failures (`context.fail`) disable the failing node and
  abort its signal. `onError(error, nodeId)` reports it once; independent nodes
  continue. `pipeline.errors` retains reported errors. Stop drains healthy nodes
  and rejects with an `AggregateError` for failures. Startup failures disable the failed Node and preserve independent viable output
  paths. Start rejects and disposes when no viable output path remains. Disposal errors reject Dispose. Callers
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
plain `TEXT` strings. Utterance IDs remain inside the ASR core/node; duplicate
final IDs are suppressed before fan-out, while equal strings from distinct
utterances are delivered separately. The core's
ReazonSpeech ja-en/Silero/hayamimi policy uses a 6-second default audio segment
cap; provisional fallback remains local to each segment ID.
`onEvent` optionally observes original core diagnostics/lifecycle events;
transcript processing belongs on the ports. `TranscriptOutputNode` accepts an
async callback `(port, text, signal)` and can serve as a UI, storage or test sink.

`SpeechToTextNode.maxDuration` is an optional shared `NUMBER` input in seconds
(finite 1–12, decimals supported). Configure with `speech.receive('maxDuration',
2.5)` before `pipeline.start()`, or pass `{ maxDuration: 2.5 }` to the constructor.
With a connected configuration input, the consumer waits for its first ordinary
port delivery before loading its model. Any compatible producer can supply it;
there is no constant extraction or special synchronous edge. While waiting, it
owns a buffer of at most 30 seconds of PCM. Missing configuration on Stop or
buffer overflow fails visibly, with no default fallback or model startup. Invalid
values fail before loading. The first valid value freezes the configuration;
updates arriving after loading begins fail visibly. Without a connection, the
constructor/default value applies. Whisper.language follows the same policy with
`en`/`ja` validation. Saving graph edits affects only fresh instances. No universal
configuration scheduler is involved.

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

The [extension graph editor](extension-graph.md) saves a version 9 description
with concrete production Node types and explicit named-port edges. The extension
builder constructs this shared Pipeline at each session boundary. ASR, OPUS-MT
directions, Supertonic 3 and Kokoro remain independent production processors;
ordinary text flows connect directly through shared `TEXT` ports, and audio
playback remains a separate Node. Version 1–8 descriptions migrate explicitly
to version 9, removing extraction adapters while preserving their downstream
routes and fan-out; old paired result edges expand into correlated primitive
routes. Version 7 removes only dead Whisper provisional connections, with
non-destructive repair if required inputs become disconnected; Whisper exposes
only final TEXT, while ReazonSpeech retains both outputs. Legacy views become
generic TEXT displays. Version 9 replaces paired formatters with ordinary configurable
TextFormatter Nodes through a visible, non-destructive migration review. Removed
status/index/provisional routes stay recoverable in the original JSON backup. Shared `LiveTextDisplayNode`
mounts DOM only. TextAccumulator owns text history; DOMAccumulator explicitly owns DOM history; TextFormatter owns bounded formatting; TextToDOM and PairedTextToDOM construct DOM on the page main thread. Native DOM snapshots never cross Worker messages.
Independent formatter inputs update latest values immediately; only directly
grouped inputs update together. No editor, model selection, storage or inference
policy is added to the generic Pipeline runtime.

## Optional transcript correction

`SpeechTranscriptCorrectionNode` owns a Qwen3 0.6B Worker and exposes plain
`TEXT` input/output. Connect `SpeechToTextNode.final` directly to
`SpeechTranscriptCorrectionNode.text`; fan out the final string to preserve a
separate original transcript branch. Connect the correction's `text` output
directly to translation or other `TEXT` consumers. It can be omitted or
explicitly bypassed, with no default graph or extension change. See
[model, lifecycle, conservative policy and evaluation](correction-node.md).

## Extension drafts and source completion

The Extension validates stored structure separately from execution. It selects
complete paths to ready sinks before constructing a Pipeline; parked Nodes never
allocate resources. Multiple active source/model instances retain their own
contexts, queues and routes. See [the graph policy](extension-graph.md#stored-drafts-and-concurrent-execution).

`Pipeline.drain(nodeIds)` applies the same topological queue/stop/close sequence
to a selected set. The caller must ensure no live producer can deliver to that
set and serialize it with full Stop. The Extension computes the live-source
reachability set and drains only its complement on source completion. Shared
consumers remain open. Closed entries are skipped by subsequent full Stop;
Cancel/dispose invalidates all entries, including a drain in progress.
