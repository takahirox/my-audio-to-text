# Local text processing

**Text Processing · LFM2.5 1.2B JP** and **Text Processing · Qwen3.5 2B**
are independent local AI Nodes in **Add Node → AI Models / Text**. They replace
the Summary nodes. Each owns its own WebGPU Worker; duplicate instances share
verified stored assets only. The historical module, playground URL, preparation
command and cache names remain stable so existing model downloads are reused.

## Settings and ports

- **System prompt** (`settings.prompt`): saved, nonempty multiline text, up to
  **4,096 UTF-16 code units**. Specify the task, output language and format here.
  The generic default asks the model to process supplied inputs as data.
- **Input count** (`settings.inputCount`): a whole number from **1 to 32**, default
  **1**. Inputs are `input1 … inputN: TEXT`. There is no prompt input port.
- **result: TEXT**: one complete nonempty output for each successful generation,
  including results equal to the previous output. Token progress is telemetry,
  not a streaming result.

The exact saved prompt is the **system role**, with no added language, summary
or meeting instructions. The **user role** is an ordered JSON array such as
`[{"input":"Input 1","value":"…"},{"input":"Input 2","value":"…"}]`. JSON escaping
preserves quotes, backslashes, newlines and Unicode; angle brackets are escaped
to avoid raw chat delimiters. Input content never enters the system message.
Refer to **Input 1**, **Input 2**, etc. in your prompt. No template language is
introduced. Models can still follow malicious input or generate inaccurate
results; verify against the source.

Input count changes update editor connectors and validation. Removing a port
**retains its wire as a visible validation error**, without reconnecting its data
to another input. Disconnect the obsolete edge explicitly or Undo the count
change. Exposed Subgraph endpoints must also refer to existing ports; obsolete
exposures block saving. Undo/Redo, Auto Save and JSON import/export preserve
settings and literal prompt newlines. Changes apply to the next session; an
active run keeps its saved settings.

## Examples

| Task | System prompt | Inputs |
| --- | --- | --- |
| Summarization | Summarize Input 1 in two Japanese bullets. | An article in input1 |
| Proofreading | Proofread Input 1. Return corrected English text only. | A draft in input1 |
| Extraction | Extract names and deadlines from Input 1 as JSON. | Notes in input1 |
| Comparison | Compare Input 1 and Input 2 in English. List differences. | Two independent texts in input1 and input2 |

Import [proofreading](examples/text-processing-proofreading.json),
[extraction](examples/text-processing-extraction.json), or
[two-input comparison](examples/text-processing-comparison.json) in Graph Editor.
The two-input example deliberately uses independent Text updates: the first
request sees the other input empty; the second sees both. Atomic grouped
producers deliver both values in one request. The standalone Playground also
has these four examples and a configurable input count.

## Updates, snapshots and flow control

Each TEXT delivery updates the latest value of that port and requests **one**
generation from the complete numbered input snapshot. Unset ports are empty.
An atomic grouped delivery applies all its values before generating once;
omitted siblings of that producer's atomic family clear, like TextFormatter.
Independent inputs retain their latest values. Duplicate events still request
inference. No inference happens merely on Start or model preparation.

The Pipeline queues accepted deliveries FIFO through awaited inference. Each
request owns its immutable input snapshot; later updates cannot change it.
There is no hidden conversation, accumulated transcript, debounce or replayed
summary history. Frequent updates run the large model repeatedly. Use existing
**TextWindow**, **Hold** and **Button** nodes to choose the desired frequency.

For explicit rolling summaries, import
[incremental-text-summary.json](examples/incremental-text-summary.json). It
formats held previous output and the next window into Input 1 using an explicit
saved rolling-summary instruction. A direct two-input equivalent is:

```text
Hold.value                 → TextProcessing.input1
ASR.final → TextWindow.text → TextProcessing.input2
TextProcessing.result      → Hold.input
TextProcessing.result      → Display.input1
```

Set Input count to 2 and System prompt to `Update Input 1 using Input 2. Preserve
relevant facts and corrections. Return the complete updated summary in Japanese.`
Leave Hold.trigger disconnected. Hold is sampled without emitting, and later
windows wait until the preceding causal result is stored before reading Hold:
`S1=f('', A)`, `S2=f(S1, B)`, `S3=f(S2, C)`. Updating Hold alone never infers.
Ordinary event cycles are rejected. Independent translation/display branches
retain their own queues and do not delay the next feedback request once Hold
has stored the result. See [async ownership](pipeline-runtime.md#queued-asynchronous-work-207).

For manual generation, import
[manual-text-summary.json](examples/manual-text-summary.json). Button →
Hold.trigger emits the latest accumulated transcript on demand; result goes to
the second Display tab. See [Graph Actions](graph-actions.md).

## Existing saved graphs: explicit recovery

Legacy `TextSummaryLfm2`, `TextSummaryQwen35`, `MeetingSummaryLfm2` and
`MeetingSummaryQwen35` are rejected with repair guidance on Load/Import. They
are not palette entries or runtime aliases. Original invalid JSON is retained;
Graph Editor exposes it under **Graph actions → Saved JSON**. Opening an old
graph does not overwrite it or silently change its wiring.

1. Copy the original JSON before making changes.
2. Replace the type with `TextProcessingLfm2` or `TextProcessingQwen35`.
3. Set `settings.inputCount` to `1`. Keep or add `settings.prompt` with an
   explicit task. Move any desired `language` instruction into this prompt and
   remove `settings.language`; no fallback language is appended by code.
4. Change only that node's input endpoint `text` to `input1`, and output endpoint
   `summary` to `result`, in edges and exposed Subgraph interfaces. Keep IDs,
   positions, text, prompt and every other connection unchanged.
5. Validate and import the repaired graph as a new Library entry. Keep the
   original until the repaired graph has been checked.

## Bounds and lifecycle

All inputs together must contain non-whitespace text and at most **32,768 UTF-16
code units**; individual missing or empty inputs are allowed. Invalid ports or
non-TEXT values fail visibly. Inputs, prompt, JSON framing and up to **1,024 new
tokens** share an **8,192-token** runtime budget. No truncation or splitting is
performed. A result must be nonempty and at most **6,000 code units**. Empty,
oversized or incomplete output, shader-f16 unavailability, GPU loss, cache/model
errors and Worker errors publish no replacement result.

The pending-delivery bound is **32 deliveries / 32,768 incoming characters**,
including active work. A combined snapshot is checked separately before each
request. Overflow visibly stops the branch and cancels waiting work. Loading
and inference each time out after three minutes; sampled feedback also has the
existing four-minute deadline. Failure retains the last displayed success and
requires a fresh session after repair. No output is fabricated.

Stop drains accepted work, including TextWindow's flushed tail, then releases
the owned Worker. Cancel/abort/dispose discard queued work, suppress late replies
and release resources immediately. Fresh Start creates new nodes and empty
input/Hold state. Existing licenses, verified downloads and offline WebGPU
execution are unchanged. No CPU/cloud fallback or recording-time download.

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
caches are released after each update; the Worker stores no conversation history.

The single request records prompt/output tokens, first-token time and total
generation time; progress is internal telemetry rather than a public port.

The isolated packaged runtime is Transformers.js **4.2.0** with its exact
`onnxruntime-web` **1.26.0-dev.20260416-b7804b056c** dependency. Runtime archives
and packaged files have SHA-256 pins. Existing translation, TTS and
optional ASR runtimes are unchanged. JavaScript and native WebGPU asyncify WASM are packaged;
no executable code is fetched at run time. See `scripts/text-summary-runtime.json`.
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

Auto Save graph persists first, then prepares both selected model sets, including
disconnected/parked Nodes. Models owns each model’s progress/cancel/retry card,
cache controls and license link; Graph Editor prepares assets headlessly and
reports failures in Graph notices. Duplicate Nodes share stored assets only. Every
file has immutable URLs, exact byte counts and 1 MiB SHA-256 chunk pins. Auto Save
reuses verified cache entries; corruption/partial downloads are never Ready.
Quota failure does not undo Auto Save. Free storage or delete unused cache entries,
then choose Retry or Download in Models. Cancellation preserves complete verified files; retry
downloads missing files. Preparation across windows is serialized by Web Locks.

Opening Live re-verifies the entire required executable cached set, creates
Workers and initializes models, including paths downstream of a triggered Hold.
Start stays disabled until Ready. Inference still runs only on TEXT delivery.
See [manual Graph Actions](graph-actions.md). Missing/evicted/corrupt data
keeps Start disabled with recovery instructions. Only canonical allowlisted cached model
URLs can be loaded; optional lookups get local misses. No model downloads after
Start and no input or result leaves the browser for inference. Auto Save
downloads contact the model host; those requests contain no input text.

## Reproduction and test boundaries

```sh
npm ci
npm test
npm run test:browser -- tests/browser/model-playground.spec.js --project=chromium
npm run test:extension -- tests/extension/graph-text-summary.spec.js tests/extension/graph-hold-feedback.spec.js
# Optional real inference: first prepare the pinned runtime and model assets.
# See chrome-extension.md for the other full-package runtime prerequisites.
npm run prepare:text-summary-assets
npm run build:extension
TEXT_SUMMARY_SMOKE=1 npm run test:extension -- tests/extension/graph-text-summary-smoke.spec.js
```

Default CI uses controlled Workers/tokenizers/models and does not download large
weights. Tests exercise the production Node, policy, Worker RPC, cache-only loader,
Pipeline, editor and persistence. They verify prompt roles/escaping, summary,
proofreading, extraction and comparison requests, atomic groups, duplicates,
missing inputs, FIFO snapshots under slow inference, Hold feedback, Stop/Cancel,
timeouts, failures, independent Workers, bounds, and model cache reuse. These
checks establish transport and lifecycle behavior, not model accuracy or speed.
The opt-in smoke test additionally records real outputs for these tasks.
Historical [#210](evidence/text-summary-210.md), [#202](evidence/hold-feedback-202.md)
and [#130](evidence/meeting-summary-130.md) evidence describes earlier implementations;
it is not verification of configurable multi-input processing.
