# Primitive-first Node/Port contracts

Issues #91, #95, #99, #119 and #134 audit shared Nodes, the Node Playground, and the extension.
Ordinary text uses shared `TEXT`; Number constants and numeric IDs use shared `NUMBER`
from `web/port-contracts.js`; portable keyed pairs/history use `KEYED_PAIRED_TEXT`/`KEYED_PAIRED_TEXT_LIST`; abstract `ITEM` accepts those concrete types and TEXT. No BOOLEAN value is consumed, so none is introduced.
Contracts are identities; receiving Nodes validate their payloads. A compatible
ordinary edge’s type compatibility never depends on producer type, output name,
neighboring Nodes, or connection order. Correlated consumers validate delivery-local
grouping and provenance at runtime. KeyedTextPair accepts independent NUMBER/TEXT
producers as well as atomic deliveries. Graph validation checks structure, contracts and Node settings; incomplete
drafts remain saveable. Consumers own value limits, startup timing, correlation,
queues and failure reporting. Model selection, cache verification, permissions and
runtime allocation remain specialized. See the [#134 audit](evidence/composition-134.md).

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

## Arrival-only ANY inputs

`ANY` is an input-only wildcard for event arrivals, independent of ITEM. Every
existing concrete output contract can connect; ANY outputs (including ANY → ANY)
are invalid. Receivers use own-property presence, never payload truthiness.
Pipeline discards ANY payloads before queue retention and skips copying when all
routes are arrival-only; concrete sibling routes preserve normal validation and
snapshots. Sampled reads cannot produce ANY arrivals. See [Graph Actions](graph-actions.md)
for Hold modes, ordering and lifecycle.

## Correlated utterance IDs

ASR `provisionalId/finalId: NUMBER` accompany the respective TEXT updates;
final-only ASRs also expose `finalId`. Translation accepts independent or atomic
`id/text` and `provisionalId/provisional`, snapshotting the latest available ID
(or no ID) per job. Any finite NUMBER producer can supply these optional IDs. KeyedTextPair associates both branches by numeric ID; the pair accumulator preserves first-seen row order with no stage priority. See the [continuous ASR wiring and lifecycle
contract](display-items.md). Ordinary ID-less TEXT processors remain supported.

## Floating Display

Floating Display is a sink with one `text: TEXT` input. Each delivery
replaces the visible snapshot, including repeated values and the empty string.
The host renders the string as plain text and clears the snapshot when the
session ends. The sink uses the same contract for provisional and committed TEXT.

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

Speaker's single `audio` input is the input-only union
`SYNTHESIZED_AUDIO | AUDIO_STREAM`. `inputUnion(...contracts)` composes shared
concrete identities (including nested unions); `compatiblePorts` accepts only
those concrete members. Unions cannot be output contracts, including to ANY.
They do not coerce values, merge edges, or relax the one-wire-per-input rule.
Pipeline exposes validated concrete source identities in `context.inputContracts`
and snapshots/validates audio before queued delivery and fan-out. Speaker
validates every payload using its connected concrete contract and keeps that
kind for the execution. Subgraph outputs retain their concrete identities.


Speech recognition uses only language-specific [Moonshine streaming Nodes](optional-asr-nodes.md). The new default graph is Japanese Small; English examples select English Medium explicitly.
