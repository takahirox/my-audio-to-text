# Live Graph Actions

Issue #219 adds a generic **Button** source under **Sources / inputs**. It has
no inputs and one ordinary `trigger: NUMBER` output. Every accepted activation
calls its live node context's `emit('trigger', 1)`. Equal markers are separate
deliveries. Any compatible graph path can consume them; Button has no knowledge
of text, summaries or models.

Set `label` in the inspector (up to 120 UTF-16 characters). Blank/whitespace uses
“Run action”. Save, Load saved, JSON Import and Export preserve the setting.
Live renders only Buttons in executable paths, in ascending Node ID order.
IDs address actions; duplicate captions remain independent. Positions affect only
the editor. Graph Actions wraps beside/below the recording controls; native
buttons support keyboard, touch and a minimum 44px target at narrow widths.
Button-only graphs can Start without invoking a tab or requesting audio access.
`INPUT_TYPES` continues to classify audio capture sources only.

## Hold's two modes

Hold still has exactly one output, `value: TEXT`, and silently stores `input: TEXT`.
Its optional `trigger: ANY` input selects the mode by **connection presence**:

| Saved connection | `value` behavior |
| --- | --- |
| No trigger edge | Original sampled state: starts empty, read alongside another ordinary consumer input, never emits; existing feedback graphs remain valid |
| Trigger edge | Ordinary emitted TEXT: every arriving trigger emits the latest stored string once; input updates alone never emit; normal event cycles are rejected |

Before receiving any TEXT, triggered Hold emits nothing. Live reports “Waiting
for first TEXT value; triggers emit nothing.” An explicitly received empty string
is valid state for a generic consumer. TextSummary separately rejects empty or
whitespace-only text before allocating its Worker. If your source explicitly
initializes with empty TEXT (as TextAccumulator does), wait for transcript content
before requesting a summary.

A grouped `input` + `trigger` delivery stores input first, then emits once,
regardless of property/edge order. Omitted grouped siblings are not deliveries.
Independent producers follow the Hold input queue's FIFO admission order. The
snapshot is captured in Hold's receive hook, before downstream inference; later
transcript changes cannot change an accepted request.

`ANY` is a sink-only arrival contract. It accepts TEXT, NUMBER, PCM, audio stream
and other existing output contracts, without changing ITEM's display union or
ordinary strict type checks. Declaring ANY as an output is rejected, including
ANY → ANY. The receiver sees an own input property with an unspecified payload
(currently `undefined`); it must test property presence, not truthiness. Routes
used only for ANY drop the payload before retention and avoid structured/audio
copying or parsing. A concrete sibling in a fan-out still gets its usual typed,
validated snapshot. Sampled outputs never generate arrival events: connecting a
sampled Hold.value to trigger remains silent, including during input-only updates.

Graph validation, executable-path selection, editor diagnostics and Pipeline use
the saved trigger edge to resolve sampled versus ordinary output mode. Pipeline's
optional `sampledOutputsForInputs(connectedInputs)` resolves this before building
routes, topology or feedback reachability. A connected trigger whose producer
is incomplete does not disappear and silently change the Hold's mode.

## Manual summary example

Import [manual-text-summary.json](examples/manual-text-summary.json), Save to
prepare the LFM2 model, invoke the toolbar on the audio tab, then Start:

```text
ASR.final → TextAccumulator.append
TextAccumulator.text → Display.input1 (Transcript)
TextAccumulator.text → Hold.input
Button.trigger → Hold.trigger
Hold.value → TextSummary.text
TextSummary.summary → Display.input2 (Summary)
```

Transcription/accumulation/display continue independently. Press **Generate
summary** for exactly one current snapshot; switch to the Summary tab to read the
result. Each Display input is a selectable tab with only one visible panel.
Button fan-out and multiple Hold instances use ordinary named edges.

For summaries downstream of a Hold with trigger connected, session Start installs
lifecycle hooks but **does not create a summary Worker, verify/load cached model
weights, initialize WebGPU or run inference**. First TEXT delivery validates the
32,768 UTF-16 character bound, then loads the cache-only model and generates.
The first action therefore includes model initialization latency; the Worker
stays warm for subsequent requests in that session. Ordinary ungated summaries
retain their existing eager startup checks. Save still prepares weights, and ASR
still initializes at Start. No recording-time model download or silent truncation
is introduced. Long recordings beyond the cap fail visibly; chunking/long-context
summarization remains separate work.

Live admits at most **one in-flight UI action for intersecting downstream paths**.
It marks those buttons busy before emitting, and observes existing Pipeline
queues/owned work until completion. Further UI activations during busy are
unavailable (they are not accepted or queued). Disjoint actions remain usable.
Programmatic/other-producer trigger deliveries are never deduplicated: they use
the existing serial queues. TextSummary admission remains bounded to 32 active
plus queued deliveries / 32,768 total characters; overflow visibly fails its
branch and cancels pending work, preserving the transcript and last result.

Buttons are disabled outside running state and after a reachable branch failure.
Callbacks capture the exact session, including callbacks rendered while idle;
stale callbacks cannot obtain a replacement session's contexts. Stop prevents
new UI admission and drains accepted work. Cancel aborts/discards pending work,
terminates Workers and suppresses late replies. Restart creates fresh nodes,
held state and action ownership. Failed summary paths do not stop transcription.

## Validation

Run `npm test` and:

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/graph-actions.spec.js tests/extension/graph-hold-feedback.spec.js
```

The MV3 fixtures package production extension/web modules with controlled ASR,
capture and summary Workers. They exercise actual Live and editor UI, persistence,
tabs, keyboard/touch at 390px, busy behavior, Stop, Cancel, failure and stale
handlers. They do not qualify real audio permission prompts, ASR/GPU inference,
model quality or performance. Full distribution packaging requires separately
prepared local runtime/model assets. See [execution evidence](evidence/graph-actions-219.md).
