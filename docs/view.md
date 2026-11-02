# Portable views and rendering (#196)

New graphs use one portable view/history processor and one rendering sink:

```text
ASR finalId/final ────────→ KeyedTextCoalesce.id1/input1
ASR provisionalId/provisional ───→ KeyedTextCoalesce.id2/input2
KeyedTextCoalesce.id/text → KeyedTextPair.id1/input1
ASR finalId/final ────────→ translator.id/text
translator.id/text ───────→ KeyedTextPair.id2/input2
KeyedTextPair.id/input1/input2 → ViewBuilder.id/input1/input2
ViewBuilder.view ─────────→ Display.view
```

Import the
[recommended saved graph](evidence/view-196.json) in Graph Editor, or use the
[executable fixture](../tests/fixtures/view-graph.js) with either OPUS-MT or
TranslateGemma direction, or `null` for transcription without translation.
Provisional A appears with an empty right cell. Final A replaces it without a
blank snapshot. B may appear before translation A, which updates A in place.
The two primitive processors retain their independent `id1`/`id2` ports and
NUMBER/TEXT contracts. No DOM appears in this processing path.

For a latest plain text view, connect any TEXT output to `ViewBuilder.input1`
(or `input2`), leave `id` disconnected, then connect `view → Display.view`.
Connect both TEXT inputs for two-cell rows using the same builder and sink.
Neither Node has Settings. There are no additional text/table display types.

## VIEW data contract

`VIEW` is a shared port identity in `web/port-contracts.js`. Its value is exactly:

```json
{"rows":[{"id":10,"cells":["Hello.","こんにちは。"]},{"id":11,"cells":["How are you?",""]}]}
```

- The outer plain record has only `rows`, a plain dense array in display order.
- Each plain row record has `cells`, a nonempty plain dense array of literal strings,
  and an optional `id`, a finite number. Supplied IDs must be unique within a
  snapshot. Map equality applies: `0` and `-0` identify the same key. Negative,
  fractional and large finite IDs are valid. IDs carry no rendering behavior.
- An empty `rows` array clears the view. Empty cells, whitespace, newlines,
  duplicate strings and HTML-like strings are valid data, preserved literally.
- One-cell rows are plain text; multiple cells are ordered columns. No styles,
  widgets, HTML strings interpreted as markup, DOM/native objects, callbacks or
  framework elements are permitted. Extra record fields and accessors are rejected.
- Each value is a **complete independent snapshot**, compatible with JSON and
  `structuredClone`. `snapshotView` validates, copies and deeply freezes it.
  ViewBuilder emits these immutable owned values for safe queued delivery and
  fan-out. A different VIEW producer must supply the same data contract; receivers
  validate it without inspecting producer type or port name.

## ViewBuilder update semantics

Inputs: optional `id: NUMBER`, `input1: TEXT`, `input2: TEXT`; execution requires
at least one TEXT connection. Output: `view: VIEW`. With one connected/received
TEXT side, each row has one cell; with both, each row has two cells, including an
empty cell for a side not yet supplied. Construction and history use no browser
APIs, source identity, stage priority or host settings.

A newly seen finite ID appends a row. Subsequent snapshots replace that row in
place, preserving first-seen order and every unaffected ID. A complete pair
replaces both cells; a missing right side is empty text, never a removed row.
Without a connected or supplied ID, the builder emits a latest-value single row
without an ID; it never invents keys or accumulates ID-less text.

Independent `receive`/`emit` updates patch only the supplied TEXT side for the
current key (or latest ID-less row), retaining the other side **for that key**.
TEXT before the first connected ID waits, keeping only the latest patch per
side. An ID-only event applies waiting, never-applied text once. After delivery,
ID-only changes do not create rows, emit blank views, replay or relabel text.
New IDs start with empty cells; returning to an earlier key retains its own cells.
With independent producers, send each new ID before its text or group them;
text after an existing ID belongs to that ID until changed.

An atomic `receiveInputs`/`emitOutputs` group validates completely before any
mutation and emits at most one VIEW. Omitted TEXT siblings listed in that
delivery's `groupInputs` clear to `''`; ungrouped sides retain their values.
A group that contains a wired ID port but omits its value cannot borrow the
previous key: its TEXT waits unidentified until an ID arrives. Input property
order, edge order and producer identity do not affect these rules. Connect all
three KeyedTextPair outputs to ViewBuilder for complete keyed snapshots.

Empty, whitespace and duplicate TEXT events all emit. Start clears history,
pending text and IDs and emits `{ "rows": [] }`. Stop drains accepted events,
then closes delivery. Stop, Cancel, abort and disposal reject late work and retain
the last emitted snapshot; a fresh Start rejects old contexts. History is session
only, unbounded, and full snapshots cost memory and time proportional to history.

## Display host boundary

`Display` has **only `view: VIEW` input and no outputs**. Each valid delivery
replaces the entire rendered view, including removing rows absent from the new
snapshot. It does not keep IDs, row history, latest text sides, stage priority or
producer information. Any compatible VIEW output can connect to it, regardless
of Node/port name. TEXT, NUMBER and legacy DOM connections are incompatible.

The browser implementation creates inert DOM privately, using `textContent`
and code-owned styles. Plain rows preserve line breaks and wrap long text.
Multi-cell snapshots use a table with equal-width columns, top alignment,
wrapping, neutral accessible cell labels and keyboard focus. Live mounts the
rendered snapshot, provides Copy text and a polite live region, and follows
updates only while the reader stays near the bottom. Start clears; Stop/Cancel
retain the last rendered content and reject late work.

A future native host can implement `Display` with native UI using exactly the
same VIEW snapshots and upstream graph. Native UI and real-model inference are
outside this change; no DOM or renderer callbacks cross VIEW ports.

## Saved graph compatibility

This is additive to graph version 15. Saved #194 `TextDisplay` graphs keep the
original implementation, inputs, history, lifecycle and literal rendering; the
palette marks it legacy. `TextToDOM`, `PairedTextToDOM`, `KeyedDOMAccumulator`,
`DOMAccumulator`, `DOMCombiner` and `LiveTextDisplay` remain the existing browser
compatibility path. Existing default/reset and legacy preference-import graphs
also keep their established behavior. Their nodes, IDs, settings, positions,
wires and serialized storage are not rewritten. Earlier reviewed migrations and
all recovery copies remain intact. Historical evidence JSON stays unchanged.

To adopt the new path deliberately, export the original graph first. Replace
each TextDisplay with ViewBuilder using the same incoming wires, then connect
its view to a new Display. Existing custom DOM compositions can keep their legacy
path; no automatic conversion claims to preserve arbitrary DOM formatting.
The new recommendation and importable JSON above use the portable path.

See the [verification record](evidence/view-196.md) for checks and limits.
