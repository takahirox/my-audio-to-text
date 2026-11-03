# Portable display items (#198)

Use one `Display.input: ITEM` sink for latest text, one keyed pair, or complete
ordered pair history. Processing and accumulation use portable data; browser
rendering belongs inside Display.

| Concrete contract | Value |
| --- | --- |
| `TEXT` | A literal string, including `''` |
| `KEYED_PAIRED_TEXT` | Exactly `{ id: finite number, first: string, second: string }` |
| `KEYED_PAIRED_TEXT_LIST` | A plain dense array of those pairs, ordered with unique IDs |

Records contain only enumerable data fields; extra fields, accessors, custom
prototypes, sparse arrays, duplicate IDs and nonfinite IDs are rejected. Negative,
fractional and large finite IDs are valid. Map equality applies (`0` and `-0`
identify the same key). Both strings are required; empty strings, whitespace,
newlines, repeated content and HTML-like text are valid. An empty array is a
complete empty history. There is no stage metadata, markup, DOM, presentation
configuration or host object in these values.

`snapshotPairedText` and `snapshotPairedTextList` validate, copy and deeply freeze
complete independent snapshots. Values round-trip through JSON and
`structuredClone`. Pipeline snapshots structured emissions before queueing and
fan-out, so subsequent caller mutation cannot alter accepted deliveries. These
contracts and processing Nodes require no browser APIs.

`ITEM` is an accepting abstract union, not an arbitrary-object payload or a
fourth concrete representation. The shared `compatiblePorts(output, input)` rule
accepts identical contract identities, plus TEXT/KEYED_PAIRED_TEXT/
KEYED_PAIRED_TEXT_LIST outputs into ITEM. ITEM cannot feed a consumer requiring
a concrete subtype. NUMBER, VIEW, DOM, audio and unrelated objects are not ITEM
subtypes. TEXT cannot feed the pair accumulator. There are no producer, model,
output-name, group-origin or connection-order restrictions. Editor gestures,
saved validation, executable selection and Pipeline construction share this rule;
runtime validation checks value shape against the declared concrete type.

## Recommended transcript graph

| Producer port(s) | Target port(s) |
| --- | --- |
| ASR `finalId / final` | `KeyedTextCoalesce.id1 / input1` |
| ASR `provisionalId / provisional` | `KeyedTextCoalesce.id2 / input2` |
| ASR `finalId / final` | translator `id / text` |
| `KeyedTextCoalesce.id / text` | `KeyedTextPair.id1 / input1` |
| translator `id / text` | `KeyedTextPair.id2 / input2` |
| `KeyedTextPair.pair` | `KeyedPairedTextAccumulator.pair` |
| `KeyedPairedTextAccumulator.pairs` | `Display.input` |

Import the [example graph](evidence/item-198.json) in Graph Editor. The
[executable fixture](../tests/fixtures/item-graph.js) also accepts either OPUS-MT
or TranslateGemma direction, or `null` for transcription alone.

`KeyedTextPair` keeps its four independently connectable NUMBER/TEXT inputs and
all three legacy outputs. Each coherent same-ID update also emits immutable
`pair: KEYED_PAIRED_TEXT`, including missing/empty right text. Its two branches
retain their own IDs and values, independent of delivery order and translator
timing. ID-only changes never replay completed text. See the
[primitive pairing semantics](keyed-text-history.md#keyedtextpair).

`KeyedPairedTextAccumulator` has only `pair: KEYED_PAIRED_TEXT` input and
`pairs: KEYED_PAIRED_TEXT_LIST` output. A new ID appends; an existing ID replaces
both strings in place without reordering. Every input emits a full independent
history, including duplicate and empty updates. Arrival order wins: there are no
hidden provisional/final/translation priorities, content matching or rendering.
Selection belongs explicitly to KeyedTextCoalesce before pairing. Start clears
and emits `[]`. Stop drains accepted updates then closes; Stop/Cancel/dispose,
aborted and stale contexts reject late updates while retaining the last history.
A fresh Start clears state. History is session-only and unbounded; full snapshot
construction and rendering cost time and memory proportional to history.

Provisional A appears immediately on the left; final A replaces it with no blank
gap. B can appear while translation A is pending. Late/out-of-order translation A
updates only A's existing row, retaining B and first-seen order. Equal strings
under distinct IDs remain distinct rows.

## Display and the host boundary

Display has **one input `input: ITEM`, no outputs and no Settings**. Each delivery
replaces its complete output: TEXT shows latest plain text, a pair shows one
two-column row, and a list shows its complete ordered history. Missing rows are
removed. Display neither stores keyed history nor selects stages nor mutates
inputs. One incoming edge is allowed; choose one concrete stream explicitly.

Connect any TEXT output directly to Display.input for plain latest text.
Connect KeyedTextPair.pair directly for the latest pair without history, or add
the accumulator explicitly for history. No builder or specialized display Node
is required.

The browser sink uses `textContent` and code-owned styles to create inert DOM.
Text preserves whitespace and wraps; pairs use equal-width table columns,
keyboard-focusable cells and accessible labels. Live mounts the whole snapshot
in its existing polite region and supports Copy text. Start clears; Stop/Cancel
retain the last rendering and reject late work. A future native host can render
these same portable values in native UI without changing upstream Nodes. Native
implementation is outside this Issue.

## Saved graphs and recovery

Graph version remains 15. An old `ViewBuilder.view → Display.view` route opens
an **unsaved reviewed compatibility draft**. The only draft addition is
`legacyView: true` on the existing Display spec: it keeps the single `view: VIEW`
port and its existing rendering implementation. IDs, settings, positions, edges,
fan-out and literal content remain intact. It is a saved compatibility marker,
not a new display type or configurable presentation setting. New Display Nodes
always expose only input: ITEM. An incompatible mixture of ports fails visibly.

The original saved JSON is untouched until reviewed Save. Save preserves its
exact bytes under `processing-graph-before-v14`, with numbered copies on collision;
all earlier recovery copies remain available under Graph actions → Recovery.
Reloading a reviewed legacy graph does not migrate again. To adopt ITEM, replace
that sink with a new Display and deliberately connect one supported concrete
stream. VIEW is not implicitly converted to ITEM.

Saved TextDisplay and TextToDOM/PairedTextToDOM/KeyedDOMAccumulator/
LiveTextDisplay routes keep their existing implementations and storage without
migration. Existing defaults and preference-import graphs remain unchanged.
The [VIEW contract](view.md) and historical evidence JSON remain available for
legacy use; unrelated DOM functionality is retained.

See the [verification record](evidence/item-198.md) for checks and unperformed
real-model, full asset packaging and native-host validation.
