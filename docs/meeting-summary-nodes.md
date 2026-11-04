# Local text summarization

The two **Text Summary** processor nodes use the existing LFM2.5 1.2B JP and
Qwen3.5 2B local WebGPU models. They accept `text: TEXT` and emit
`summary: TEXT`. The input may be an article, notes, ASR transcript, or any
other text; neither the model nor the graph requires meeting-specific fields.

## Settings: language and prompt

Each Text Summary node exposes these independent settings:

- `language`: `ja` or `en` (the language of the **minimal default prompt**).
- `prompt`: an editable multiline instruction, up to 4,096 characters.
  **A nonempty custom prompt completely replaces** the default; it is not
  supplemented with meeting-specific instructions, mandatory sections,
  speaker attribution requirements, decision/status classification or hidden
  content rules. An empty prompt uses only `次の文章を要約してください。`
  (Japanese) or `Summarize the following text.` (English).

The prompt is a plain **instruction**, not a placeholder template. It is sent
as the system message, while the complete incoming `text` is sent separately
as the user message. Write your desired format, language, length, focus or
incremental-update rules into this prompt if you want them. A custom prompt
can request either language regardless of the `language` setting.

Graph Editor → select the Text Summary node → Settings → `prompt`. Changes are
saved with the graph and apply on the next Start. Older graphs without `prompt`
continue to use the minimal default, without migration. The internal saved
node-type identifiers (`MeetingSummaryLfm2`/`MeetingSummaryQwen35`) and
model-asset keys stay unchanged for graph/cache compatibility; the user-facing
nodes are named **Text Summary**.

Inputs/outputs are unchanged. Each received nonempty TEXT starts one generation;
there is no implicit batching, state, previous summary or formatting. Existing
runtime bounds remain: input at most 32,768 UTF-16 units, output at most 6,000,
prompt plus output at most 8,192 tokens with up to 1,024 new tokens. Exceeding
a bound is a visible failure, never silent truncation. Blank/oversized model
results fail visibly. No fixed meeting-specific content validation or result
rejection remains. Generated summaries can still be incomplete or inaccurate;
the user's prompt and the model determine content.

## Examples

Simple one-shot summary:

```text
Text.value / ASR.final / other TEXT → Text Summary.text → Display.input
```

For incremental summarization, connect a TextWindow and a Hold using TextFormatter.
The example [importable graph](examples/incremental-meeting-summary.json) contains
a Text constant for repeatability; substitute any other TEXT source.

```text
Source.text → TextWindow.text → TextFormatter.input2
Hold.value                 → TextFormatter.input1
TextFormatter.text         → Text Summary.text
Text Summary.summary       → Hold.input
Text Summary.summary       → Display.input
```

Set TextFormatter to two inputs and this template (literal newlines):

```text
Previous summary:
{1}

New text:
{2}
```

With this configuration, `Hold.value` starts empty. Each new TextWindow event
samples the latest completed summary; storing a summary does not trigger another
round. The runtime processes feedback updates in FIFO order before sampling
Hold for the next update. **The Text Summary node does not implicitly interpret
"Previous summary" and "New text":** for incremental behavior, explicitly
describe how you want the previous summary revised in the node's `prompt`,
for example:

```text
Update the previous summary using the new text. Keep it concise and
retain useful earlier information unless the new text changes it.
Return only the updated summary.
```

TextWindow controls cadence (default 600 characters or 1.5 seconds); use
Number outputs on `maxChars` and `maxWaitSeconds` to adjust. Any downstream
translation branch can run separately while Hold stores the original summary.
Stop flushes the TextWindow tail and drains accepted work; Cancel discards
pending work and late replies. Fresh Start clears Hold. A sampled feedback
consumer is bounded to 32 accepted deliveries / 32,768 ordinary-input
characters, with a four-minute update deadline. Errors are visible and do not
fabricate a replacement summary. See [runtime feedback](pipeline-runtime.md).

## Safeguards and limitations

The input is passed as quoted JSON text to separate it from the configured
system instruction and escape chat-delimiter characters. This reduces accidental
instruction mixing but does not guarantee prompt-injection resistance. The
runtime still checks input/output size, model failures, and session lifecycle;
**it does not add content-specific rules or overwrite the custom prompt**.
Always review important summaries against the original text.

## Pinned models, runtime and terms

| Processor | Immutable model revision | Download | Planning allowance per active Node |
| --- | --- | --- | --- |
| LFM2.5 JP | `LiquidAI/LFM2.5-1.2B-JP-202606-ONNX` @ `01b5a0a33d22253d5ee52b367d2375eeb113b7cd` | 748,958,502 bytes | 2 GB storage; 4 GB free RAM/GPU |
| Qwen3.5 | `onnx-community/Qwen3.5-2B-ONNX-OPT` @ `ed446636739bf426e73c5a00714fd8e010d36c21` | 1,402,859,425 bytes | 3 GB storage; 6 GB free RAM/GPU |

These memory allowances are conservative planning estimates, not measured peak
requirements or an available-memory guarantee. Chrome cannot reliably report
free VRAM. Concurrent instances each load their own weights/tensors; stored
assets alone are shared. Two high-memory models plus ASR/translation can exhaust
memory even when each model works independently.

Both use q4f16, Worker WebGPU and `shader-f16`; no CPU fallback. LFM loads
`model_q4f16.onnx` and its external data (744,091,648 weight bytes). Qwen uses
`AutoModelForCausalLM` to load only `embed_tokens_q4f16` and
`decoder_model_merged_q4f16`, each with one external data file; the vision
encoder/processor are unnecessary. Both pinned tokenizers, configs, generation
configs and chat templates are included. Chat templates come from tokenizer
metadata; Qwen thinking is disabled. Generation is greedy, without heading
prefill or a repetition penalty. Each update allows up to 1,024 new tokens;
exhausted output budgets are errors, never successful truncated snapshots.
Prompt plus output is checked against an 8,192-token application budget without
silently truncating evidence. LFM's published card specifies 32,768 context
(its config says 128,000); Qwen config specifies 262,144. Temporary generation
caches are released after each update; the Worker stores no history.

The single request records prompt/output tokens, first-token time and total
generation time; progress is internal telemetry rather than a public port.

The isolated packaged runtime is Transformers.js **4.2.0** with its exact
`onnxruntime-web` **1.26.0-dev.20260416-b7804b056c** dependency. Runtime archives
and packaged files have SHA-256 pins. Existing translation, Whisper, TTS and
optional ASR runtimes are unchanged. JavaScript and native WebGPU asyncify WASM are packaged;
no executable code is fetched at run time. See `scripts/meeting-summary-runtime.json`.
Its AutoTokenizer discovery probes `main` without forwarding the requested
revision. Both exports use the generic TokenizersBackend, so the Worker builds
PreTrainedTokenizer directly from the verified immutable tokenizer JSON/config
instead of creating a mutable cache alias or enabling remote discovery.

The [LFM ONNX card](https://huggingface.co/LiquidAI/LFM2.5-1.2B-JP-202606-ONNX/tree/01b5a0a33d22253d5ee52b367d2375eeb113b7cd)
attributes export to Liquid4All/onnx-export with Q4-to-FP16 conversion. The
[Qwen optimized export](https://huggingface.co/onnx-community/Qwen3.5-2B-ONNX-OPT/tree/ed446636739bf426e73c5a00714fd8e010d36c21)
identifies `Qwen/Qwen3.5-2B` as its base but has an empty model card: the exact
conversion command and exporter version are not supplied. Do not claim that
provenance was independently reconstructed. Config/session names and real
inference are the compatibility checks for the selected immutable conversion.

LFM is under **LFM Open License 1.0**, packaged in
`web/licenses/meeting-summary-lfm2.txt`. Its commercial-use grant is conditional
on the $10 million annual-revenue threshold; use exceeding that threshold needs
separate terms from Liquid AI. Redistribution requires the license, retained
attributions/notices, and notices for modified files. The extension downloads
unmodified pinned assets and includes the license. Review its full terms for
your use. Qwen's source checkpoint @ `15852e8c16360a2fea060d615a32b45270f8a8fc`
uses Apache 2.0 (`web/licenses/meeting-summary-qwen35.txt`); the conversion does
not supply a separate license/NOTICE. Transformers.js is Apache 2.0; ONNX Runtime
is MIT. See the packaged licenses and third-party notices.

## Preparation and recovery

Save graph persists first, then prepares both selected model sets, including
disconnected/parked Nodes. Each has its own progress/cancel/retry card and Models
cache controls/license link. Duplicate Nodes share stored assets only. Every
file has immutable URLs, exact byte counts and 1 MiB SHA-256 chunk pins. Save
reuses verified cache entries; corruption/partial downloads are never Ready.
Quota failure does not undo Save. Free storage or delete unused cache entries,
then Retry preparation. Cancellation preserves complete verified files; retry
downloads missing files. Preparation across windows is serialized by Web Locks.

Start re-verifies the entire required cached set. Missing/evicted/corrupt data
is an explicit branch-local error. Only canonical allowlisted cached model
URLs can be loaded; optional lookups get local misses. No model downloads after
Start and no source text or summary leaves the browser for inference. Save-time
downloads contact the model host; those requests contain no source text.

## Reproduction and test boundaries

```sh
npm ci
npm test
npm run test:browser -- tests/browser/hold-feedback.spec.js
npm run test:extension -- tests/extension/graph-hold-feedback.spec.js
# Full asset-backed package (see chrome-extension.md for other prerequisites):
npm run prepare:meeting-summary-assets
npm run build:extension
MEETING_SUMMARY_SMOKE=1 npm run test:extension -- tests/extension/graph-meeting-summary-smoke.spec.js
```

The deterministic browser/MV3 checks use controlled model replies with the
production Hold, Pipeline, formatter and MeetingSummary node. The MV3 feedback
test packages source in an isolated fixture extension; it does not assert that
the complete model-bearing distribution builds. Unit tests separately cover
bounds, missing/failed/unrelated completion, cancellation and typed graph
validation. The opt-in real-model test uses an explicit feedback graph and real pinned
runtime/models with offline inference; run it separately to assess output quality
for the chosen prompt and input domain. See [Issue #202 validation](evidence/hold-feedback-202.md) for
actual results and unperformed checks. Historical meeting-specific [#130 model evidence](evidence/meeting-summary-130.md)
remains historical and must not be reported as verification of this change.
