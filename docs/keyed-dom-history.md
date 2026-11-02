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

`PairedTextToDOM.id` is optional. Without it, #184 semantics remain unchanged:
either side emits both latest values, including duplicates and empty updates;
grouped deliveries clear omitted siblings in their own family. With an ID, only
text in that same delivery is formatted; omitted sides are empty. An ID-only
update emits nothing. ID-bearing provisional empty pairs are preview clears and
emit no row, so they cannot blank a finalized utterance. Committed empty pairs
remain valid updates. Nonempty text on an ID-connected route without its grouped
ID is an explicit error, never a latest-ID fallback.

Each translator snapshots the ID per accepted job, including queued identical
strings, empty input and failure results. The scheduler's committed family is
`id/source/text/error`; its independent preview family is
`provisionalId/provisionalSource/provisionalText/provisionalError`. Preview clears
retain the preview's ID. A failure emits its ID and source/error without a
successful `text`; the formatter retains the finalized source with an empty right
cell, and translation diagnostics report the failure. Standalone translation
Nodes also accept grouped `id/text` and emit grouped `id/source/text/error`;
existing plain-TEXT usage retains its zero/multiple-output contract.

## Generic keyed history

`KeyedDOMAccumulator` accepts up to three independent atomic `idN/domN` input
pairs, with nonnegative safe integer keys. One input cannot borrow another
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
not rewired or rewritten. ID-bearing routes require direct outputs from one
atomic producer family; structurally mismatched routes fail validation, incomplete
drafts remain saveable and inactive, and delivery-local grouping is validated at
runtime. Historical migration/recovery rules and original-storage retention
remain unchanged. No identity is inferred from strings or from independently
scheduled branches.
