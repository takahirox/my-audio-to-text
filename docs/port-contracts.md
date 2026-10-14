# Primitive-first Node/Port contracts

Issues #91, #95 and #99 audit shared Nodes, the Node Playground, and the extension.
Ordinary text uses shared `TEXT`; Number constants, speech duration and scheduler final indices use shared `NUMBER`
from `web/port-contracts.js`. No BOOLEAN value is consumed, so none is introduced.
Contracts are identities; receiving Nodes validate their payloads.

| Boundary | Public ports and values | Internal or observer bookkeeping |
| --- | --- | --- |
| Capture sources: microphone, browser tab, extension tab/selected media | `audio: MONO_16KHZ_PCM`, normalized mono 16 kHz Float32Array | Target, permission, resampler and diagnostics |
| Number | `value: NUMBER`, finite numeric constant | Consumers define units and domain limits |
| SpeechToText / TranscriptOutput / speech Playground | `audio: PCM`, optional startup `maxDuration: NUMBER` in seconds; `provisional: TEXT`, `final: TEXT`, plain strings | Frozen session cap (default 6 s, supported 1–12 s), core session/utterance IDs, load/drain state, VAD; duplicate final IDs suppressed before fan-out |
| OPUS-MT (both directions), TranslateGemma / translation Playground | `text: TEXT → text: TEXT` | Worker request IDs and inference state; input queue preserves order |
| SpeechTranscriptCorrection / correction Playground | `text: TEXT → text: TEXT` | Candidate validation, worker IDs, bypass/error diagnostics |
| Extension TranslationScheduler (both directions) | Inputs: optional `provisional: TEXT`, required `text: TEXT`; successful `provisional: TEXT` / `text: TEXT` outputs; grouped source/status/error TEXT outputs for each stream and `finalIndex: NUMBER` | Active inference, provisional versions, FIFO finals, model failure and Stop policy |
| PairedTextFormatter (compatibility) | `text`, `provisionalText`, `finalSource`, `finalStatus`, `finalError`, `provisionalSource`, `provisionalStatus`, `provisionalError`: TEXT; `finalIndex`: NUMBER | Indexed local history emitted as TEXT; uses `receiveInputs`, never joins branches or matches by strings |
| LiveTextDisplay | replace/append: TEXT | Independent replace value and committed list; no processor identity |
| TextFormatter | input1–input4: TEXT → text: TEXT | Bounded template, latest values; no implicit branch correlation |
| TextInput / TextOutput, focused field | `text: TEXT`, plain strings | Field insertion sequencing/document targeting and UI state |
| Supertonic 3 / Kokoro / TTS Playground | `text: TEXT → audio: SYNTHESIZED_AUDIO` | Language/voice, inference RPCs, timing |
| AudioOutput / playback and WAV adapter | `audio: SYNTHESIZED_AUDIO`, `{ samples: Float32Array, sampleRate: positive integer, channels: 1 }` | Playback URLs and cleanup |

The only structured public value retained is **synthesized audio**. Samples,
rate and channel layout are intrinsically coupled: interpreting samples without
their format changes duration/pitch or produces invalid playback/WAV. Models
produce different native rates. Captured audio instead has a fixed, agreed mono
16 kHz format and uses a bare typed array. These distinct contracts prevent
misinterpreting synthesis output as capture input; no blanket unification is needed.
Observer events, worker RPCs, configuration, graph JSON and UI row objects are
internal interfaces, not Node-to-Node port contracts.

## Correlated translation primitives

The scheduler uses `context.emitOutputs()` for each pending, complete or error
update. It publishes `finalSource`, `finalStatus`, `finalIndex`, `finalError`
together, adding `text` only on successful completion. Final indices are assigned
on receipt and distinguish repeated identical utterances. A provisional update
publishes `provisionalSource`, `provisionalStatus`, `provisionalError`, adding
`provisional` only on completion. There is no unused provisional index port.
Errors always carry a string; successful/pending updates clear it with `''`.
Status strings are `pending`, `complete`, or `error`. Cancel marks unresolved
compatibility rows `canceled` locally before invalidating
the session and disposing the graph; Live receives only the formatted string.

The paired compatibility formatter connects these outputs directly, renaming
`provisional` to
`provisionalText`, and consumes each group through `receiveInputs`. Pending/error
updates intentionally omit successful text. Row objects are formatter-local state;
no structured text object travels over an edge. `TEXT_RESULT` is
removed. Ordinary text processors connect only `text` (or preview `provisional`)
and receive strings without statuses or metadata. Each source/status/error/index
port is independently reusable with a compatible primitive consumer.

The scheduler coalesces provisional jobs, invalidates stale completions by
version, prioritizes FIFO finals, and emits each successful final string once.
Final receipt clears its own preview with an empty completed provisional group
before inference; an older final completion leaves a newer preview intact. Stop
clears provisional work and drains all final strings; Cancel ignores late replies.
ASR distinguishes equal strings by internal utterance IDs and suppresses duplicate
final IDs. TTS splits long text only inside its own branch, preserving whole text
for independent field consumers.

## Graphs and supported topology

Version 6 graphs explicitly migrate versions 1–5. Extraction adapters are bypassed
while preserving all downstream routes and fan-out. Version 4 paired result edges
expand to direct primitive connections; TEXT-only legacy views become generic
replace/append displays. Paired legacy views
retain every primitive route through a compatibility formatter into a generic
replace display.
Malformed or ambiguous routes fail visibly with Reset and Save recovery, and the
stored graph remains untouched on failure. Nothing is silently dropped.

The editor validates types, one incoming edge per input, required/optional inputs,
settings and acyclicity. Paired display requires the complete final bundle from
one translator, plus either no preview bundle or its complete direct bundle.
Metadata split across independent branches is rejected because it cannot preserve
correlation. Generic display accepts `replace` and/or `append` from any TEXT
producer and invents no alignment. Default graphs use paired primitive delivery.
See [runtime semantics](pipeline-runtime.md#correlated-primitive-outputs) and
[graph wiring](extension-graph.md).
