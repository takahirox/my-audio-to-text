# Primitive-first Node/Port contracts

Issue #91 audits shared Nodes, the Node Playground and the extension. Ordinary
text uses the one shared `TEXT` identity from `web/port-contracts.js`. Port names
express processing semantics: ASR `provisional` replaces a preview; ASR `final`
commits an utterance. Both values are strings. Connections select the intended
semantics explicitly. Type compatibility alone does not promise finality.

| Boundary / value | Public data | Internal or observer bookkeeping |
| --- | --- | --- |
| SpeechToText / TranscriptOutput / speech Playground | `provisional: TEXT`, `final: TEXT`; callback `(port, text, signal)` | Core session and utterance IDs, load/drain state, VAD events, audio diagnostics; duplicate final IDs are suppressed inside SpeechToText before fan-out |
| OPUS-MT (both directions), TranslateGemma | `text: TEXT → text: TEXT` | Worker request IDs, model/load state; single input serialization preserves result order |
| SpeechTranscriptCorrection | `text: TEXT → text: TEXT` | Candidate validation, Worker IDs, bypass/error diagnostics; final ASR connects directly, former FinalTranscriptText adapter removed |
| Extension TranslationScheduler | `provisional: TEXT` (optional), `text: TEXT` inputs; `provisional: TEXT`, `text: TEXT` successful outputs | One active job, replaceable provisional version, FIFO finals, model failures, Stop/Cancel policy; identity stays in the scheduler |
| Paired TranslationView | Optional `provisionalResult`, plus `finalResult`, from scheduler into view's `provisional`/`final` inputs: `TEXT_RESULT` | View rendering and session generation; it never joins separate text streams or matches ASR IDs |
| Focused field, TTS and independent text sinks | Plain `TEXT`; connect ASR `final` or scheduler `text`, with independent fan-out | Field insertion sequence/document authorization, synthesis RPCs, language/voice settings, UI state; no upstream metadata required |
| Captured audio | `MONO_16KHZ_PCM`: normalized mono 16 kHz Float32Array | Capture target, permission, resampler state |
| Synthesized audio | `SYNTHESIZED_AUDIO`: samples, sampleRate, channels together | Playback URLs and synthesis timing; incompatible with bare captured PCM |

No public NUMBER/BOOLEAN port is currently needed. Adding unused utterance IDs,
status enums or model-specific contract tokens would add mandatory coordination
without a real consumer. Independent supplementary values can use separately
named primitive ports when a consumer actually needs them.

## The paired result boundary

`TEXT_RESULT` is a small reusable structured result:

```js
{ source: 'input string', text: 'result string', status: 'pending', index: 0, error: '' }
```

`status` is `pending`, `complete` or `error` in scheduler outputs; the session
marks unresolved rows `canceled` on Cancel. A provisional result has no final
index. `index` identifies a scheduler-local final job, including identical source
strings submitted twice. Source/result/status/index must remain indivisible at
this asynchronous paired-view boundary: emitting independent source and result
strings would lose alignment when interim work is superseded or inference fails.
This optional diagnostic contract describes a text-processing result, without
ASR IDs, processor identity or model dependencies. It is never required by text
processors. Pending/errors are not emitted on successful TEXT outputs.

Separate output ports are independent deliveries, not an atomic pair. Text-only
consumers connect only `text`. The paired view connects only result ports and
uses their source data, including an explicit provisional translation source in
Live; its stream and language direction are independent of TranscriptView. The generic Pipeline adds no
coercion, synchronization, event bus, registry or envelope. The core's observer
callbacks remain diagnostic/lifecycle interfaces, not alternative text routes.

## Ordering, lifecycle and saved graphs

ASR suppresses duplicate/stale monotonic final IDs before emitting strings;
different IDs with equal strings are valid utterances. The scheduler assigns its
own job indices on TEXT receipt, coalesces provisional work, prioritizes FIFO
finals and suppresses stale interim completions. Final receipt clears its own
pending or displayed preview with an empty provisional TEXT and result update,
before inference; delayed finals therefore preserve newer independent previews.
It emits each successful final string once. Stop clears and discards interim
work and drains finals through consumers;
Cancel aborts the graph and ignores late replies. TTS splits long utterances only
inside its own branch; field fan-out receives the complete, verbatim string.

Version 4 extension graphs explicitly migrate versions 1–3. FinalText and
TranslatedFinalText disappear by bypassing each adapter and preserving every
outgoing route. Scheduler final inputs/outputs become `text`; TranslationView
edges become `provisionalResult`/`finalResult`. Invalid legacy routes fail with a
visible Reset and Save recovery path; stored graphs remain untouched on failure.
Required inputs, input cardinality, same contract identity, settings, format and
acyclicity remain validated. Optional interim/diagnostic ports do not have to be
connected. The concrete Live coordinator retains one source/ASR, one transcript
view and at most one scheduler/paired view, because those own its session state.

A direct flow needs no extraction nodes:

```text
SpeechToText.final ──→ Translation.text ──→ FocusedInputTextOutputNode.text
                  │                    └─→ TTS.text
                  └─→ Correction.text ──→ another TEXT consumer
Translation.finalResult ──→ TranslationView.final  (optional paired diagnostics)
```

See [runtime](pipeline-runtime.md), [graph](extension-graph.md) and
[Issue #91 validation](evidence/ports-91.md). Issue #91 requires no post-merge
verification: all acceptance criteria are verifiable before merge. Any desired
deployment verification belongs in a separate follow-up Issue and must not gate
this PR's merge or Issue #91's closure.
