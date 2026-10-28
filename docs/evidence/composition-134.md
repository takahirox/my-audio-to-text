# Producer-independent composition audit (#134)

Audited `extension/`, shared `web/` Nodes and playground pages, editor connection
selection, executable-path selection, storage/migration/recovery, model preparation,
fixtures, tests and current architecture/help text. Checked producer/type/output-name
comparisons, endpoint/topology scans, grouped delivery, startup extraction, hidden
mode activation and lifecycle shortcuts. No model, asset pin or download policy changed.
The short maintained rule is centralized in [port contracts](../port-contracts.md)
and linked from [review guidance](../review-guidelines.md).

## Confirmed violations and resolutions

“Before” line numbers refer to the node's upstream commit `88e52e5`; links point
to the resulting implementation.

| Finding / before | Classification and resolution |
| --- | --- |
| `extension/graph.js:171–187`: provisional required matching TextWindow outputs; commit required TextWindow and one named translator | **Confirmed violation, removed.** Current [edge checks](../../extension/graph.js#L131) validate port existence, shared identity, cardinality and duplicates; cycle/settings checks remain. Editor [candidate validation](../../extension/graph-editor.js#L194) uses those same rules. Both edge orders and incomplete drafts save/reload. |
| `extension/graph-runtime.js:125–126,163–168`; `extension/translation-scheduler.js:10,48–65`: neighbor-derived `windowed` mode and disabled provisional input | **Confirmed violation, removed.** [Translator construction](../../extension/graph-runtime.js#L160) has no graph-shape flag. [Scheduling](../../extension/translation-scheduler.js#L42) always accepts optional provisional TEXT, coalesces previews, suppresses stale results, bounds work and drains committed FIFO. Grouped committed input supersedes preview before any inference, including an empty preview. |
| `extension/graph.js:143–151`; `extension/graph-runtime.js:184–196`: Number.value/Text.value-only startup settings, synchronous `.value` extraction and discarded edges | **Confirmed violation, removed.** All saved edges use [ordinary delivery](../../extension/graph-runtime.js#L182). [ASR startup](../../web/transcription-nodes.js#L111) and [Whisper validation](../../web/whisper-node.js#L21) consume the first valid value before loading. Connected-but-inactive sources also wait. Missing values fail visibly at Stop or 30 seconds of buffered PCM; invalid/late values fail locally, without fallback. Edge presence tells the consumer to await configuration; producer identity never supplies a value. |
| `web/translation-commit-node.js:18–35`: matching source strings relied on graph pairing to establish identity | **Confirmed integrity gap exposed by generic wiring, fixed inside the Node.** [Commit validation](../../web/translation-commit-node.js#L19) checks atomic groups, exact source text, FIFO and immediate causal delivery. Equal independent events cannot commit. [Generic delivery context](../../web/pipeline.js#L93) supplies opaque identity/cause; the scheduler retains its received context per job. No public port, payload wrapper, registry or graph version was added. |
| `extension/session.js:128–134`: buffer/window neighbors determined branch-local versus session-wide failure; preload rejected all peers | **Confirmed violation, removed.** [Session reporting](../../extension/session.js#L126) treats every Node error consistently. [Generic startup](../../web/pipeline.js#L141) preserves independent viable paths, skips producers with no healthy destination, and disposes if no output path remains. Stop drains healthy Nodes and reports accumulated errors. Model-owned source/error fallback stays local. |
| `extension/session.js:211–222`: Cancel read accumulator state and called an immediately connected sink directly | **Confirmed violation, removed.** [Pipeline.cancel](../../web/pipeline.js#L215) invalidates pending work first; [TextAccumulator.cancel](../../web/text-nodes.js#L84) publishes its committed snapshot through normal ports. Stateless formatters, direct displays and generic sinks receive consistent cleanup. Canceled stateful processors do not accept new work. [Field output](../../extension/page-output-node.js#L12) now disposes on abort before cleanup can append another snapshot; model Nodes already own abort cleanup. Bare dispose still emits nothing. |
| Current help/docs and tests asserted these restrictions or direct-only Cancel restoration (`docs/windowed-translation.md:88`, `docs/pipeline-runtime.md:224`, `docs/whisper-node.md:29`, `tests/extension-graph.test.js:229`, `tests/windowed-translation.test.js:241`) | **Confirmed regression protection/documentation violation, replaced.** Current docs describe source freedom, consumer startup timing, causal commit semantics and ordinary cleanup. [Exhaustive composition tests](../../tests/primitive-composition.test.js#L14) check every current TEXT producer; [MV3 tests](../../tests/extension/primitive-composition.spec.js#L6) exercise actual editor controls and packaged delivery. Historical evidence is explicitly marked superseded. |

## Retained specialized behavior

| Reviewed locations | Classification / reason retained |
| --- | --- |
| `extension/graph.js:161,224,316,363`; `extension/graph-runtime.js:153`; migration fixtures and recovery tests | **Migration-only compatibility.** Old TranslationView bundles, removed metadata/adapters, Whisper's nonexistent provisional output and legacy display retention are historical interface conversions. Producer checks are explicitly confined to legacy validation/migration. Originals and recovery copies remain preserved; current graph version stays 10. |
| `extension/graph.js:187,393`; `extension/graph-editor.js:142,194`; `extension/graph-page.js:29` | **Justified structural/UI constraint.** Selection finds ready ancestors of sinks; incomplete drafts remain stored. Palette categories, labels, explicit ASR translation presets and recovery controls select/display known implementations; they do not gate manual compatible edges or activate runtime inference modes. |
| `extension/graph-runtime.js:28,66,70,77,148`; `extension/graph-model-preparation.js:17`; `extension/session.js:43`; target/page agents and caches | **Justified intrinsic lifecycle/resource/security constraints.** Concrete model factories, voices/languages, pinned cache readiness, GPU/WASM requirements, shared native tab capture, permissions, document targeting and model-owned failure handling remain. Source/consumer implementation selection is distinct from restricting who may connect. |
| `web/pipeline.js:77`; `web/text-nodes.js:32`; `web/translation-commit-node.js:14`; `web/text-window-node.js:4`; translation/correction/IfCondition/summary/TTS/ASR implementations | **Justified intrinsic data semantics.** Atomic groups cannot be assembled from independent emissions. Formatters keep independent latest values; batching, queue limits, model input bounds, candidate validation, utterance deduplication, audio layouts and configuration timing belong to their Nodes. Commit boundaries declare closure; with none pending, a causal grouped result is only a preview. A boundary and its result must represent the same delivered source event, irrespective of the producer's class or output name. |
| `web/nodes/`, `extension/live-text-regions.js:4`, recorder/target/model UIs, asset preparation/build scripts | **Justified intrinsic UI/model ownership; no additional wiring violation found.** Standalone playgrounds construct explicit examples. Renderer identity selects a region, not a producer. Specialized runtime, permission and checksum checks remain intact. |

## Validation

- `npm ci`: passed; pinned dependencies installed, no model/provider switch.
- `npm test`: **540 passed**, including v1–v10 migrations/recovery/defaults,
  exhaustive producer/edge-order matrices, direct ASR and alternate TEXT sources,
  custom NUMBER/TEXT startup producers, missing/invalid/late values, equal-event
  mismatch rejection, grouped preview/final precedence, overload, Stop and Cancel.
- `npm run build:extension`: passed after preparing all pinned runtime/model assets.
- Chromium + WebKit text contracts, text displays/windows, translation, TTS and
  correction suites: **114 passed**. Used a worktree-only server on port 8019
  because port 8000 was already occupied; production server configuration unchanged.
- Packaged MV3: **181 distinct executed tests passed across the full run and
  final targeted reruns**. The full default invocation initially reported 177
  passed, 16 skipped, and two old session-wide failure expectations failing.
  Those expectations were corrected to assert branch-local failure and explicit
  Cancel/retry. After the final rebuild, all **59 selected tests passed**, covering
  both corrected cases, two additional startup cases, native capture/concurrency,
  editor composition, Whisper/Zipformer, display migration/cleanup and batching.
  The full run also covered storage/recovery, model caches, summary, IfCondition,
  TTS, focused fields and security/permissions. No unresolved test failure remains.
- Real packaged TranslateGemma smoke: **passed**, Chrome 153 on Apple WebGPU,
  checksum-verified 3.112 GB model, then offline. Baseline 10 inferences; batches 6;
  revisable 7; deliberate visible previews 11; direct ASR preview plus two equal
  finals 3. All committed outputs preserve ordering/repeats; batched and revisable
  committed output agrees. No remote requests during inference, no request bodies,
  no leaked owned translation Workers. Full sanitized measurements and model
  outputs: [composition-134-model.json](composition-134-model.json). Recognition
  and capture in the direct-ASR case are controlled; TranslateGemma inference is real.

The default full invocation skipped 16 environment-gated smoke tests. The windowed
TranslateGemma test among them was run separately with `WINDOW_TRANSLATION_SMOKE=1`
and passed as recorded above. The other 15 opt-in native/model/GPU smoke tests
are not claimed as executed. No hardware limitation blocked the required
TranslateGemma check. No merge-only or deployment
verification is required; none is deferred to post-merge.
