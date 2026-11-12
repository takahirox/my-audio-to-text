# Windowed translation

TextWindow batches short committed TEXT fragments before sending them to any
text consumer, including the local OPUS-MT and TranslateGemma translators. It
requires no model weights. Batching does not provide conversation-wide context,
conversation memory, or guaranteed translation accuracy improvements.

## Committed translation

Connect these named ports:

```text
ASR.final → TextWindow.text
TextWindow.text → TranslateGemmaEnJa.text
TranslateGemmaEnJa.text → TextAccumulator.append
TextAccumulator.text → Display.input1
```

Any existing translator accepts TextWindow.text. To translate each ASR segment
without batching, connect ASR.final directly to Translator.text. To show only the
latest translation, connect Translator.text directly to Display.input1.
TextAccumulator is the explicit history processor; Display renders complete
snapshots without retaining history itself.

For bilingual formatting, connect grouped translator source/text/error directly
to TextFormatter inputs, then TextFormatter.text → TextAccumulator.append. A
failed translation emits source/error without text; a formatter can show that
source and error. A direct text-only display or accumulator receives nothing for
that failed job and retains its previous successful output. For continuous
ID-scoped bilingual ASR history, use the [portable keyed pair path](display-items.md):
KeyedTextCoalesce / KeyedTextPair / KeyedPairedTextAccumulator.

## TextWindow ports and batching

TextWindow has no threshold Settings and one output:

| Port | Contract | Default / rule |
| --- | --- | --- |
| text (input) | TEXT, required | Append exactly, preserving order and every code unit |
| maxChars (input) | NUMBER, optional | 600; safe integer ≥2, measured in UTF-16 code units; 2,000 and larger batches supported |
| maxWaitSeconds (input) | NUMBER, optional | 1.5; finite positive seconds, at most 2147483.647 (JavaScript timer range); decimals supported |
| text (output) | TEXT | Completed chunk, emitted at length, deadline or Stop only |

Connect ordinary Number.value sources to either threshold input, or leave them
unconnected to use defaults. A connected source which has never supplied a value
also uses the default. Each received threshold updates only that limit; omitted
siblings retain their latest values. Numeric strings, non-finite numbers,
non-integer character limits and out-of-range values fail visibly without coercion.
A grouped delivery validates all values before changing any state, then applies
thresholds before text. Threshold values are never appended to the text buffer.

The timer starts when nonempty text first enters an empty buffer. More text does
not reset it. A wait-limit update recomputes the deadline from that same arrival:
shortening an elapsed deadline flushes immediately; extending it moves the deadline
relative to the original arrival. Reducing maxChars emits all available full chunks
immediately. Every emitted portion is removed; an un-emitted remainder starts a new
window and deadline. A timer fires without another input; browser suspension or
JavaScript scheduling may delay it. This is not an inference-latency guarantee.

Text is concatenated exactly: no trimming, deduplication or inserted spaces.
Supply separators explicitly in source fragments when needed. Punctuation never
closes a window. At the character threshold, chunks obey the hard UTF-16 bound,
without splitting surrogate pairs inside the buffer; this can produce a chunk one
unit shorter than the bound. Long words may split. Empty strings are ignored;
whitespace-only text is retained. Unknown ports, non-TEXT text and individual text
inputs over **32,768** code units fail visibly before being accepted. Split larger
source events first. After processing, pending text is shorter than maxChars;
TextWindow retains no emitted history or background input FIFO. Consumers retain
their own limits: translators require chunks of at most **1,000** units, so choose
maxChars for the connected consumer. Larger batches are available for other text
consumers.

Stop cancels the timer, emits the pending tail exactly once, and lets the
translator drain before the sink closes. Repeated Stop cannot duplicate it.
Cancel/dispose cancels timers and discards pending source. Late callbacks emit
nothing. Each instance owns its buffer, timer and lifecycle.

## Optional provisional previews

Use one translator for both committed text and replaceable previews:

```text
ASR.final → TextWindow.text → Translator.text → TextAccumulator.append
TextAccumulator.text → Display.input1
ASR.provisional (or explicit TEXT snapshots) → Translator.provisional
Translator.provisionalText → PreviewDisplay.input1
```

Translator means OpusMtEnJa, OpusMtJaEn, TranslateGemmaEnJa or TranslateGemmaJaEn.
PreviewDisplay is an ordinary separate Display instance. Any compatible TEXT
producer can supply provisional snapshots independently of the committed source
and edge order. TextWindow emits only completed batches and creates no previews.
Standalone web translator Nodes retain their existing text-only behavior.

The extension translators expose two independent atomic TEXT output families:
**source/text/error** for committed input and
**provisionalSource/provisionalText/provisionalError** for previews. A failed group
omits its family's translated text; connected generic formatters clear that
omitted sibling without clearing the other family's inputs. Empty/whitespace
input succeeds with empty translated text and its original source, without
inference. Errors also reach the translator diagnostics.

Each translator accepts one running inference, one latest pending preview, and
a bounded FIFO of committed inputs. New snapshots replace pending previews.
Committed input invalidates prior previews and takes priority over pending
previews. An obsolete inference may finish, but its result is suppressed.
Committed work is never coalesced, even for repeated equal phrases. Final
inference runs again even if a matching preview succeeded.

| Event | Behavior |
| --- | --- |
| Latest preview succeeds | The provisional family replaces only the explicit preview branch. |
| Committed input arrives | All three provisional TEXT ports emit empty strings to clear previews immediately, even while stale inference is running. Committed translation enters the FIFO. |
| Committed translation succeeds | The committed source/text/error group emits; direct text consumers receive the translation once. |
| Preview fails | The provisional source/error group emits without provisionalText. A grouped formatter clears omitted text; a text-only preview display retains its snapshot until replacement or an explicit clear. |
| Committed translation fails | The committed source/error group emits without text. Existing successful history remains. Wire source/error to a formatter if failed-source visibility is needed. |
| Stop | TextWindow flushes its tail; the translator clears previews and drains committed work before downstream consumers close. |
| Cancel | Pending work is discarded, Workers terminate, and cleanup clears explicit previews. Accumulated committed text remains; late replies are ignored. Bare dispose emits nothing and retains the last display snapshot. |

## Bounds, errors and independent branches

Every translator has a FIFO of at most **32 waiting inputs / 32,768 waiting code
units**, plus one active request. Its one pending preview accepts at most **1,000**
units. Sustained input faster than inference eventually reports a visible error
and fails that path; start a fresh session with a slower source. It does not
silently skip or truncate text and claim a complete transcript. Keep an independent
original-ASR display when source retention across overload is needed.

Node failures appear in Live while independent branches continue. Model failures
produce grouped source/error for committed requests. Stop reports failed drains;
Cancel remains available. Each branch owns its instances, queues and Worker.
Ending one source drains its ancestors and downstream path while independent
branches continue. TextAccumulator intentionally retains history; TextWindow and
the scheduler remove completed source from their processing buffers.

Auto Save persists the graph before preparing only referenced model weights.
TextWindow adds none. TranslateGemma retains its pinned **3.112 GB q4** weights
and WebGPU requirement (allow **7 GB storage** and several GB free RAM/GPU memory
per active translator). See [model terms and preparation](translation-nodes.md#translategemma-in-the-extension-124).

## Validation

[`tests/fixtures/windowed-translation.js`](../tests/fixtures/windowed-translation.js)
compares direct per-segment translation and completed batching. Its fixed
transcript repeats phrases, splits two meanings of “bank” across fragments, and
ends with an unpunctuated Stop tail. Number inputs set maxChars 160 and
maxWaitSeconds 0.8. Separate tests cover explicit ASR previews, coalescing,
failures, Unicode splits, overload, long sessions, Stop/Cancel and independent
branch drain order. Controlled inference establishes routing and lifecycle,
not translation quality.

```sh
npm run setup:extension
npm test
npx playwright test tests/browser/text-window.spec.js tests/browser/text-contracts.spec.js tests/browser/display-items.spec.js tests/browser/translation-ports.spec.js
npm run test:extension -- tests/extension/windowed-translation.spec.js tests/extension/translation-ports.spec.js tests/extension/primitive-composition.spec.js
WINDOW_TRANSLATION_SMOKE=1 npx playwright test --config playwright.extension.config.js tests/extension/windowed-translation-smoke.spec.js
```

The opt-in real-model test uses the packaged MV3 graph, Auto Save preparation and real
TranslateGemma Workers offline after preparation. Direct, batched and direct-ASR
preview paths each use a fresh Worker. Fixed batching uses a 30-second wait limit
for comparable length/Stop splits; deterministic checks exercise deadlines.
Its JSON attachment records model results, inputs, display events, inference
counts, request timings and Stop/drain time. Historical experiment measurements
remain in [the #128 evidence record](evidence/translation-128.md).

## Saved graphs

Unsupported Nodes, versions and ports require Reset or Import of a current graph
and automatic persistence of a repaired graph copy. Reading never rewrites stored JSON. The original JSON
remains inspectable through Graph actions → Saved JSON. See
[Graph Editor recovery](extension-graph.md).
