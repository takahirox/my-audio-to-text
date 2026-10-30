# Windowed translation experiment (#128)

This experiment composes existing local translators with two text processors.
Stage 1 batches short committed ASR fragments. Stage 2 optionally retranslates
only the current bounded, uncommitted source window. It does not provide
conversation-wide context, conversation memory, or guaranteed translation
accuracy improvements. Both processors are in Graph Editor's Processors palette.
They require no model weights. Graph v14 uses append-only committed routing and a separate preview display. TextAccumulator holds committed history; TextToDOM converts TEXT for DOM-only LiveTextDisplay sinks.

## Stage 1: batching without retranslation

Connect these named ports:

```text
ASR.final → TextWindow.text
TextWindow.text → TranslateGemmaEnJa.text
TranslateGemmaEnJa.text → TextAccumulator.append
TextAccumulator.text → TextToDOM.text → dom → LiveTextDisplay.dom
```

Any existing translator accepts this output; there is no model-specific
formatter or preset. Optional bilingual formatting still uses grouped
translator source/text/error → TextFormatter inputs → TextAccumulator.append. Other ASR
final consumers can continue independently, including an original transcript
display. TextWindow expects committed fragments; ASR provisional snapshots instead route
to translator.provisional. This is a value-semantics distinction: TextWindow inputs
are already committed source segments.

Select TextWindow's heading to edit its three settings:

| Setting | Default | Rule |
| --- | --- | --- |
| maxChars | 600 | Integer 2–1000, measured in UTF-16 code units, like the translator's input limit |
| maxWaitMs | 1500 | Integer 1–30000 ms from the first pending fragment, without extending the deadline on further arrivals |
| sentenceBoundary | on | Close conservative punctuation boundaries; off uses only length, deadline and Stop |

The timer flushes even when no subsequent input arrives. JavaScript scheduling
or a suspended browser may delay a timer; this is not an inference-latency
guarantee. New leftovers get a new deadline. Sentence detection accepts `. ! ?
。 ！ ？` with an optional closing quote/bracket followed by whitespace or end
of input. Dots following digits, initials, dotted abbreviations and a short
list of common English titles/abbreviations do not close the window. This is a
heuristic, not a linguistic sentence tokenizer; ASR need not provide punctuation.
Short unpunctuated speech still flushes by deadline.

Inputs are never trimmed or deduplicated. Adjacent segments inside an open
window receive one separating space unless either side already has whitespace.
Original code units and explicit whitespace remain in order. Closed windows
are independent items, without an added cross-window separator. At the length
cap the last available whitespace boundary is preferred and the leftover stays
pending. A word longer than the cap may split mid-word; surrogate pairs within an input stay intact.
Every leftover is processed. Empty strings are ignored; whitespace-only inputs
are retained (existing translators return successful empty TEXT without model
inference). Non-TEXT, unknown ports and individual inputs over **32,768** code
units fail visibly rather than being silently truncated. Split oversized source
events before sending them. Pending TextWindow storage never exceeds maxChars;
it has no background input FIFO.

Stop cancels the timer, emits the pending tail exactly once, and lets the
translator drain before the sink closes. Repeated Stop cannot duplicate it.
Cancel/dispose cancels timers and discards pending source. Late callbacks emit
nothing. Each instance owns its buffer, timer and lifecycle.

## Stage 2: bounded retranslation with immutable commits

Use one translator for both committed windows and replaceable previews:

```text
ASR.final → TextWindow.text
TextWindow.text ───────────→ Translator.text
               └──────────→ TranslationCommit.boundary
TextWindow.provisional ────→ Translator.provisional
Translator.source ────────→ TranslationCommit.source
Translator.text ──────────→ TranslationCommit.text
Translator.error ─────────→ TranslationCommit.error
Translator.provisionalText ──→ PreviewTextToDOM.text → dom → PreviewDisplay.dom
TranslationCommit.final ──────→ TextAccumulator.append
TextAccumulator.text ────────→ TextToDOM.text → dom → LiveTextDisplay.dom
```

Translator means any of OpusMtEnJa, OpusMtJaEn, TranslateGemmaEnJa or
TranslateGemmaJaEn. PreviewTextToDOM and PreviewDisplay are ordinary TextToDOM and
LiveTextDisplay instances. All four translators expose the same explicit output
families; standalone web translator Nodes retain their existing text-only behavior.
TranslationCommit is optional for routing: committed translator.text can connect
directly to append, fields or TTS. Retain the forward boundary edge when causal
window-commit verification and visible failed-source fallback are needed without a
feedback cycle, payload wrapper, public request IDs or status ports. Graph validation
accepts any compatible TEXT producer on any input, in either connection order, including
direct ASR.provisional → Translator.provisional and ASR.final → Translator.text.
TextWindow is one batching option. No source type or neighboring Node enables a feature
mode.

TranslationCommit treats `boundary` as a declaration of a closed source event. Fan out
that same event to a processor's text input and boundary; equal text from independent
emissions is insufficient. The processor must return atomic grouped source/text/error
using its received context (retain it with asynchronous work). The commit Node checks
the result's causal delivery against the oldest boundary, as well as exact source text.
It never joins split groups or unrelated equal strings. A mismatch fails visibly without
appending. With no pending boundary, a result fails visibly; previews bypass
TranslationCommit entirely. Its retained provisional output carries only empty
boundary/final clears for existing compositions, never preview translations. Unresolved
boundaries fail on Stop. Arbitrary processors may satisfy these data semantics; an
intermediary which emits a fresh result without preserving the immediate source delivery
cannot fabricate correlation. No public metadata ports, producer registry, payload
wrappers or graph pairing checks are added.

Every translator accepts one running inference, one latest pending provisional
snapshot, and a bounded FIFO of closed windows. New
snapshots replace pending previews. Closed text invalidates prior previews and
always takes priority over pending previews. A running obsolete inference may
finish, but its result is suppressed. Closed work is never coalesced. Final
inference intentionally runs again even if a matching preview succeeded: there
is no speculative translated-prefix stabilization or implicit cached commit.
Stage 1 creates no preview inference.

The two atomic TEXT output families are **source/text/error** for committed input and
**provisionalSource/provisionalText/provisionalError** for preview input. A failed group
omits its family's translated text; connected generic formatters clear that omitted
sibling, without clearing the other family's inputs. Empty/whitespace input succeeds
with empty translated text and its original source, without inference. Errors also reach
existing translator diagnostics.

Route committed text directly to append-only destinations. Route provisionalText to a
separate TextToDOM → LiveTextDisplay replacement branch; its explicit empty-string
events clear previews on final acceptance, Stop and Cancel. This needs no
context.provisional inspection and no accumulator preview state. Preview-only
TextFormatter formatting must stay on that separate branch; never append it to committed
history. PairedTextToDOM formats provisional and committed atomic groups identically. For
paired previews, wire provisionalSource/provisionalText to input1/input2 on a
separate PairedTextToDOM → LiveTextDisplay replacement branch. Empty cleanup
groups render blank cells; the producer owns when cleanup occurs. Keep source/text
on a separate formatter branch for optional DOMAccumulator history. For a combined
display, use DOMCombiner with committed history as first and preview DOM as second.

| Event | Output and order |
| --- | --- |
| Source grows while open | Translate the latest snapshot when available; no final. The most recent successful preview remains until replaced or the source closes. Superseded in-flight results emit nothing. |
| Latest open translation succeeds | Translator emits its grouped provisional family; provisionalText replaces only the explicit preview display. |
| Source closes by punctuation, cap, deadline or Stop | Boundary arrives before its async final result. Translator emits all three provisional ports as `''` immediately to clear the obsolete preview, even while stale inference is running. Commit queues the source boundary exactly once. |
| Closed translation succeeds | Match the oldest boundary by causal delivery and source text in FIFO order; Commit emits final translation and error `''` (with its legacy empty clear). The committed history appends once; previews remain on their separate branch. |
| Open translation fails | Emit provisionalSource and provisionalError without provisionalText; no committed output or final item. A grouped preview formatter clears omitted translated text. A direct provisionalText-only display keeps its previous snapshot until replacement or an explicit clear. Existing translator model failures remain terminal for that translator instance. |
| Closed translation fails | Emit grouped provisional `''`, final `[Translation failed: MESSAGE]\nSOURCE`, error MESSAGE. This visibly retains source instead of inventing a translation; prior committed items remain immutable. |
| Stop | TextWindow flushes tail; translator suppresses previews and drains closed work; commit verifies all boundaries resolved, and the explicit preview family clears its display. |
| Cancel | Pipeline invalidates emissions first; buffers, pending work and Workers are disposed. Previously committed accumulator text remains, while a cleanup emission clears the preview display and late replies are discarded. Bare dispose emits nothing and retains the last display snapshot. |

The scheduler does not emit previews ahead of queued closed results. A closed
window is the sole commit rule; similarity between Japanese strings is never
used. Already committed source is removed from the processing buffers and never
included in subsequent translation requests.

## Bounds, errors and independent branches

Every translator, regardless of source and preview use, has a bounded
closed-work FIFO: at most **32 waiting windows / 32,768 waiting code units** plus
one active request. Stage 2 additionally has one pending preview of at most
1000 units. TranslationCommit admits at most **32 unresolved boundaries /
32,768 units**, counting the active closed window. This is intentionally a
conservative overload cap, not unlimited catch-up. Its cap may be reached before
the scheduler's cap. Sustained inference slower than speech eventually reports
a visible error and fails that path; stop and start again with a slower source.
It does not silently skip or truncate text and pretend the transcript completed.
Unfinished work on a failed path is not claimed as a successful transcript.
Keep an independent original-ASR display when source retention across overload
is needed. These bounds and failure decisions belong to the consumers.

Every Node failure is reported in Live without canceling independent capture
or outputs; this policy does not depend on neighbors. Model failures
still produce grouped source/error per closed request. Stop reports any failed
drain; Cancel remains available. A missing or mismatched result fails visibly;
it cannot commit an unrelated source. Each branch uses its own instances,
queues, correlation and Worker. Ending one source drains its ancestors and
downstream path in topological order while independent branches continue.
Display history alone intentionally grows; these processors retain no committed
source/translation history.

Save still persists the graph before preparing only referenced model weights.
The text processors add none. TranslateGemma keeps its pinned **3.112 GB q4**
weights and WebGPU requirement (allow **7 GB storage** and several GB free
RAM/GPU memory per active translator); there is no recording-time download,
cloud inference or automatic model fallback. See [model terms and preparation
details](translation-nodes.md#translategemma-in-the-extension-124).

## Reproduction and evidence

Pinned inputs and three graph descriptions are in
[`tests/fixtures/windowed-translation.js`](../tests/fixtures/windowed-translation.js).
They split meeting/time and two different meanings of “bank” across ASR events,
repeat “Please wait.” as separate utterances, and end with unpunctuated speech.
The graphs use maxChars 160, maxWaitMs 800 and sentence boundaries on. They
compare the current per-segment path, Stage 1 and Stage 2 with the same text.

```sh
npm ci
npm run setup:extension
npm test
npx playwright test tests/browser/text-window.spec.js tests/browser/text-contracts.spec.js tests/browser/text-display.spec.js tests/browser/translation.spec.js
npm run test:extension -- tests/extension/windowed-translation.spec.js
WINDOW_TRANSLATION_SMOKE=1 npx playwright test --config playwright.extension.config.js tests/extension/windowed-translation-smoke.spec.js
```

The opt-in real-model check uses the actual packaged MV3 graph, unmodified
public weight URLs, Save preparation and real TranslateGemma Workers. Each path
starts a fresh Worker and runs offline after preparation, with fixtures 150 ms
apart. Its JSON attachment records inputs, model results, source correlation,
display events, inference count, request timings, load time and Stop/drain time.
The packaged deterministic suite separately exercises ASR.final composition
with controlled recognition and inference. It is not real speech-recognition
quality evidence. Unit tests cover slow inference, coalescing, repeat strings,
failures, deadline-only flush, Unicode splits, overflow, long sessions,
independent branch drain order, Cancel and saved-graph compatibility. Mock
translations demonstrate lifecycle and ordering only.

Measured results and limitations are recorded in
[`docs/evidence/translation-128.md`](evidence/translation-128.md). No required
check introduced by this experiment depends on a post-merge deployment.

Live displays accept only `dom: DOM`. Route complete TEXT snapshots through `TextToDOM.text → dom → LiveTextDisplay.dom`. For history, route committed text to TextAccumulator.append. Keep previews on a separate replacement branch. For paired translation, explicitly wire `translator.source → PairedTextToDOM.input1` and `translator.text → PairedTextToDOM.input2`, then dom to the display for the latest pair only. An omitted second value leaves a blank right cell; specific translation errors stay in translation diagnostics. For optional comparison history, insert DOMAccumulator between formatter and display. Graph v12 requires review and Save for old paired ports: source/text become input1/input2, and any former formatter error route is explicitly removed in the draft. Saved TEXT display graphs also require reviewed conversion; exact originals remain recoverable. See [DOM contracts and recovery](extension-graph.md#dom-formatters-and-display-ownership).

## Saved graph review (#163)

Graph v14 audits all four shared-scheduler translators. Any older graph with a
provisional translator input connected or a TranslationCommit Node requires an explicit
review, including inactive drafts. Loading/executing the saved graph is blocked; the
repair draft retains every route, Node and setting, while warning that source/text/error
now carry committed results only. Reconnect deliberate previews to
provisionalSource/provisionalText/provisionalError and include their empty clearing
route. Old TranslationCommit compositions need a separate preview route. No preview
branch is guessed or auto-committed.

The original JSON remains untouched until Save, then is backed up byte-for-byte under
processing-graph-before-v14 (numbered on collisions). Older copies remain available
through Graph actions → Recovery, Copy JSON and Download JSON. V13 graphs without
provisional translator input or TranslationCommit upgrade without changing their routes.
Earlier display/paired-port review requirements still apply. This change does not alter
TextAccumulator or add a preview manager; it is compatible with #162's append-only
accumulator contract.
