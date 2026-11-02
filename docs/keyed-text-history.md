# Primitive transcript pairing and text output

Use this graph for continuous ASR and translation. Original text appears before
translation, with a blank right side. Final text replaces provisional text in one
snapshot; a late translation for A updates A even while B receives ASR updates.

| Producer outputs | Consumer inputs |
| --- | --- |
| ASR `finalId` / `final` | `KeyedTextCoalesce.id1` / `input1` |
| ASR `provisionalId` / `provisional` | `KeyedTextCoalesce.id2` / `input2` |
| ASR `finalId` / `final` | translator `id` / `text` (direct branch) |
| `KeyedTextCoalesce.id` / `text` | `KeyedTextPair.id1` / `input1` |
| translator `id` / `text` | `KeyedTextPair.id2` / `input2` |
| `KeyedTextPair.id` / `input1` / `input2` | `TextDisplay.id` / `input1` / `input2` |

The [saved graph JSON](evidence/keyed-text-194.json) can be imported in the editor.
The [executable fixture](../tests/fixtures/keyed-text-graph.js) constructs these
exact production Nodes and edges. It accepts either OPUS-MT direction, either
TranslateGemma direction, or `null` for direct transcription. All edges after
ASR are ordinary NUMBER/TEXT. The audio source still supplies the existing audio
contract. ASR final and provisional clear travel together, so coalescing applies
both before selecting the nonempty final. The sink never chooses text priority.

## KeyedTextPair

Inputs are `id1: NUMBER`, `input1: TEXT`, `id2: NUMBER`, `input2: TEXT`.
Outputs are `id: NUMBER`, `input1: TEXT`, `input2: TEXT`. Despite their shared
names, the output ports are complete snapshots, not passthrough input events.
Each text update emits the updated ID and both latest strings for that ID as
one atomic group; a missing side is `''`. Explicit empty, duplicate and whitespace
strings are real updates. Both sides in a grouped delivery apply before one
emission per affected ID.

Each branch remembers its own current ID and its own strings per ID. Any NUMBER
producer and any TEXT producer can connect independently; source identities and
output families do not restrict connections. IDs are finite numbers, including
negative and fractional numbers. Map equality applies (`0` and `-0` share a key).

ID-first remembers the key for subsequent text. Before the first ID, the latest
unidentified text waits on that branch, including empty text. An ID-only event
can apply that waiting text once; after delivery, changing IDs never replays,
relabels or clears completed text. Returning to an earlier ID waits for a fresh
text event, which uses the retained other side for that ID. A branch never borrows
the other branch's ID. An atomic group that includes the ID port but omits its
value holds the new text unidentified instead of attaching it to an old ID.
Independent text updates use the branch's current ID until it changes: authors
must send a new ID before its text or deliver them together. No timing or content
matching can recover an absent correlation.

This processor uses no DOM, browser API, presentation history, selection priority,
Settings or custom port types. Start clears both maps and pending text. Stop,
Cancel, abort and dispose reject late work; a fresh Start rejects old contexts.

## TextDisplay host boundary

Inputs are optional `id: NUMBER`, `input1: TEXT`, `input2: TEXT`; at least one TEXT
connection is needed to execute. There are no outputs or Settings. Connect one
TEXT input for a plain view, both for two columns. With no ID connection, the
latest snapshot replaces the display. With ID connected, unidentified text waits
for its first ID. ID-only changes do not create rows or replay completed text.

For keyed snapshots, first sight of a key appends a visible row; subsequent
snapshots replace that key's values without changing first-seen order. Distinct
IDs keep distinct rows even for identical strings. Explicit empty strings clear
the supplied side; independent partial updates retain the other side for that
key. Grouped omitted TEXT siblings clear within their own delivery family.
Connect all three `KeyedTextPair` outputs for complete snapshots.

The browser sink creates inert elements and assigns `textContent`; strings such
as `<script>` render literally. Its private host callback mounts browser DOM in
Live; no DOM leaves through graph ports. Plain text preserves newlines; paired
rows have two equal-width, wrapping columns with neutral accessible labels.
Start clears visible history. Stop/Cancel preserve the last view and reject late
work. History lives only in the current session and grows with its utterances.
A future host can implement the same logical inputs using native UI while reusing
both primitive processors and upstream wiring. A native implementation is out of
scope.

## Compatibility and checks

Version 15 graphs round-trip without migration. Existing `TextToDOM`,
`PairedTextToDOM`, `KeyedDOMAccumulator`, `DOMAccumulator`, `DOMCombiner` and
`LiveTextDisplay` definitions, routes and recovery copies remain supported.
See [legacy DOM history](keyed-dom-history.md) for those graphs.

Regression commands:

```sh
npm test
npx playwright test tests/browser/keyed-text.spec.js --workers=1
npm run build:extension
npm run test:extension -- tests/extension/keyed-text.spec.js
```

Runtime regressions exercise the production ASR/coalesce/pair/output graph and
all four translation types with controlled Worker replies. Browser tests cover
editor selection, independent wiring, Save/reload, literal rendering and reverse
translation delivery. MV3 tests use controlled ASR/translation Workers and real
extension pages, storage, runtime, Live mounting and lifecycle. These checks do
not verify real model inference or a native renderer. See the
[implementation verification record](evidence/keyed-text-194.md) for checks run.
