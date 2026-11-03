# Primitive-first Node/Port contracts

Issues #91, #95, #99, #119 and #134 audit shared Nodes, the Node Playground, and the extension.
Ordinary text uses shared `TEXT`; Number constants and speech duration use shared `NUMBER`
from `web/port-contracts.js`; portable keyed pairs/history use `KEYED_PAIRED_TEXT`/`KEYED_PAIRED_TEXT_LIST`; abstract `ITEM` accepts those concrete types and TEXT; legacy portable text rows use `VIEW`; legacy page-local rendered snapshots use shared `DOM`. No BOOLEAN value is consumed, so none is introduced.
Contracts are identities; receiving Nodes validate their payloads. A compatible
ordinary edge’s type compatibility never depends on producer type, output name,
neighboring Nodes, or connection order. Correlated consumers validate delivery-local
grouping and provenance at runtime; PairedTextToDOM accepts provisional and committed
TEXT updates from independent producers as well as atomic deliveries. Graph validation checks structure, contracts and Node settings; incomplete
drafts remain saveable. Consumers own value limits, startup timing, correlation,
queues and failure reporting. Model selection, cache verification, permissions and
migration of historical interfaces remain specialized. See the [#134 audit](evidence/composition-134.md).

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
| ViewBuilder | optional id: NUMBER, input1/input2: TEXT → view: VIEW | Portable full text-row snapshots; optional keyed first-seen history, otherwise one latest row; no host APIs or Settings |
| KeyedTextPair | independent id1/input1/id2/input2: NUMBER/TEXT → pair: KEYED_PAIRED_TEXT plus legacy id/input1/input2 | Complete immutable same-ID pair; no DOM or history accumulation |
| KeyedPairedTextAccumulator | pair: KEYED_PAIRED_TEXT → pairs: KEYED_PAIRED_TEXT_LIST | Generic ordered append/replace, full owned history snapshots, arrival order |
| Display | input: ITEM only; no outputs | Render latest TEXT, one pair or complete ordered pair history; no accumulation or selection |
| Display (reviewed legacy mode) | view: VIEW only; no outputs | Existing VIEW rendering and original wiring retained after reviewed Save |
| TextDisplay (legacy) | optional id: NUMBER, input1/input2: TEXT; no outputs | Saved #194 browser compatibility with existing keyed history |
| LiveTextDisplay (legacy) | dom: DOM | Clone and mount the complete inert DOM snapshot |
| TextToDOM | text: TEXT → dom: DOM | Safe literal text and visible whitespace |
| TextWindow | text: TEXT; optional maxChars: NUMBER, maxWaitSeconds: NUMBER → text: TEXT | Exact generic batching; independent defaults 600 / 1.5 s; length/time/Stop only; Stop flushes once, Cancel discards; no threshold Settings or preview output |
| PairedTextToDOM | input1/input2: TEXT, optional id: NUMBER → dom: DOM, optional id: NUMBER; either text side may be unconnected | Either input emits both latest values, initially empty; one snapshot per atomic delivery; no history; hover/focus CSS |
| KeyedDOMAccumulator | atomic id1/dom1, id2/dom2, id3/dom3: NUMBER/DOM → dom: DOM | Append new keys, replace matching rows in place; higher slot supersedes lower; Start clears |
| DOMAccumulator | append: DOM → dom: DOM | Ordered session history of validated, cloned snapshots; Start clears, Stop/Cancel retain |
| TextAccumulator | append: TEXT → text: TEXT | Exact newline-separated committed segments |
| [TextSlidingWindow](text-sliding-window.md) | text: TEXT, optional maxChars: NUMBER → text: TEXT | Rolling bounded history; sentence/word eviction, code-point-safe suffix fallback; limit updates emit nothing |
| TextFormatter | instance-configured input1…inputN: TEXT → text: TEXT | Bounded template, latest values; no implicit branch correlation |
| TextInput / TextOutput, focused field | `text: TEXT`, plain strings | Field insertion sequencing/document targeting and UI state |
| Supertonic 3 / Kokoro / TTS Playground | `text: TEXT → audio: SYNTHESIZED_AUDIO` | Language/voice, inference RPCs, timing |
| AudioOutput / playback and WAV adapter | `audio: SYNTHESIZED_AUDIO`, `{ samples: Float32Array, sampleRate: positive integer, channels: 1 }` | Playback URLs and cleanup |
| Qwen3-TTS streaming / Speaker · streaming | [`stream: AUDIO_STREAM`](streaming-tts.md#public-port-limits-and-lifecycle), explicit start/chunk/end/abort events | Ordered utterance IDs, chunk sequences and native-rate PCM; distinct from a completed clip |

The portable structured public values include **keyed paired text**, **ordered pair lists**, **legacy VIEW snapshots**, **synthesized audio**
and explicit **audio stream events**. VIEW is minimal serializable data with ordered
rows of literal text cells and optional unique finite numeric IDs; see the
[VIEW invariants and builder/sink boundary](view.md). DOM snapshots are native page objects, never Worker payloads. Samples,
rate and channel layout are intrinsically coupled: interpreting samples without
their format changes duration/pitch or produces invalid playback/WAV. Models
produce different native rates. Captured audio instead has a fixed, agreed mono
16 kHz format and uses a bare typed array. These distinct contracts prevent
misinterpreting synthesis output as capture input; no blanket unification is needed.
Observer events, worker RPCs, configuration, graph JSON and UI row objects are
internal interfaces, not Node-to-Node port contracts.

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
(or no ID) per job. Any finite NUMBER producer can supply these optional IDs. PairedTextToDOM forwards a supplied ID atomically with DOM.
KeyedDOMAccumulator combines three independent or atomic ID/DOM slots with explicit slot
precedence and stable row ordering. See the [continuous ASR wiring and lifecycle
contract](keyed-dom-history.md). Existing ID-less ports and saved graphs retain
their behavior.

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
policy applies to every producer. Committed results use source/text/error only; preview results use provisionalSource/provisionalText/provisionalError only. Final acceptance, Stop and Cancel publish an empty preview family to clear explicit replacement routes. TranslationCommit validates causal closed windows, while ordinary wiring separates previews from commits; see [correlation semantics](windowed-translation.md#stage-2-bounded-retranslation-with-immutable-commits).

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
template and `TextFormatter.text → TextAccumulator.append → text → TextToDOM.text → dom → LiveTextDisplay.dom`. Every result adds one
row; no pending row or history replacement causes duplicate appends. A formatter
is stateless beyond latest inputs; history belongs to TextAccumulator. Repeated equal
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
After Save, new recovery copies use `processing-graph-before-v14`; earlier
`processing-graph-before-v*` copies remain available in Graph Editor's Recovery disclosure.
Malformed/ambiguous older graphs fail visibly without overwriting storage.
`PairedTextFormatter` has no supported palette or runtime implementation.

The editor validates per-instance ports, template references, primitive types,
one incoming edge per input, settings and acyclicity. Incomplete branches remain
saveable; Start selects only executable paths. TextToDOM accepts arbitrary TEXT producers.
PairedTextToDOM holds both latest values and emits on either input, including
duplicate and empty events. Unconnected sides stay empty; Start resets both. It
accepts independent producers and formats provisional and committed deliveries
identically. Explicit groups apply together and emit once, clearing only omitted
siblings within that group; independent updates retain the other side. Send both
values atomically when a consistent pair is required. Either available input
enables execution; LiveTextDisplay accepts DOM only. See
[runtime semantics](pipeline-runtime.md#correlated-primitive-outputs) and
[graph wiring and migration](extension-graph.md).

Graph v10 migrates each v9 append display through its own TextAccumulator; replace-only routes become content directly. Exact originals use `processing-graph-before-v10` (numbered copies on collisions); all earlier recovery copies remain accessible. See [display lifecycle and scaling](extension-graph.md#generic-text-displays).

Graph v11 removes the TEXT display port. Reviewed drafts insert TextToDOM while
keeping unrelated graph data. Current saves retain exact originals under
`processing-graph-before-v14`; older v11 recovery keys remain available.
Graph v12 reviews PairedTextToDOM source/text → input1/input2 and explicitly
removes former formatter error routes only in the draft, retaining unrelated error
fan-out. Missing input2 renders blank; the formatter owns no translation error UI.
See [DOM ownership, paired formatting and recovery](extension-graph.md#dom-formatters-and-display-ownership).

Graph v13 removes TextAccumulator's provisional input. Its only input is append:
TEXT; each event emits the full exact newline-separated committed history.
Replaceable provisional text travels through a separate TextToDOM branch and
DOMCombiner. Saved preview routes require reviewed conversion or deliberate
manual repair, with exact original JSON retained. See [v13 recovery details](extension-graph.md#graph-v13-append-only-migration-and-recovery).

Graph v14 splits all four extension translators into independent atomic committed
and preview TEXT families sharing one Worker. Older graphs with provisional
translator inputs or TranslationCommit require reviewed repair. The draft retains
existing routes; original JSON stays untouched until Save and is then preserved under
processing-graph-before-v14 (numbered on collisions). Preview formatting stays on
an explicit replacement branch. No accumulator preview state or new data type is
needed for this composition.

Graph v15 changes TextWindow to one TEXT output and optional NUMBER limits. Its
old Settings become explicit Number sources only in a reviewed repair draft;
removed provisional routes are listed, never silently redirected. Original JSON
and unrelated wiring are preserved. The established recovery namespace remains
processing-graph-before-v14 with numbered collisions. See [TextWindow contract
and recovery](windowed-translation.md#textwindow-saved-graph-review-178).
