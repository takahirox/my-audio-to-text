# Continuous ASR and translation rows

For one visible row per utterance, use three `PairedTextToDOM` Nodes and one
`KeyedDOMAccumulator`. Both use existing primitive `TEXT`, `NUMBER` and `DOM`
contracts. No translator-specific display, preview history or Settings are needed.

| Producer outputs (one atomic delivery) | Consumer inputs |
| --- | --- |
| ASR `provisionalId`, `provisional` | preview pair `id`, `input1` |
| ASR `finalId`, `final` | final pair `id`, `input1` |
| ASR `finalId`, `final` | translator `id`, `text` |
| translator `id`, `source`, `text` | translated pair `id`, `input1`, `input2` |
| preview pair `id`, `dom` | keyed history `id1`, `dom1` |
| final pair `id`, `dom` | keyed history `id2`, `dom2` |
| translated pair `id`, `dom` | keyed history `id3`, `dom3` |
| keyed history `dom` | `LiveTextDisplay.dom` |

Leave `input2` on the preview/final formatters unconnected for an empty right
cell. The source remains visible during translation: preview → final with an
empty right cell → final with translation. Provisional B can append below pending
final A, and A's translation replaces A in place. Repeated strings with distinct
IDs remain separate rows. Omitting the translator and its formatter gives direct
transcription with the same continuous history.

The [executable graph fixture](../tests/fixtures/keyed-dom-graph.js) constructs
these exact production Nodes and edges with `graphNode()` and `edge()`. Its
`keyedDOMGraph()` supports both OPUS-MT directions and both TranslateGemma
directions; `keyedDOMGraph(null)` omits translation. The deterministic runtime
suite and MV3 saved-graph test exercise this wiring.

## Atomic IDs and lifecycle

ASR allocates safe integer IDs unique across producer instances in the page
session. Each utterance keeps its ID through provisional and final updates,
including interleaved open utterances. Final-only ASRs expose `finalId` too.
Start resets each producer's utterance map; the page allocator never reuses old
numbers. Late work cannot collide with a fresh graph. Core-local worker IDs and
worker RPC IDs remain private and are distinct from public utterance IDs.

ASR final and preview clear are one atomic emission containing `final/finalId`
and `provisional/provisionalId`, with the same ID. The producer declares its
provisional output family so the Pipeline retains `context.provisional` on
preview-only routes even in that combined emission. A consumer connected to both
families receives one coherent group, and the translator accepts the final.

## Independent primitive inputs (#188)

Connection compatibility depends only on primitive contracts. Every NUMBER
output can feed any ID input, including `Number.value → translator.id`,
`PairedTextToDOM.id` and any `KeyedDOMAccumulator.idN`, while separate producers
supply TEXT/DOM. Output families and producer identity never restrict wiring.
Atomic delivery is optional: it applies all supplied values together before one
update, in any property order. It does not correlate independent events or prove
that an ID describes a payload. The graph author supplies that meaning.

IDs accept finite JavaScript numbers unchanged, including negative, fractional
and larger-than-safe-integer values. Consumers reject nonnumbers, NaN and
infinities without coercion. Keyed history uses numeric Map equality: equal
numbers share a row (including `0` and `-0`); different numeric values are separate
keys. ASR's allocator still chooses unique safe integers for its own utterances.

| Consumer | ID-first | payload-first / no ID | ID-only / changing ID | Simultaneous atomic delivery |
| --- | --- | --- | --- | --- |
| Translation (scheduler and standalone) | Remember ID; each TEXT event accepts a job with that ID. | Accept text immediately with no ID. Later ID events cannot label that job or replay its text. | Remember for future TEXT only. Committed and provisional channels retain separate IDs. | Apply ID before accepting TEXT. A final and preview together accept only the final in the scheduler. |
| PairedTextToDOM with `id` connected | Remember ID; either TEXT side emits both current sides under it. | Hold both latest sides until the first ID, then emit once, even for empty text. Without any ID event, emit nothing on this keyed route. | Same ID emits nothing after a pair was emitted. A different ID clears both held sides without emitting; wait for new TEXT. Never relabel an emitted pair. | Apply ID first; emit one pair. Changing ID clears both old sides. Omitted TEXT siblings in the delivered family clear. |
| KeyedDOMAccumulator, each slot independently | Remember ID; each DOM delivery updates that key. | Clone and hold the latest DOM until the first ID, then insert it once. Without an ID, no row is inserted. | Same ID never replays DOM. A different ID waits for fresh DOM; previously inserted rows keep their keys. | Apply each slot's ID and DOM together; emit one full history snapshot. |

Independent payload updates use the current ID until it changes. They cannot
predict a future ID: send a new ID before its payload, or send both atomically,
when starting another row. A payload already emitted under an ID is never moved
to a later ID. Before the first ID, only the most recent pending payload is held.
Duplicate TEXT/DOM deliveries still update; empty TEXT and empty DOM are valid
updates. No string matching, timing guesses or causal joins are performed.

`PairedTextToDOM.id` remains optional. With no ID connected, #184 semantics are
unchanged: either side emits both latest values, including duplicate and empty
updates. Independent sides retain each other's values; grouped deliveries clear
omitted TEXT siblings in their own family. With an ID, the same rules apply
within the current ID; changing it resets both sides. ID-bearing provisional
empty pairs emit no row, so a preview clear cannot blank a finalized utterance,
even when the final branch is delayed. Committed empty pairs remain valid.

Each translator snapshots its ID (or its absence) when accepting a job, including
queued identical strings, empty input and failures. Later ID updates never mutate
running or queued jobs. The scheduler's committed output family is
`id/source/text/error`; its independent preview family is
`provisionalId/provisionalSource/provisionalText/provisionalError`. Preview clears
retain the preview job's ID. A failure emits source/error without successful
`text`; a grouped formatter clears the omitted right side and retains the source.
Standalone translation Nodes use the same result family when their ID input is
connected, omitting `id` if none was available; their ID-less usage retains its
existing zero/multiple-output plain-TEXT contract. The scheduler emits ID-less
results normally when no ID was available; it never waits for one.

An atomic payload snapshot whose family includes an ID but omits its value
explicitly clears that consumer's current ID, rather than borrowing the ID of an
older result. DOM consumers then hold the new unidentified payload for their next
ID. An independent payload delivery whose family does not include ID retains the
current ID. This keeps ID-less asynchronous results from acquiring an old key.
ID-only deliveries never clear TEXT siblings or start translation.

## Generic keyed history

`KeyedDOMAccumulator` accepts up to three independent `idN/domN` input
slots, each with its own latest finite numeric key and pending DOM. One input cannot borrow another
input's latest ID. New keys append in arrival order; existing keys replace their
own row without moving it. Each slot has explicit precedence: a higher numbered
slot supersedes lower numbered slots for the same key. Same-slot updates replace
in arrival order. Thus delayed preview work cannot overwrite a final row, and a
delayed final formatter cannot overwrite an already translated row. This rule
uses the connected input slot, never producer types, text, DOM content or timing.
Use any subset of the three slots for other keyed DOM compositions.

History validates and clones incoming DOM and emits an independent complete
snapshot. Start clears the map. Stop drains accepted work; Cancel discards pending
translation work. Stop/Cancel/dispose retain the latest visible rows and reject
late deliveries; a new Pipeline uses fresh Nodes. History is session-only and
unbounded, like `DOMAccumulator`. The existing append-only accumulator is unchanged.

The additive ports and new Node keep graph version 15: existing saved graphs are
not rewired or rewritten. Independent NUMBER/TEXT/DOM sources are valid and
execute normally. Incomplete keyed slots remain saveable and inactive; a complete
slot uses any ready ID and DOM sources. Optional IDs do not park otherwise ready
translation or paired TEXT paths. Historical migration/recovery rules and
original-storage retention remain unchanged.
