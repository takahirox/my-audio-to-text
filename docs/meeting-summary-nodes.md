# Local live meeting summaries

**Meeting Summary · LFM2.5 1.2B JP** and **Meeting Summary · Qwen3.5 2B**
accept one `text: TEXT` and emit one complete `summary: TEXT` per successful
input, even when the result is unchanged. They own no prior-summary history,
window timer, batching, or evidence reconciliation. Each input makes one local
update request and one generation. Their only setting is `language` (`ja` or
`en`), frozen for the session.

## Incremental example with Hold

[Import this minimal graph](examples/incremental-meeting-summary.json) in Graph
Editor. It contains a Text constant as a small, repeatable demonstration; Start
begins with empty previous summary. TextWindow emits the text after its normal
1.5-second deadline (or on Stop). Save prepares the selected summary model.
For a live meeting, replace Text with your ASR's `final: TEXT` output. Leave the
other connections unchanged:

```text
ASR.final → TextWindow.text → TextFormatter.input2
Hold.value                → TextFormatter.input1
TextFormatter.text        → MeetingSummary.text
MeetingSummary.summary    → Hold.input
MeetingSummary.summary    → Display.input
```

Set the formatter to two inputs and this template (literal newlines):

```text
Previous summary:
{1}

New transcript:
{2}
```

Hold has ordinary typed `input: TEXT` and `value: TEXT` ports. `value` starts
as `''`. Its input **stores** the latest value without emitting. The runtime
**samples** value together with the next ordinary delivery at the connected
consumer. Updating Hold alone never formats text or generates a summary.
No source identities, special data types, edge flags or separate loop manager
are involved. Hold works with any TEXT producer/consumer.

A new TextWindow event produces exactly one formatted string. While its summary
is generating, later windows wait FIFO **before** reading Hold. For concurrent
A/B/C windows, the requests are `S1=f('',A)`, `S2=f(S1,B)`, `S3=f(S2,C)`.
There is only one request in flight on this path. The runtime awaits receive
promises and all causally forwarded deliveries, including storage in Hold.
Unchanged results still complete; unrelated TEXT events cannot release waiting
work. A feedback path that finishes without storing a causal result fails
visibly, rather than continuing on stale context. Async processors used on this
path must await their work and emit through their supplied receive context;
background/timer emissions from a startup context cannot signal completion.

Only non-emitting sampled edges break cycle validation. Every ordinary event
cycle remains invalid in both the editor and Pipeline. Hold connections save and
reload as normal graph edges. Existing graph version 15 and strict primitive
port compatibility remain unchanged. Previously saved direct MeetingSummary
graphs still load, but now summarize each input independently; add this explicit
Hold/formatter composition when incremental history is desired. Original saved
JSON is retained until you choose to edit and Save.

## Bounds and session lifecycle

TextWindow controls window boundaries; configure its existing NUMBER thresholds
to choose a cadence suitable for inference speed. Default thresholds are 600
UTF-16 code units or 1.5 seconds. Each sampled consumer permits at most **32
accepted deliveries and 32,768 ordinary-input characters**, including its active
update. Overflow rejects the new delivery and visibly stops that branch,
canceling its accepted waiting work; it does not silently coalesce windows.
A sampled update has a **four-minute** deadline. Failed, missing, or timed-out
completion stops the branch and reports an error. Independent paths remain
usable. Reduce input rate and Start a new session after fixing the cause.

MeetingSummary accepts a nonempty formatted input of at most **32,768 code
units**; empty or oversized input fails explicitly. It never splits or truncates
evidence. Prompt plus output must fit the **8,192-token** runtime budget, with
up to **1,024 new tokens** and a **6,000-code-unit** nonempty result. A too-large
prompt, exhausted generation budget, malformed result, model/Worker error or
GPU loss publishes no replacement. Loading and generation each have a
three-minute deadline. Conservative grounding checks reject invented
attribution, unreported completion and explicitly superseded numbers; rejected
results fail visibly without a repair generation or fabricated summary.
These checks cannot prove factual accuracy or completeness.

Stop flushes TextWindow's remaining tail, drains accepted FIFO updates through
Hold and Display, then releases the model Worker. Stop may report an explicit
branch failure; it does not discard successful displayed work. Cancel/abort and
disposal immediately invalidate pending updates and late replies and release
Workers; they discard waiting windows and TextWindow tails. Cancel retains the
last successful display. Fresh Start creates fresh nodes, empty Hold state and
no model history. Calling Start again on the same Pipeline is rejected.

The prompt requests a refreshed summary from the entire formatted evidence,
preserving uncertainty, corrections, names, numbers and unknown ownership.
Evidence is a quoted user message with escaped chat delimiters. Input commands
are data, but prompt-injection resistance and model quality are not guaranteed.
Summaries compress history and can omit, invent or distort facts. Keep an
independent transcript and verify decisions, owners and dates. The prior #130
extractive-reconciliation evidence does **not** validate this changed prompt.

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
caches are released after each update; the Worker stores no meeting history.

Grounding checks are conservative lexical guards, not entailment validation.
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
Start and no transcript or summary leaves the browser for inference. Save-time
downloads contact the model host; those requests contain no meeting content.

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
validation. The opt-in real-model test uses the same explicit feedback graph,
real pinned runtime/models and offline inference; it must be run separately to
assess this prompt. See [Issue #202 validation](evidence/hold-feedback-202.md) for
actual results and unperformed checks. Old [#130 model evidence](evidence/meeting-summary-130.md)
remains historical and must not be reported as verification of this change.
