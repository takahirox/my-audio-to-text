# TextSlidingWindow

`TextSlidingWindow` is a generic processor that retains recent text and emits
the entire retained snapshot after **every text event**. Emission keeps the
history. It has no Settings, timers, provisional output, or model dependencies.

| Direction | Port | Contract | Behavior |
| --- | --- | --- | --- |
| Input | `text` | TEXT, required | Append the fragment exactly, then emit the retained window |
| Input | `maxChars` | NUMBER, optional | Positive safe integer; default 1000 UTF-16 code units |
| Output | `text` | TEXT | Complete current window, at most `maxChars` code units |

Fragments concatenate in arrival order without inserted spaces or newlines.
Duplicates append again. Empty text appends nothing but still emits a snapshot;
whitespace is retained normally. Supply separators in the input when needed.

On overflow, remove oldest whole sentences until the newest suffix fits.
If the newest sentence alone exceeds the limit, remove older sentences and
try whole words within it. Browser-native `Intl.Segmenter` detects sentence and
word boundaries for English, Japanese and other supported text; this is a
heuristic, so exact boundaries can vary with the browser's Unicode data.
Without `Intl.Segmenter`, punctuation and whitespace provide conservative
sentence/word boundaries; Japanese without punctuation then uses suffix clipping.

If the newest word, URL or other unsplittable text is still too large, keep the
longest suffix within the limit that starts at a Unicode code-point boundary.
A cut through a surrogate pair moves forward past that pair. Thus a one-unit
limit with a trailing emoji can produce an empty snapshot. This preserves code
points in well-formed input; grapheme clusters such as combining marks or joined
emoji can still split. Retained storage never exceeds the active limit.

`maxChars` updates trim existing history immediately without emitting or appending
text. Increasing the limit does not recover evicted history. Non-numbers, zero,
negative, fractional, nonfinite and unsafe integer values fail explicitly.
If a producer delivers `text` and `maxChars` together, apply the limit first,
regardless of the group's port order. Independent inputs follow delivery order.
Start resets history and the default limit, with no output. Stop and Cancel
discard history, reject late input, and emit nothing.

Add **Text sliding window** from Graph Editor → Add Node → Processors. For example,
connect any TEXT producer to `text`, optionally connect `Number.value` to
`maxChars`, and route `text` to an ordinary TEXT consumer. Use
`TextToDOM → LiveTextDisplay` to display the latest snapshot. The node can also
supply `TranslateGemma.context`; it has no translation-specific behavior or
automatic wiring. Saved graphs retain ports and connections, while runtime
history is session-local. Existing `TextWindow` batching behavior is unchanged.

Validation:

```sh
node --test tests/text-sliding-window.test.js
npx playwright test tests/browser/text-sliding-window.spec.js
```
