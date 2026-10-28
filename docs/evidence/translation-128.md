# Windowed and revisable translation — Issue #128

Historical evidence; producer restrictions and cancellation/startup behavior are superseded by the [Issue #134 audit](composition-134.md).

Validated locally on 2026-10-20. Implementation and evidence are in the assigned
worktree; no push, PR, merge or Issue comment was performed.

## Implemented behavior

Both stages are implemented. [TextWindow](../windowed-translation.md) has three
settings, a real deadline timer, bounded source storage, whitespace-aware length
splitting and conservative punctuation boundaries. Plain text batches work
independently of retranslation. Stage 2 adds an optional translator provisional
input plus a forward boundary edge to TranslationCommit. The scheduler retains
one latest pending preview and suppresses superseded running results while
preserving a bounded FIFO of closed windows. Only explicit closed source
windows commit. No Japanese prefix matching or committed-history retranslation
is performed.

The existing translators' grouped source/text/error outputs correlate results;
no new structured payload, public request metadata, framework or generic
Pipeline change is needed. The optional provisional input is restricted to the
same TextWindow feeding the translator's text input. Direct grouped result
wiring and matching boundaries are checked before execution. Final errors retain
source visibly. New path failures report in Live while independent paths keep
running. Defaults and graph version 9/migrations are unchanged; the existing
text-only translator, TextFormatter and LiveTextDisplay behavior is preserved.
Save still precedes preparation and the new processors add no model weights.

## Automated checks

| Check | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm run build:extension` | Passed with pinned local baseline speech, translation and TTS runtimes |
| `npm test` | 429 passed, zero skipped |
| Targeted Chromium/WebKit text display, TEXT contracts, translation and TextWindow suite | 44 passed |
| Full browser suite | Final run: 238 passed, 18 opt-in skips; zero failures. Initial run had one WebKit timing failure; tab-audio/TextWindow rerun: 52 passed. |
| MV3 graph, concurrent graph, interactions, model preparation, Live text, both translation backends and new windowed graph suites | 93 passed |
| Final rebuilt-package windowed/Gemma/Live suites | 24 passed |
| Full MV3 suite | 170 passed, 14 opt-in skips, one initial selected-media amplitude failure; isolated rerun passed without code changes |
| Real packaged TranslateGemma experiment | Passed, all four paths/runs, no hardware skip or translation inference substitute |

The new unit regressions exercise punctuation across ASR segments, exact source
retention, equal independent phrases, whitespace, oversized/invalid/empty input,
surrogate pairs, partial leftovers, timer-only flush, non-extending deadlines,
Stop exactly once and Cancel clearing timers. They cover 500 growing snapshots
behind slow inference with one pending preview, large bounded closed work,
32-window overload, 100 successive commits without processing-history growth,
failures with source fallback, grouped versus independent deliveries, malformed
correlation, duplicate/late replies, Cancel during Stop, clearing a completed
preview, and independent branch drain in both graph insertion orders. A Live
session regression confirms a buffer failure leaves peer delivery and previous
commits intact. Existing migration/default/cache/Worker regressions also pass.

Packaged deterministic tests use the production ASR final emitter, module
Workers, graph builder, scheduler, timers and display, with recognition/capture
and translation inference controlled. They verify ASR.final composition,
repeat runs, cleanup, palette/inspector editing, validation, Save/reload and no
preparation for the two text-only Nodes. These tests establish lifecycle and
source ordering, not semantic translation quality.

The initial full browser failure was in the existing WebKit tab-picker switch
test's wait for AudioContext closure, unrelated to text/translation code. Its
entire file and the updated TextWindow test passed on rerun without an audio
code change. No failure or skip is counted as a real inference success.

The full MV3 run also observed a selected-media tone amplitude of **0.00727**
against its existing **>0.03** threshold. That test uses the original audio-only
graph, with no TextWindow, TranslationCommit or translation path. The unchanged
test passed in isolation (`tests/extension/targets.spec.js --grep 'selected media
discovers'`, one passed). No capture, resampling or amplitude assertion was
changed. The initial full-suite failure is retained here rather than presented
as an uninterrupted full-suite pass.

## Real model and reproducible setup

[Full final experiment JSON](translation-128-real.json) contains source events,
inference requests/results and timings, grouped emissions, every display
snapshot, preparation/network observations and hardware information.

Host: Chromium **153.0.8010.12**, macOS, hardware WebGPU **Apple Metal 3**,
cross-origin isolated. TranslateGemma 4B uses the unchanged pinned
`onnx-community/translategemma-text-4b-it-ONNX` revision
`f7874a1ac60758872a4f78aac0df95b17b776994`, **q4**, eight files totaling
**3,111,911,678 bytes**. Allow **7 GB free storage** and several GB free RAM/GPU
memory per translator; a compatible Worker WebGPU adapter is required. Google
Gemma's terms and policy still apply, as documented in the model notices.

Reproduce with `npm run setup:extension`, then
`WINDOW_TRANSLATION_SMOKE=1 npx playwright test --config playwright.extension.config.js tests/extension/windowed-translation-smoke.spec.js`.
The unmodified packaged extension is loaded using Chrome's extension debugging
API. Save prepares the real pinned public HTTPS assets and verifies their
checksums. No mirror, runtime replacement, model substitute or GPU-enabling/CSP
relaxation flag is used. Each run starts a new production Worker. Inference runs
offline after Save, and makes zero external requests. The test records GET-only
asset requests with no request body; signed query strings are omitted.

The real input source is Text plus controlled TEXT events so the English
transcript remains deterministic. ASR.final wiring is exercised separately in
the packaged deterministic suite. This is an end-to-end real translator graph
experiment, not a microphone/ASR quality benchmark or a new ASR backend.

## Observed comparison

The [pinned fixture](../../tests/fixtures/windowed-translation.js) has ten
segments. The equal-cadence experiment sends them 150 ms apart, using a
160-character / 800 ms window with sentence boundaries on. The two repeated
“Please wait.” inputs remain two items. The six windowed source batches cover
every input in order with documented inter-fragment spaces; none is dropped or
repeated. Baseline uses the existing per-segment path. Its Text source's initial
empty value creates the existing empty display item without model inference;
it is excluded from the ten source/translation counts.

Final experiment start: **2026-10-20T08:57:25.556Z**. Times below are rounded
milliseconds from the captured browser performance clock.

| Path | Inferences | Committed nonempty items | Model ready | Ready → fully drained | First commit after first input | Last commit after last input | Stop drain |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Per-segment baseline | 10 | 10 | 5714 | 3000 | 817 | 1641 | 1490 |
| Stage 1 | 6 | 6 | 5187 | 2008 | 601 | 648 | 497 |
| Stage 2, same cadence | 7 | 6 | 5281 | 2128 | 737 | 770 | 618 |
| Stage 2, deliberate preview pauses | 11 | 6 | 5936 | 4430 | 1214 | 846 | 332 |

Mean per-request inference durations were approximately **300 / 309 / 304 /
330 ms** respectively. Mean final delivery latency measured from the last
contributing input event was **1206 / 572 / 693 / 442 ms**. These are one-device,
one-transcript observations, not statistically controlled performance results.
Kernel/driver caches and initialization differ despite fresh Workers, and
concurrent local checks can affect wall times. Batching adds waiting time;
fewer inferences reduced backlog on this fixture. It does not guarantee lower
latency for general speech.

At the fast cadence, Stage 2's one running draft was superseded before it
completed, so no provisional translation became visible. That is intentional
suppression, not lost final source. To verify actual real-model previews, the
fourth run sets maxWaitMs to **30000**, pauses after each unpunctuated input until
its preview is visible, and otherwise uses the same transcript. Its arrival
schedule is therefore deliberately different and not a same-cadence speed
comparison. All actual input timestamps are recorded. Five previews became
visible, followed by six immutable commits. The final two open-window previews
changed from `終わらせる必要があります。` to
`このプロジェクトを金曜日までに完了させる必要があります。` before Stop
committed the full window once. The test checks every display event retains
the preceding committed item prefix. Final translations in all three windowed
runs were identical.

Selected observed outputs:

| Source | Baseline fragments | Windowed final |
| --- | --- | --- |
| The meeting / starts at ten. | `会議` / `10時からです。` | `会議は10時から始まります。` |
| Please wait. / Please wait. | `お待ちください。` / `お待ちください。` | Two distinct `お待ちください。` items |
| I went to the bank / to deposit money. | `銀行に行きました。` / `お金を入金する。` | `お金を入金するために銀行に行きました。` |
| Later I sat on the bank / of the river. | `その後、私は河岸に座りました。` / `川の。` | `その後、私は川のほとりに座りました。` |
| We need to finish / this project by Friday | `終わらせる必要があります。` / `このプロジェクトを金曜日までに` | `このプロジェクトを金曜日までに完了させる必要があります。` |

These examples show more complete sentence presentation for these chosen
fixtures, including the deadline and both local bank contexts. They do not
establish a general accuracy improvement. The river sense was already inferred
in the first baseline fragment; this is not evidence of conversation memory.
Assertions and source counts alone are not semantic evaluation. No translation
quality claim is made from mock results, nonempty model output, or character
counts.

## Limits and remaining checks

Deadlines and hard length boundaries may still split linguistic units.
TranslateGemma's existing 1000-unit input / 256-token generation limits remain;
model output may omit, mistranslate or rephrase content. No semantic correctness
guarantee is added. Repeated equal source windows are preserved as separate
events, while closed material is never sent as context for a later window.
Preview work can add cost: the deliberate pause run made more inferences than
the per-segment baseline. Sustained overload is a visible branch failure, not
an unlimited queue or a falsely complete transcript. An independent original
ASR display retains source if an experimental path fails.

Only the supported Apple GPU was exercised for real inference. Other GPUs and
low-memory devices are not certified. Real OPUS-MT, live audio recognition,
focused-field insertion and TTS were not rerun with real models for this Issue;
their applicable deterministic compatibility tests were run. Other opt-in real
model/browser benchmarks remain skipped by default and are not required by this
bounded text experiment. No required post-merge verification is pending.
