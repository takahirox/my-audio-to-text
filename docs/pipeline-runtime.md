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
the **same token** (apart from the explicit input unions, specialized ITEM union and input-only ANY wildcard), including agreement on payload format (for example PCM sample rate). Names are descriptive, not structural
schema matching. Tokens impose no fields on payloads and do not validate values
at delivery time. Nodes own validation of their data contracts. Unknown nodes,
unknown ports, incompatible tokens, duplicate connections, multiple incoming
edges per input, duplicate node instances and cycles fail during construction. Unknown output emissions report
a node error. Ordinary event routes form a fixed acyclic graph; non-emitting sampled outputs may close feedback through held state.

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
processor may explicitly publish a new group, but has to own its association.
For an explicit `emitOutputs()` delivery,
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

Producers can mark unfinished results with
`context.emitOutputs(values, { provisional: true })`. The receiver sees immutable
`context.provisional` provenance, separate from primitive payloads and port names.
Ordinary emissions default to false. Forwarding through the receive context
retains true across async work, including `emit()` and grouped emissions; passing
false cannot clear inherited provisional provenance. Independent source emissions
do not inherit it. The translation scheduler marks preview jobs this way.
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
  After a node's Stop hook, it also waits for that node's explicitly owned async
  work before closing its emitter and draining downstream consumers.
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

### Queued asynchronous work (#207)

A receive promise normally spans processing and output. A node with its own
scheduler can instead accept a job promptly and acquire an explicit work handle
**during** its receive hook:

```js
receiveInputs(values, context) {
  const work = context.defer();
  this.queue.push({ values, work }); // enforce the node's queue bounds first
  this.pump();
}
// Later, in the node-owned scheduler:
try { job.work.context.emitOutputs(await process(job.values)); }
catch (error) { job.work.context.fail(error); }
finally { job.work.complete(); }
```

`work.context` preserves the accepted delivery's identity, cause, group inputs,
provisional flag and node signal. It is valid until the idempotent `complete()`;
it cannot create further work handles. Completing work retires its emitter;
attempted output afterward fails visibly while the node is live. Acquiring work
from an expired receive context is invalid. Node abort retires all its handles
and suppresses late output. Nodes still own Worker cancellation/resource cleanup,
queue limits, error reporting, and completion of replaced or discarded jobs.
Stop waits for owned work; a lost handle can stall Stop just like an unresolved
receive promise. Use Cancel/dispose to interrupt it. Existing sampled-turn
deadlines still apply to work on a feedback path.

Feedback turns track only emitting paths that can reach their required sampled
state writes, including inherited obligations of nested sampled consumers. An
independent fan-out branch retains delivery provenance but leaves that turn.
Its awaited receives and owned background jobs drain separately at Stop, and its
failure does not cancel the feedback path. Late output on such a branch must
use an explicit work handle, rather than an expired receive context. This
requirement follows every downstream delivery, including synchronous relays
and owned background emissions, independently of feedback-turn membership.
For sampled consumers without a reachable feedback write, the existing
conservative behavior still waits for all causal downstream work. Reachability
is structural across all emitting ports; no producer, node ID, TEXT contents or port name grants an
exception. A branch with any route back to the required state remains part of
the turn, even if a particular job emits only to a display port.

The extension translation scheduler uses one handle per committed or preview
job. Admission stays responsive; completion/output is separately owned. Pending
preview replacement, Stop, cancellation and disposal retire discarded handles;
committed jobs retain FIFO order, IDs, context snapshots and their output family.
This adds no payload fields or graph/editor persistence changes.

## Speech recognition composition

`BrowserTabAudioNode` and `MicrophoneAudioNode` in `web/transcription-nodes.js`
normalize capture to mono 16 kHz PCM. The concrete English Medium and Japanese
Small Moonshine Nodes each own a bounded Worker transport and native stream.
`provisional` and `final` carry plain TEXT; their corresponding NUMBER IDs allow
correlation. Final and preview clear are atomic, duplicate finals are suppressed,
and equal strings from distinct utterances remain distinct deliveries.

Standalone [model pages](node-playground.md) decode and replay files to test each
language independently. Extension graphs support browser-tab and microphone
capture. Both paths use the same recognition classes, typed ports and lifecycle.
The extension adds targeting and UI around the shared Pipeline.

A browser-tab graph can be composed explicitly:

```js
const { Pipeline } = await import('../../pipeline.js');
const { BrowserTabAudioNode, TranscriptOutputNode } = await import('../../transcription-nodes.js');
const { SpeechToTextMoonshineMediumEnNode } = await import('../../moonshine-medium-node.js');
const speech = new SpeechToTextMoonshineMediumEnNode();
const transcript = new TranscriptOutputNode((port, text) => console.log(port, text));
const tab = new BrowserTabAudioNode({ onEnded: () => void pipeline.stop() });
const pipeline = new Pipeline({ nodes: { tab, speech, transcript }, connections: [
  { from: ['tab', 'audio'], to: ['speech', 'audio'] },
  { from: ['speech', 'provisional'], to: ['transcript', 'provisional'] },
  { from: ['speech', 'final'], to: ['transcript', 'final'] },
] });
await speech.load();
const button = document.createElement('button');
button.textContent = 'Capture English tab speech';
button.onclick = () => pipeline.start().catch(console.error);
document.body.append(button);
```

Load before clicking the capture button. A browser sharing picker requires a
user gesture and tab-audio support. Stop with `await pipeline.stop()` to drain
accepted audio, then `await pipeline.dispose()` to release resources. Cancel with
`await pipeline.dispose()` to discard queued work. Catch failures and dispose.
Each graph is single-use; `speech.nextSession()` can transfer a successfully
drained warm core to a fresh Node. Fresh extension sessions release and initialize
their own Workers. No state is shared between languages or sessions.

See [model assets, licenses and native streaming behavior](optional-asr-nodes.md).
Deterministic tests verify transport/capture/lifecycle; opt-in real-model tests
record transcript and latency evidence without making downloads a default gate.

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

The [extension graph editor](extension-graph.md) saves a version 15 description
with explicit production Nodes and named-port edges. The builder constructs this
Pipeline at each session boundary. Processing uses portable TEXT and keyed pairs;
Display privately renders the supplied whole item. Unknown Nodes/ports fail
visibly with explicit Reset/Import recovery. Existing version-15 Display.input
routes have a narrow [numbered-port conversion](extension-graph.md); other
unsupported Nodes/ports are not migrated. The
Pipeline itself owns no model selection, editor or persistence policy.

Portable text graphs use KEYED_PAIRED_TEXT and KEYED_PAIRED_TEXT_LIST snapshots.
KeyedTextPair emits a complete immutable pair; KeyedPairedTextAccumulator emits
ordered append/replace histories. Display receives configurable input1…inputN:
ITEM, accepting TEXT, one pair or a full pair list per input. Each delivery
replaces only that input's snapshot; omitted grouped inputs keep their snapshots.
Each Display is an independent Live view with one switchable tab per input port
and exactly one input panel visible at a time, at any window width. Display
Settings provide editable input tab labels (`inputLabels`); blank labels use
`Input N`, and duplicate labels do not change port identity. A single-input
Display omits tab navigation. Hidden inputs keep updating, and switching tabs
shows their latest snapshots without restarting processing. Ordinary type-only
routing, atomic deliveries and fan-out apply without runtime special cases. See the
[ITEM contracts](display-items.md).

## Optional transcript correction

`SpeechTranscriptCorrectionNode` owns a Qwen3 0.6B Worker and exposes plain
`TEXT` input/output. Connect `Moonshine Node.final` directly to
`SpeechTranscriptCorrectionNode.text`; fan out the final string to preserve a
separate original transcript branch. Connect the correction's `text` output
directly to translation or other `TEXT` consumers. It can be omitted or
explicitly bypassed, with no default graph or extension change. See
[model, lifecycle, conservative policy and evaluation](correction-node.md).

## Extension drafts and source completion

The Extension validates stored structure separately from execution. It selects
complete paths to ready sinks before constructing a Pipeline; parked Nodes never
allocate resources. Multiple active source/model instances retain their own
contexts, queues and routes. See [the graph policy](extension-graph.md).

`Pipeline.drain(nodeIds)` applies the same topological queue/stop/close sequence
to a selected set. The caller must ensure no live producer can deliver to that
set and serialize it with full Stop. The Extension computes the live-source
reachability set and drains only its complement on source completion. Shared
consumers remain open. Closed entries are skipped by subsequent full Stop;
Cancel/dispose invalidates all entries, including a drain in progress.

For atomic final/preview-clear deliveries, a Node can declare `provisionalOutputs`
as the names of its unfinished output family. A consumer receiving only those
outputs retains `context.provisional`; a consumer receiving committed outputs in
the same delivery sees a committed group. Forwarding retains the flag across
async processing. See [keyed utterance history](display-items.md).

## Sampled state and feedback (#202)

With trigger disconnected, `HoldNode` resolves `sampledOutputs = ['value']`
and declares `readOutput(port)`, alongside its TEXT input/output contracts. This is a node capability, not an edge
option or producer identity rule. Pipeline never routes an event from a sampled
output; attempting to emit it fails. Connections still undergo normal port,
duplicate and single-incoming validation. Topological sorting considers only
emitting routes, so an emitting cycle remains invalid.

On an ordinary delivery to a consumer with sampled inputs, Pipeline waits for
already queued state writes and adds the current readable values to that one
input map. `receiveInputs` sees one atomic delivery. Each sampled consumer's
FIFO waits for its receive promise and downstream deliveries on paths capable of
writing its feedback before processing the next input. Delivery-scoped bookkeeping,
never string equality or an arbitrary output event, detects completion. If the
forward event path reaches a sampled state source, that state must be updated
by this work; missing storage is a visible failure. Async nodes must return a
promise spanning their work or explicitly own it with `context.defer()`; owned
work on a feedback path retains that completion obligation. Detached
session-context events do not complete feedback work. Nested sampled deliveries
retain their parent's completion obligation.

The active delivery counts toward the per-consumer limit of 32 deliveries /
32,768 ordinary-input string characters; overflow visibly fails that branch
and cancels queued work. Each sampled update has a four-minute deadline; abort
also invalidates its downstream contexts. Stop uses the event topological order,
so source tails enter the FIFO before downstream nodes close. Cancel and dispose
abort immediately. Fresh Pipeline/node instances are required for Start.
See the [importable example and lifecycle details](text-summary-nodes.md).

## Connection-dependent sampled outputs

A Node may implement `sampledOutputsForInputs(connectedInputs)` to resolve its
sampled outputs during construction, before routes, topology and feedback
reachability are built. Hold uses this to keep its sole value output sampled
only when trigger is disconnected. With trigger connected, normal event cycle
checks apply. ANY inputs represent arrivals: payloads are discarded before
retention, and sampled outputs do not inject values into ANY inputs. See
[Graph Actions](graph-actions.md) for ordering, UI admission and session ownership.


Speech recognition uses only language-specific [Moonshine streaming Nodes](optional-asr-nodes.md). The new default graph is Japanese Small; English examples select English Medium explicitly.
