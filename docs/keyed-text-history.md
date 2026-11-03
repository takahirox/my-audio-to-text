# ID-scoped text pairing

Use the [portable display path](display-items.md): KeyedTextPair →
KeyedPairedTextAccumulator → Display. The [importable graph](evidence/item-198.json)
shows the exact recommended ASR and translation connections.

## KeyedTextPair

Inputs are `id1: NUMBER`, `input1: TEXT`, `id2: NUMBER`, `input2: TEXT`.
The only output is `pair: KEYED_PAIRED_TEXT`, an immutable `{ id, first, second }`.
Each text update emits both latest strings for that ID in
one pair; a missing side is `''`. Explicit empty, duplicate and whitespace
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
or Settings. Start clears both maps and pending text. Stop,
Cancel, abort and dispose reject late work; a fresh Start rejects old contexts.

## History and rendering

Connect pair → KeyedPairedTextAccumulator.pair → pairs → Display.input for
continuous ordered history. The accumulator appends new IDs and replaces existing
IDs in place, emitting the complete list. It has no priority or ASR-specific rule.
Display renders the complete supplied TEXT, pair or list without accumulating.
For latest plain text, connect any TEXT output directly to Display.input.

See [display item contracts and lifecycle](display-items.md).
