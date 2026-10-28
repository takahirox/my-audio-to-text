# Primitive-first Node/Port contracts

Issues #91, #95, #99 and #119 audit shared Nodes, the Node Playground, and the extension.
Ordinary text uses shared `TEXT`; Number constants and speech duration use shared `NUMBER`
from `web/port-contracts.js`. No BOOLEAN value is consumed, so none is introduced.
Contracts are identities; receiving Nodes validate their payloads.

| Boundary | Public ports and values | Internal or observer bookkeeping |
| --- | --- | --- |
| Capture sources: microphone, browser tab, extension tab/selected media | `audio: MONO_16KHZ_PCM`, normalized mono 16 kHz Float32Array | Target, permission, resampler and diagnostics |
| Text | `value: TEXT`, any literal string, including empty | One emission at session start; direct language edges bind before loading |
| SpeechToTextWhisper | `audio: PCM`, optional startup `language: TEXT` (en/ja; default en); `final: TEXT` only | Multilingual tiny q8, Silero, fixed 6 s segments; Stop drains / Cancel releases |
| SpeechToTextParakeetV3 | `audio: PCM → final: TEXT` only | Exact v3 ONNX; GPU encoder/CPU decoder; quiet/12 s chunks; Stop drains / Cancel releases |
| SpeechToTextMoonshineMediumEn | `audio: PCM → provisional: TEXT, final: TEXT` | Exact 245M English Medium Streaming; native incremental lines; 30 s stream renewal; Stop drains / Cancel releases |
| Number | `value: NUMBER`, finite numeric constant | Consumers define units and domain limits |
| SpeechToTextReazonSpeech / TranscriptOutput / speech Playground | `audio: PCM`, optional startup `maxDuration: NUMBER` in seconds; `provisional: TEXT`, `final: TEXT`, plain strings | Frozen session cap (default 6 s, supported 1–12 s), core session/utterance IDs, load/drain state, VAD; duplicate final IDs suppressed before fan-out |
| OPUS-MT (both directions), TranslateGemma / translation Playground | `text: TEXT → text: TEXT` | Worker request IDs and inference state; input queue preserves order |
| SpeechTranscriptCorrection / correction Playground | `text: TEXT → text: TEXT` | Candidate validation, worker IDs, bypass/error diagnostics |
| Extension TranslationScheduler (both directions) | `text: TEXT` input; `source`, `text`, `error`: TEXT outputs | FIFO committed utterances, inference IDs, model failure and Stop policy; no public status/index/provisional ports |
| LiveTextDisplay | content: TEXT | Render latest plain snapshot verbatim |
| TextAccumulator | append/preview: TEXT → text: TEXT | Newline-separated committed segments plus optional uncommitted tail |
| TextFormatter | instance-configured input1…inputN: TEXT → text: TEXT | Bounded template, latest values; no implicit branch correlation |
| TextInput / TextOutput, focused field | `text: TEXT`, plain strings | Field insertion sequencing/document targeting and UI state |
| Supertonic 3 / Kokoro / TTS Playground | `text: TEXT → audio: SYNTHESIZED_AUDIO` | Language/voice, inference RPCs, timing |
| AudioOutput / playback and WAV adapter | `audio: SYNTHESIZED_AUDIO`, `{ samples: Float32Array, sampleRate: positive integer, channels: 1 }` | Playback URLs and cleanup |

The only structured public value retained is **synthesized audio**. Samples,
rate and channel layout are intrinsically coupled: interpreting samples without
their format changes duration/pitch or produces invalid playback/WAV. Models
produce different native rates. Captured audio instead has a fixed, agreed mono
16 kHz format and uses a bare typed array. These distinct contracts prevent
misinterpreting synthesis output as capture input; no blanket unification is needed.
Observer events, worker RPCs, configuration, graph JSON and UI row objects are
internal interfaces, not Node-to-Node port contracts.

## Correlated translation primitives

The extension scheduler accepts committed `text` only. Each successful utterance
emits `{ source, text, error: '' }` atomically with `context.emitOutputs()`.
Empty/whitespace input preserves the original source and emits empty translated
text without inference, in FIFO order. Failure emits `{ source, error }` with no
`text` output: successful TEXT consumers (fields, TTS, direct displays) receive
nothing for failed translations. A size error affects only that utterance; model
failure reports every queued/future utterance in order and keeps upstream ASR alive.
Pending work emits no ports. Runtime readiness/failure is visible separately.
Stop drains every committed job, including repeated phrases and the ASR tail;
Cancel discards pending jobs, terminates the Worker and suppresses late replies.
A new session uses fresh Nodes. No provisional translation path remains.

Direct `TextFormatter` inputs consume one coherent group. An explicit group is a
snapshot of that producer's connected formatter inputs; omitted siblings clear.
This makes a source/error result clear a previous translation even when error is
not wired, without sending a fake successful TEXT to other consumers. Delivery-local
`context.groupInputs` lists only the inputs wired directly from this producer.
Ordinary `emit()` updates retain other latest values. Independent producers retain
their own latest inputs; nothing joins branches, matches equal strings, or infers
utterance association. Referencing independent streams in one template displays
latest values, not a correlated pair. Input strings are substituted once as data.

Use `source → input1`, `text → input2`, optional `error → input3`, a multiline
template and `TextFormatter.text → TextAccumulator.append → text → LiveTextDisplay.content`. Every result adds one
row; no pending row or history replacement causes duplicate appends. A formatter
is stateless beyond latest inputs; history belongs to the display. Repeated equal
utterances are distinct rows. Plain successful `text` still fans out directly to
compatible sinks. TTS splits long text only inside its branch.

## Graphs and supported topology

Version 9 explicitly migrates versions 1–8. Existing `TextFormatter` instances
retain four inputs until edited; every instance owns its configured input count.
Legacy extraction adapters preserve downstream fan-out, ASR renames preserve IDs,
and dead Whisper previews are removed without redirecting to final. Older paired
views first expand their historic bundles, then become ordinary `TextFormatter`
Nodes. Source/text/error routes become input1/input2/input3; other metadata and
provisional translation routes are listed in a visible migration report.

Paired history/pending/canceled-row rendering cannot be preserved by a latest-value
formatter. Migration therefore opens an **unsaved repair draft**, blocks running
the old graph, and keeps the original storage untouched until the user reviews and
Saves. A sole paired formatter → display.replace route becomes append; ambiguous
shared/output routes remain in place for deliberate review. Unrelated nodes,
labels, positions, literal content and supported fan-out remain unchanged.
After Save, the original JSON remains under `processing-graph-before-v9` and is
visible in Graph Editor's **Original saved graph (migration recovery copy)**.
Malformed/ambiguous older graphs fail visibly without overwriting storage.
`PairedTextFormatter` has no supported palette or runtime implementation.

The editor validates per-instance ports, template references, primitive types,
one incoming edge per input, settings and acyclicity. Incomplete branches remain
saveable; Start selects only executable paths. Generic displays and formatters
accept arbitrary TEXT producers and invent no alignment. See
[runtime semantics](pipeline-runtime.md#correlated-primitive-outputs) and
[graph wiring and migration](extension-graph.md).

Graph v10 migrates each v9 append display through its own TextAccumulator; replace-only routes become content directly. Exact originals use `processing-graph-before-v10` (numbered copies on collisions); all earlier recovery copies remain accessible. See [display lifecycle and scaling](extension-graph.md#generic-text-displays).
