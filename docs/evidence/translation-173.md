# Optional TranslateGemma context (#173)

Both existing TranslateGemma graph Nodes now expose optional `context: TEXT`.
No settings, model, data type or graph version were added. Ordinary v14 graphs
round-trip unchanged; explicit context edges round-trip and render in the editor.
OPUS-MT has no context input and keeps its existing model call and inference
settings. The small shared transport adapter forwards request data as an extra
argument; OPUS ignores that argument.

Context-only input validates/replaces the latest session context without
inference or preview revision changes. Each accepted committed/provisional job
captures that string, including during preparation/loading and while queued.
Grouped deliveries apply context before selecting the target. The internal
TranslateGemma adapter reads the active job snapshot rather than mutable latest
state. FIFO priority, one running inference, latest pending preview, independent
output families, stale reply suppression, Stop/drain and Cancel remain intact.
Stop clears context after draining accepted snapshots; Cancel/dispose clear it
immediately. A new runtime starts empty.

Absent and explicit empty context retain the exact existing structured message
and `translate(messages, { max_new_tokens: 256, do_sample: false })` call. The
nonempty path builds one fixed experimental prompt with Gemma BOS/user/end/model
turn delimiters and JSON-quoted data. Escaping `<` prevents untrusted data from
introducing tokenizer control tokens or extra chat turns. Instructions ask for
only the target translation, using context solely for disambiguation. Raw-string
text generation disables added special tokens, full-prompt output and truncation.
There is no prompt editor, alternate model, truncation or retry with other text.
Limits are 1,000 UTF-16 code units per target, 4,000 per context, 3,840 prompt
tokens plus 256 output tokens. Over-budget input reports explicit errors.

The pinned upstream [chat template](https://huggingface.co/onnx-community/translategemma-text-4b-it-ONNX/blob/f7874a1ac60758872a4f78aac0df95b17b776994/chat_template.jinja)
was checked for turn delimiters; the repository's pinned Transformers.js
4.0.0-next.3 source was checked for `tokenizer_encode_kwargs`,
`add_special_tokens` and `return_full_text` handling. No runtime/model pins or
integrity manifests changed.

Validation on 2026-10-31:

- `npm test`: **771 passed**, no skips. New tests execute the production Worker
  and shared protocol with only the model runtime replaced; they assert the
  exact default call, nonempty/reset path, token boundary, escaped untrusted data,
  output extraction, no fallback, errors and subsequent independent requests.
  Both-direction scheduling tests cover context-only input, grouped edge order,
  preparation/load queues, committed FIFO, in-flight/pending preview snapshots,
  stale suppression, empty clearing, context bounds, Stop, Cancel during
  prepare/load/inference and fresh sessions. Persistence tests cover unchanged
  graphs and explicit context connections. Existing OPUS checks also pass.
- `npx playwright test --config playwright.extension.config.js tests/extension/translategemma.spec.js tests/extension/translation-ports.spec.js`:
  **20 passed**. Actual module Workers, production graph builder/scheduler,
  offline verified-cache plumbing, editor context ports, explicit connection
  Save/reload, official/context/reset path and one owned Worker/release execute;
  inference/model bytes are deterministic fixtures.
- `ASR_BASE_URL=http://127.0.0.1:8000 TRANSLATION_CHANNEL=chromium npx playwright test tests/browser/translation.spec.js tests/browser/translation-ports.spec.js --project=chromium --workers=2`:
  **26 passed** against the local test server. Standalone translation behavior,
  OPUS token errors, Worker capability failures, output separation and lifecycle
  checks pass with controlled model inference.
- `npm run prepare:translation-assets`: staged the unchanged pinned runtime
  (27,771,302 bytes). A separate real-tokenizer browser check verified the custom
  prompt has one BOS and the expected turn delimiters with untrusted control
  tokens escaped in both directions, with control IDs `[2, 105, 106, 105]` (BOS, user-turn start, turn end,
  model-turn start). This loads real tokenizer assets, not model weights.
- Worker WebGPU probe in Chromium **153.0.8010.12**: GPU/adapter available,
  vendor `apple`, architecture `metal-3`.

Production packaging: `npm run build:extension` stops with “Missing local
models. Run npm run prepare:assets first.” Production ASR/other optional assets
are absent. MV3 tests used a source-layout package under ignored
`dist/chrome-extension`, marked `FIXTURE-ONLY.txt`, containing extension sources
and the builder's exact shared-source list. It is not a verified production
build. The first MV3 attempt lacked Playwright's matching Chromium; after
installing it, final checks above passed. Two initial new assertions were fixed
in test code (TEXT is a contract object; the Worker test observer needed to
record the new context field).

Real inference uses the production Worker and unchanged pinned runtime/model,
with no model or hardware mocks. Final command:

```sh
TRANSLATEGEMMA_CONTEXT_SMOKE=1 TRANSLATEGEMMA_PROFILE_DIR="$PWD/.cache/translategemma-context-profile" TRANSLATION_CHANNEL=chromium npx playwright test tests/browser/translategemma-context-smoke.spec.js --project=chromium --workers=1
```

**2 passed (8.9 seconds using cached assets)** with the final fixed prompt.
Initial uncached model loads took several minutes; the optional test-only
persistent browser profile reuses weight bytes while each direction still owns
a fresh Worker. The profile is ignored, local test data; no product context
persistence was introduced. Raw final results include outputs, inference
latencies, model pin and sanitized request metadata:
[English → Japanese](translation-173-en-ja.json),
[Japanese → English](translation-173-ja-en.json).

| Direction / target | Official template | Nonempty context |
| --- | --- | --- |
| en→ja: They are ready. | 準備はできました。 | 彼女は準備ができました。 |
| en→ja: The port is blocked. | 港は閉鎖されています。 | ポートは遮断されています。 |
| ja→en: あの人はもう準備ができています。 | That person is ready now. | She is ready. |
| ja→en: 先生が来ました。 | The teacher arrived. | The doctor arrived. |

Contexts identify a female surgeon, a network port, a female referent and a
medical doctor, respectively. All four contextual outputs contain only the
target translation, without context markers or the extra background details.
All four explicit-empty resets exactly reproduced their official outputs.
Final request checks found only GETs, no bodies, and no target/context values in
URLs; no network requests failed. Two focused packaged context checks were
rerun after the final prompt refinement and passed as well.

**Known model-quality limitations:** context is experimental and does not
reliably resolve every ambiguity. In exploratory Japanese → English checks,
`もう準備ができました。` did not pick the requested female subject: outputs
were “I'm ready.”, “It's all set.” or “It's ready now.” across prompt refinements.
`このマウスは動きません。` remained “This mouse isn't working.” despite
animal context, rather than the expected physical-motion sense. These failures
are retained in [exploratory results](translation-173-exploratory.json), including
the exact contexts, outputs and timestamps. They are not reported as passed
quality probes or hidden by output rewriting/retry. The final acceptance probes
use an explicit ambiguous-person reference and the medical sense of 先生;
they do not establish reliable omitted-subject inference, all-domain correctness,
or a general translation-quality improvement. Context marker/echo and reset
checks also passed in the negative exploratory cases.

The existing opt-in packaged MV3 real smoke also includes both-direction
pronoun/terminology comparisons, but was not run because production packaging
is blocked by missing ASR/other assets. Real inference above ran through the
production web Worker on localhost; extension cache/graph integration is covered
by the deterministic MV3 checks. No post-merge-only verification is required
by #173.
