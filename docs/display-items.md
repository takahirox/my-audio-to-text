# Portable display items (#198)

Use `Display.input1`, `input2`, … ITEM sinks for independently updating latest
text, keyed pairs, or complete ordered pair histories within an input tab of a Display view. Processing and accumulation use portable data; browser
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
a concrete subtype. NUMBER, audio and unrelated objects are not ITEM
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
| `KeyedPairedTextAccumulator.pairs` | `Display.input1` |

Import the [example graph](evidence/item-198.json) in Graph Editor. The
[executable fixture](../tests/fixtures/item-graph.js) also accepts either OPUS-MT
or TranslateGemma direction, or `null` for transcription alone.

`KeyedTextPair` keeps its four independently connectable NUMBER/TEXT inputs and
emits only immutable
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

Display has **1–32 numbered ITEM inputs**, no outputs, and
`inputCount`/`title`/`inputLabels` Settings. Each delivery replaces only its input's
snapshot: TEXT shows latest plain text, a pair shows one two-cell row, and a list
shows its complete ordered history.
Missing rows are removed. Other input snapshots stay intact, including omitted
siblings in grouped deliveries. Display neither accumulates nor processes text.
Each input accepts one incoming edge from any compatible producer. One Display is
one independent Live view with a switchable tab per input port and exactly one
input panel visible at a time, at any window width. Edit each tab label in
Settings; blank labels use `Input N`, and duplicate labels keep separate port
identities. `title` names the Display view. A single-input Display omits tab
navigation. Hidden inputs keep receiving snapshots; switching tabs shows the
latest snapshot without restarting processing. See the
[Display input-tab guide](extension-graph.md).

Connect any TEXT output directly to Display.input1 for plain latest text.
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

Graph version remains 15. Existing Display.input routes convert only to
Display.input1 and missing title/inputCount settings receive defaults. Load and
Import preserve Node IDs and other data; Save/Export write numbered ports.
Reading leaves stored JSON unchanged. Removed display Node types and their
ports are still unsupported. Validation reports the
unknown Node/port explicitly; Live disables Start and links to Graph Editor.
The editor opens a valid current default draft and shows the original saved JSON
under Graph actions → Saved JSON. Reading never rewrites stored data.

Choose Reset draft to default or Import graph JSON, inspect the current graph,
then Save to replace the saved graph. Import validates before changing the draft;
unsupported imports leave it intact. There is no automatic migration, rewiring,
legacy mode or accumulating display variant.

Validation uses unit contracts, editor/runtime tests, browser rendering and
controlled module Workers. These checks cover composition and lifecycle, without
claiming real model inference or a native host renderer.

Pair-table cells belong to one input snapshot, not to separate Display inputs.
See [Display input tabs](extension-graph.md) and the
[three-tab example](examples/display-tabs.json).
