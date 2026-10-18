# Local IfCondition

Add **IfCondition · local AI** from the Graph Editor's Processors category. It
accepts `text: TEXT`, has one editable natural-language `condition`, and exposes
`yes: TEXT` / `no: TEXT`. For example, connect `SpeechToTextReazonSpeech.final`
to `IfCondition.text`, set `Is this a question?`, and connect the two outputs to
separate Live text displays. Text, translators and other ordinary TEXT producers
can use the same Node. Save/reload preserves each instance's independent condition
and wires. Graph version remains **9**; defaults and migrations are unchanged.

A successful nonempty input runs a real binary classifier in an owned module
Worker, then emits the **original string unchanged** to exactly one port. The
model's input tokenization never changes the emitted text. Repeated identical
inputs are separate jobs. Ordinary fan-out and parallel paths still work; the
shared Pipeline has no conditional-routing logic, joins, or decision registry.

## Model and runtime selection

The pinned model is
[MoritzLaurer/xtremedistil-l6-h256-zeroshot-v1.1-all-33](https://huggingface.co/MoritzLaurer/xtremedistil-l6-h256-zeroshot-v1.1-all-33/tree/c07f66d9cbf781191bee66edfe8ad7856f045781),
revision `c07f66d9cbf781191bee66edfe8ad7856f045781`. The source includes the actual
q8 ONNX export. Five required model/tokenizer/configuration files total
**13,826,967 bytes**, including **13,114,198 bytes of weights**. This six-layer,
256-hidden BERT classifier uses about 13M parameters. Its model card specifically
identifies efficient browser use as an intended application; compatibility was
also exercised with the actual packaged MV3 Worker, rather than inferred from
that claim alone.

The classifier receives the text as its first sequence (premise) and the
condition as its second sequence (hypothesis). Its trained labels are
`entailment` and `not_entailment`, mapped to Yes and No. Conditions can be English
questions (`Is this a question?`, `Does this text mention an animal?`) or
assertions (`This text has a positive sentiment.`). Phrase the condition clearly
and test representative text. It is a binary zero-shot classification task, with
no chat interface, generated answer parsing, remote API, or heuristics based on
punctuation/keywords. Only English is verified here.

Selection included real browser probes of FLAN-T5-small/base, SmolLM2-135M,
LFM2/2.5-350M, Gemma-3-270M, Qwen2.5-0.5B and DeBERTa xsmall. Generative candidates
were larger and unreliable at producing the correct immediate Yes/No answer to
these prompts. Generic three-label NLI also handled question hypotheses poorly.
The selected specialized binary model is much smaller and faster, with useful
results on the tested pairs. This is an engineering selection, not a comparative
accuracy benchmark; prompts and quantizations differed between probes.

The Worker reuses the checksum-pinned Transformers.js **4.0.0-next.3** and ONNX
Runtime Web **1.25.0-dev.20260212-1a71a5f46e** from
`prepare:translation-assets`, running **CPU WASM, one thread**. There is no GPU
requirement. The extension build additionally verifies each required runtime
file against `scripts/if-condition-runtime.json`. The existing CSP stays
`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self'`.
Executable code is packaged, including WASM and its module loader. WASM caching
is disabled because its runtime-generated blob module is blocked by MV3.

The fine-tuned model and its Microsoft base both declare **MIT** in their model
cards. The base's upstream MIT copyright/license notice is retained in
`web/licenses/if-condition-model.txt`; model attribution is included there and
in the Models page. The existing packaged notices cover Transformers.js
(Apache-2.0) and ONNX Runtime (MIT). Model weights are downloaded as data and are
not committed or bundled.

## Preparation and recovery

**Save graph** persists the validated graph first, then prepares the required
model assets through `GraphModelPreparation` / `ModelAssetCache`, including
parked IfCondition Nodes. Multiple instances share only verified cached assets;
they own separate models/Workers and conditions. Preparation uses immutable
checkpoint URLs, byte lengths and SHA-256 hashes for every 1 MiB chunk. It
streams downloads, reports progress, reuses verified files, supports Cancel and
Retry, and detects corruption/eviction. A preparation failure leaves the saved
graph intact. The Models page also supports check, download/retry and deletion.

Save performs **no inference** and creates no inference Worker. Start checks
cached integrity and loads only cached model data; missing/invalid assets do not
trigger a recording-time download. The runtime disables remote models and both
ordinary runtime/model caches, and its read-only custom cache allowlists only
the pinned data URLs. Optional model lookups fall back to packaged local 404s.
Input text is never sent to a cloud API. A failure is shown in Live's
IfCondition status; fix the condition/input or Save/retry preparation and Start
a fresh session. Unrelated transcript/display/processing paths remain running.

Allow roughly **40 MB storage** for data and overhead, and **250 MB free RAM per
active instance** as conservative planning guidance, not a measured hard limit.
The packaged shared runtime is approximately 28 MB. Actual memory/startup/latency
vary by browser and hardware. More instances multiply inference memory; input
and queue limits do not guarantee that a device cannot run out of memory.

## Defined behavior and limits

- An empty or whitespace-only string goes to No verbatim, after successful model
  loading, without inference. Non-strings are errors.
- Conditions must be nonblank and at most 512 UTF-16 code units. Text is limited
  to 2,048 code units. The combined tokenized pair must fit 512 tokens, including
  separators. Inputs are rejected visibly, never truncated.
- The two logits are normalized with a stable softmax. The winning score must
  be at least **0.55**; the central uncertainty band emits neither branch and
  stops this instance with an explicit error. Nonfinite/wrong-shaped logits,
  wrong label mappings, Worker failure, missing runtime/model and timeouts are
  also errors. No error is converted into a fabricated Yes or No.
- Scores are **not calibrated probabilities of semantic correctness**. Even a
  confident result can be wrong. The model is sensitive to wording; initial
  probes misclassified `Can you help me?` with `Does this text ask a question?`.
  The same condition can work for some question forms and fail for others. This
  feature cannot promise reliable classification for arbitrary conditions,
  prompt injection resistance, languages, or security/medical/legal decisions.
- Each instance holds at most 32 inputs and 32,768 text code units, including the
  in-flight job. Overflow stops the instance visibly and releases its Worker;
  other paths stay usable. At most one inference is active in each Worker.
- Load has a 120-second timeout; each decision/drain has 30 seconds. No automatic
  download, backend substitution, retry, or fallback guess occurs on failure.
- FIFO ordering preserves repeated/independent deliveries. Stop waits for every
  accepted queued input and then drains/terminates the Worker. Cancel terminates
  immediately and discards uncommitted jobs. Completed downstream text remains.
  Failures discard pending jobs with a visible branch error, not a success claim.
- A fresh Start builds fresh Node/Worker instances. Request IDs, the owning
  Worker identity, disposed state and AbortSignal guard replies. Old callbacks
  cannot emit into canceled/restarted sessions. Shutdown removes listeners,
  rejects pending requests, clears timers/queues and releases the Worker/model.

## Verification

```sh
npm ci
# Standard extension asset setup; see README for all preparation commands.
npm run prepare:if-condition-test-model
npm run build:extension
npm test
npm run test:extension
npm run test:if-condition-real
```

`prepare:if-condition-test-model` downloads and verifies only the real smoke's
fixture data. Production users prepare weights via Save instead. The maintainer
script `scripts/review-if-condition-assets.py` reproduces the immutable manifest;
review the diff before changing a checkpoint.

Unit and deterministic packaged tests cover routing, original/repeated/empty
strings, independent conditions, unchanged v9/default graphs, errors and
uncertainty, queued processing, resource bounds, timeouts, Stop/drain, Cancel at
load/inference/drain, Worker crashes, disposal and stale replies. Packaged tests
retain the production Worker/cache/policy and replace only the model runtime
with explicit fixture scores. They do not establish semantic accuracy.

The opt-in real smoke keeps actual pinned weights, tokenizer, packaged runtime,
owned Worker, cache verification, graph and sinks. A fixture replaces only the
upstream ASR producer. It prepares via Save, verifies cache reuse/no inference at
Save, disables networking, routes meaningful English examples to separate sinks,
checks original text/repeats/empty values, changes independent condition settings,
Stops and repeats sessions, and records browser/hardware, model bytes, startup,
end-to-end decision latency, HTTP attempts and CSP violations. See
[Issue #125 evidence](evidence/graph-125.md). Opt-in skips are not inference passes.
There is no post-merge-only verification requirement.
