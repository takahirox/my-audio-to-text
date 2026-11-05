# Local text summaries

**Text Summary · LFM2.5 1.2B JP** and **Text Summary · Qwen3.5 2B**
accept one `text: TEXT` and emit one complete `summary: TEXT` per successful
input, even when the result is unchanged. They own no prior-summary history,
window timer, batching, or evidence reconciliation. Each input makes one local
request and one generation for articles, technical material, conversations,
transcripts or any other text. Each Node owns an independent Worker with the
same existing local model backend.

## Settings

Both Nodes expose a multiline **prompt** field and **language** (`ja` or `en`).
The default prompt is exactly `Summarize the input text.`. Customize it with,
for example, `Summarize in three bullets. Focus on technical highlights.` or
`Give a chronological summary.`. It is an instruction, not an input port.
There are no implicit sections, meeting rules, ownership checks, correction
heuristics or semantic rejection/repair passes.

The system message contains the saved prompt followed only by
`Use Japanese unless the instruction above requests another language.` (or
English for `en`). Thus language provides a fallback; an explicit language in
prompt takes precedence. It does not impose a summary structure. The complete
input is JSON-quoted in the user message, escaping angle-bracket chat delimiters.

Prompt must be a nonempty string of at most **4,096 UTF-16 code units**.
Invalid settings and combined token-budget overflow are errors; instructions
and input are never silently truncated. Save, Load and JSON Import preserve
literal newlines. Graph actions → Export graph JSON downloads the validated draft, including
the prompt and its newlines. An unsaved draft does not affect a session. Save applies both settings
to the next session; each generation uses that session's saved instruction.

## Incremental example with Hold

[Import this minimal graph](examples/incremental-text-summary.json) in Graph
Editor. It contains a Text constant as a small, repeatable demonstration; Start
begins with empty previous summary. TextWindow emits the text after its normal
1.5-second deadline (or on Stop). Save prepares the selected summary model.
For live transcripts, replace Text with your ASR's `final: TEXT` output. Leave the
other connections unchanged:

```text
ASR.final → TextWindow.text → TextFormatter.input2
Hold.value                → TextFormatter.input1
TextFormatter.text        → TextSummary.text
TextSummary.summary    → Hold.input
TextSummary.summary    → Display.input1
```

Set the formatter to two inputs and this template (literal newlines):

```text
Previous summary:
{1}

New text:
{2}
```

Set TextSummary's **prompt** explicitly for rolling updates, as the example
does:

```text
Update the previous summary using the new text. Preserve still-relevant facts and explicit corrections. Return the complete updated summary.
```

That instruction belongs to the saved graph; the implementation does not
interpret the formatter's labels or assume a transcript.

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
promises and causally forwarded deliveries on the path to storage in Hold.
Unchanged results still complete; unrelated TEXT events cannot release waiting
work. A feedback path that finishes without storing a causal result fails
visibly, rather than continuing on stale context. Async processors used on this
path must await their work and emit through their supplied receive context, or
retain that obligation with an explicit `context.defer()` work handle;
background/timer emissions from a startup context cannot signal completion.

An independent translation/display branch is supported:

```text
TextSummary.summary ──┬──→ Hold.input
                        └──→ TranslateGemmaEnJa.text → Display.input1
```

Hold stores the original completed summary. When S1 has been stored, the next
window may summarize using S1 while translation T1 is still running. The same
behavior applies to OPUS-MT and other independent consumers. Feedback stays
serial; translation keeps its own bounded committed FIFO and replaceable
preview. Translation errors remain visible without replacing or corrupting the
original held summary. An overloaded translation branch stops visibly while
healthy summary updates continue. Stop still drains accepted translations;
Cancel/disposal suppress late replies and release Workers. New runs start fresh.
If translation is instead placed on the path **back into Hold**, its completion
necessarily precedes the next summary. The runtime uses ordinary graph
reachability and [explicit async ownership](pipeline-runtime.md#queued-asynchronous-work-207),
without changing TEXT ports, graph versions or Save/Load.

Only non-emitting sampled edges break cycle validation. Every ordinary event
cycle remains invalid in both the editor and Pipeline. Hold connections save and
reload as normal graph edges. Existing graph version 15 and strict primitive
port compatibility remain unchanged.

## Existing saved graphs: explicit recovery

Legacy `MeetingSummaryLfm2` and `MeetingSummaryQwen35` types are deliberately
rejected with recovery instructions on both Load and Import. They are not
palette entries or runtime aliases. This avoids silently replacing the old
meeting instruction with a generic instruction and changing a rolling graph's
meaning. Invalid saved JSON stays in storage; Live reports the error, and Graph
Editor exposes the original under **Graph actions → Saved JSON**. Merely opening
the editor does not overwrite it or rewire any edge.

1. Copy the original JSON before saving a replacement draft.
2. Change each old type to `TextSummaryLfm2` or `TextSummaryQwen35`, respectively.
3. Add `settings.prompt` to each summary Node. Use `Summarize the input text.`
   for standalone summaries, or write an explicit rolling-update instruction
   such as the example above. Keep the existing language.
4. Keep every Node ID, position, other setting and edge unchanged. Import the
   edited JSON, validate it and Save. Do not Reset or save the fallback default
   graph over your work.

The cache keys, asset manifests, packaged runtime directory and license paths
retain their historical `meeting-summary` names so verified weights are reused.
Model checkpoints, checksums, downloads and translation/TTS assets are unchanged.
Preparation/review commands now use `text-summary` names.

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

TextSummary accepts a nonempty formatted input of at most **32,768 code
units**; empty or oversized input fails explicitly. It never splits or truncates
evidence. Prompt plus output must fit the **8,192-token** runtime budget, with
up to **1,024 new tokens** and a **6,000-code-unit** nonempty result. A too-large
prompt, exhausted generation budget, malformed result, model/Worker error or
GPU loss publishes no replacement. Loading and generation each have a
three-minute deadline. Nonempty, bounded output is required, without a
domain-specific factual validator or repair generation.

Stop flushes TextWindow's remaining tail, drains accepted FIFO updates through
Hold and Display, then releases the model Worker. Stop may report an explicit
branch failure; it does not discard successful displayed work. Cancel/abort and
disposal immediately invalidate pending updates and late replies and release
Workers; they discard waiting windows and TextWindow tails. Cancel retains the
last successful display. Fresh Start creates fresh nodes, empty Hold state and
no model history. Calling Start again on the same Pipeline is rejected.

Input commands are quoted data, but prompt-injection resistance and model
quality are not guaranteed. Summaries can omit, invent or distort facts; verify
against the source text. Historical #130 and #202 evidence does not validate the
new generic prompt or arbitrary user instructions.

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
caches are released after each update; the Worker stores no summary history.

The single request records prompt/output tokens, first-token time and total
generation time; progress is internal telemetry rather than a public port.

The isolated packaged runtime is Transformers.js **4.2.0** with its exact
`onnxruntime-web` **1.26.0-dev.20260416-b7804b056c** dependency. Runtime archives
and packaged files have SHA-256 pins. Existing translation, Whisper, TTS and
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
downloads contact the model host; those requests contain no input text.

## Reproduction and test boundaries

```sh
npm ci
npm test
npm run test:browser -- tests/browser/hold-feedback.spec.js
npm run test:extension -- tests/extension/graph-hold-feedback.spec.js
# Full asset-backed package (see chrome-extension.md for other prerequisites):
npm run prepare:text-summary-assets
npm run build:extension
TEXT_SUMMARY_SMOKE=1 npm run test:extension -- tests/extension/graph-text-summary-smoke.spec.js
```

The deterministic browser/MV3 checks use controlled model replies with the
production Hold, Pipeline, formatter and TextSummary node. The MV3 feedback
test packages source in an isolated fixture extension; it does not assert that
the complete model-bearing distribution builds. Unit tests separately cover
bounds, missing/failed/unrelated completion, cancellation and typed graph
validation. The opt-in real-model test uses the same explicit feedback graph,
real pinned runtime/models and offline inference; it must be run separately to
assess this prompt. See [Issue #210 validation](evidence/text-summary-210.md) for actual results
and unperformed checks, and [Issue #202](evidence/hold-feedback-202.md) for
historical feedback validation. Old [#130 model evidence](evidence/meeting-summary-130.md)
remains historical and must not be reported as verification of this change.
