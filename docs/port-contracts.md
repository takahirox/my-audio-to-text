# Primitive-first Node/Port contracts

Issues #91, #95, #99, #119 and #134 audit shared Nodes, the Node Playground, and the extension.
Ordinary text uses shared `TEXT`; Number constants and speech duration use shared `NUMBER`
from `web/port-contracts.js`; portable keyed pairs/history use `KEYED_PAIRED_TEXT`/`KEYED_PAIRED_TEXT_LIST`; abstract `ITEM` accepts those concrete types and TEXT. No BOOLEAN value is consumed, so none is introduced.
Contracts are identities; receiving Nodes validate their payloads. A compatible
ordinary edge’s type compatibility never depends on producer type, output name,
neighboring Nodes, or connection order. Correlated consumers validate delivery-local
grouping and provenance at runtime. KeyedTextPair accepts independent NUMBER/TEXT
producers as well as atomic deliveries. Graph validation checks structure, contracts and Node settings; incomplete
drafts remain saveable. Consumers own value limits, startup timing, correlation,
queues and failure reporting. Model selection, cache verification, permissions and
runtime allocation remain specialized. See the [#134 audit](evidence/composition-134.md).

| Boundary | Public ports and values | Internal or observer bookkeeping |
| --- | --- | --- |
| Capture sources: microphone, browser tab, extension tab/selected media | `audio: MONO_16KHZ_PCM`, normalized mono 16 kHz Float32Array | Target, permission, resampler and diagnostics |
| Text | `value: TEXT`, any literal string, including empty | One ordinary emission at session start |
| SpeechToTextWhisper | `audio: PCM`, optional startup `language: TEXT` (en/ja; default en); `final: TEXT` only | Multilingual tiny q8, Silero, fixed 6 s segments; Stop drains / Cancel releases |
| SpeechToTextParakeetV3 | `audio: PCM → final: TEXT` only | Exact v3 ONNX; GPU encoder/CPU decoder; quiet/12 s chunks; Stop drains / Cancel releases |
| SpeechToTextMoonshineMediumEn | `audio: PCM → provisional: TEXT, final: TEXT` | Exact 245M English Medium Streaming; native incremental lines; 30 s stream renewal; Stop drains / Cancel releases |
| Number | `value: NUMBER`, finite numeric constant | Consumers define units and domain limits |
| SpeechToTextReazonSpeech / TranscriptOutput / speech Playground | `audio: PCM`, optional startup `maxDuration: NUMBER` in seconds; `provisional: TEXT`, `final: TEXT`, plain strings | Frozen session cap (default 6 s, supported 1–12 s), core session/utterance IDs, load/drain state, VAD; duplicate final IDs suppressed before fan-out |
| OPUS-MT (both directions), TranslateGemma / translation Playground | `text: TEXT → text: TEXT` | Worker request IDs and inference state; input queue preserves order |
| SpeechTranscriptCorrection / correction Playground | `text: TEXT → text: TEXT` | Candidate validation, worker IDs, bypass/error diagnostics |
| Extension TranslationScheduler (both directions) | `text: TEXT`, optional `provisional: TEXT` inputs; `source/text/error` and `provisionalSource/provisionalText/provisionalError`: two atomic TEXT output families | FIFO committed utterances, inference IDs, model failure and Stop policy; no public status/index metadata ports |
| KeyedTextPair | independent id1/input1/id2/input2: NUMBER/TEXT → pair: KEYED_PAIRED_TEXT | Complete immutable same-ID pair; no DOM or history accumulation |
| KeyedPairedTextAccumulator | pair: KEYED_PAIRED_TEXT → pairs: KEYED_PAIRED_TEXT_LIST | Generic ordered append/replace, full owned history snapshots, arrival order |
| Display | Configurable input1…inputN: ITEM; no outputs | One Live tab with independent latest TEXT/pair/list panes; no accumulation or processing |
| TextWindow | text: TEXT; optional maxChars: NUMBER, maxWaitSeconds: NUMBER → text: TEXT | Exact generic batching; independent defaults 600 / 1.5 s; length/time/Stop only; Stop flushes once, Cancel discards; no threshold Settings or preview output |
| TextAccumulator | append: TEXT → text: TEXT | Exact newline-separated committed segments |
| [TextSlidingWindow](text-sliding-window.md) | text: TEXT, optional maxChars: NUMBER → text: TEXT | Rolling bounded history; sentence/word eviction, code-point-safe suffix fallback; limit updates emit nothing |
| TextFormatter | instance-configured input1…inputN: TEXT → text: TEXT | Bounded template, latest values; no implicit branch correlation |
| TextInput / TextOutput, focused field | `text: TEXT`, plain strings | Field insertion sequencing/document targeting and UI state |
| Supertonic 3 / Kokoro / TTS Playground | `text: TEXT → audio: SYNTHESIZED_AUDIO` | Language/voice, inference RPCs, timing |
| AudioOutput / playback and WAV adapter | `audio: SYNTHESIZED_AUDIO`, `{ samples: Float32Array, sampleRate: positive integer, channels: 1 }` | Playback URLs and cleanup |
| Qwen3-TTS streaming / Speaker · streaming | [`stream: AUDIO_STREAM`](streaming-tts.md#public-port-limits-and-lifecycle), explicit start/chunk/end/abort events | Ordered utterance IDs, chunk sequences and native-rate PCM; distinct from a completed clip |

Portable public values include keyed pairs, ordered pair lists, synthesized audio
and explicit audio stream events. Browser rendering stays inside Display; no DOM
contract crosses graph edges. Samples, VAD spans and inference/job IDs remain
internal or observer data where they are not explicit public ports.

## Displayable ITEM compatibility

The small shared `compatiblePorts` rule accepts identical contracts and exactly
TEXT/KEYED_PAIRED_TEXT/KEYED_PAIRED_TEXT_LIST → ITEM. ITEM is an accepting union;
it cannot feed a concrete subtype. Other primitive and structured edges stay
strict. Editor gestures, graph validation, executable selection and Pipeline use
the same directional rule. Pipeline snapshots structured values before queued
fan-out and validates concrete TEXT values on ITEM routes. No producer identity
participates. See [exact portable shapes, lifecycle and recovery](display-items.md).

## Correlated utterance IDs

ASR `provisionalId/finalId: NUMBER` accompany the respective TEXT updates;
final-only ASRs also expose `finalId`. Translation accepts independent or atomic
`id/text` and `provisionalId/provisional`, snapshotting the latest available ID
(or no ID) per job. Any finite NUMBER producer can supply these optional IDs. KeyedTextPair associates both branches by numeric ID; the pair accumulator preserves first-seen row order with no stage priority. See the [continuous ASR wiring and lifecycle
contract](display-items.md). Ordinary ID-less TEXT processors remain supported.

## Correlated translation primitives

The extension scheduler accepts committed `text` and optional `provisional` TEXT. Each successful utterance
emits `{ source, text, error: '' }` atomically with `context.emitOutputs()`.
Empty/whitespace input preserves the original source and emits empty translated
text without inference, in FIFO order. Failure emits `{ source, error }` with no
`text` output: successful TEXT consumers (fields, TTS, direct displays) receive
nothing for failed translations. A size error affects only that utterance; model
failure reports every queued/future utterance in order and keeps upstream ASR alive.
Pending work emits no ports. Runtime readiness/failure is visible separately.
Stop drains every committed job, including repeated phrases and the ASR tail;
Cancel discards pending jobs, terminates the Worker and suppresses late replies.
A new session uses fresh Nodes. Provisional inputs coalesce to one pending
preview; newer inputs suppress stale preview results. Committed input wins if
both arrive in one group. Finals retain FIFO order. The same bounded queue
policy applies to every producer. Committed results use source/text/error only; preview results use provisionalSource/provisionalText/provisionalError only. Final acceptance, Stop and Cancel publish an empty preview family to clear explicit replacement routes. Route committed text directly to a display or through TextAccumulator for history; keep provisionalText on its own replacement display. See [windowed translation and previews](windowed-translation.md#optional-provisional-previews).

Direct `TextFormatter` inputs consume one coherent group. An explicit group is a
snapshot of the emitted output family's connected formatter inputs; omitted siblings clear within that family only.
This makes a source/error result clear a previous translation even when error is
not wired, without sending a fake successful TEXT to other consumers. Delivery-local
`context.groupInputs` lists only the inputs wired directly from this producer.
Ordinary `emit()` updates retain other latest values. Independent producers retain
their own latest inputs; nothing joins branches, matches equal strings, or infers
utterance association. Referencing independent streams in one template displays
latest values, not a correlated pair. Input strings are substituted once as data.

Use `source → input1`, `text → input2`, optional `error → input3`, a multiline
template and `TextFormatter.text → TextAccumulator.append → text → Display.input1`. Every result adds one
row; no pending row or history replacement causes duplicate appends. A formatter
is stateless beyond latest inputs; history belongs to TextAccumulator. Repeated equal
utterances are distinct rows. Plain successful `text` still fans out directly to
compatible sinks. TTS splits long text only inside its branch.

## Graphs and supported topology

Validation checks contracts and structure without producer-specific wiring rules.
Incomplete drafts remain saveable. Execution selects complete paths to sinks;
consumers own startup limits and delivery correlation. Unsupported Nodes, ports
and versions fail explicitly without migration. See [display contracts and
recovery](display-items.md) and [Graph Editor](extension-graph.md).

### Hold reads

Hold uses ordinary `input: TEXT` and readable `value: TEXT` contracts. Its value
connection is sampled during an ordinary input delivery to a consumer; storing
text never emits or triggers that consumer. It starts empty on each session.
This node capability breaks feedback without adding edge flags or changing
primitive compatibility. [Feedback example and limits](text-summary-nodes.md).
