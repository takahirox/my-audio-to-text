# Local live meeting summaries

Issue #130 adds two independent processors under **Add node → Processors**:
**Meeting Summary · LFM2.5 1.2B JP** and **Meeting Summary · Qwen3.5 2B**.
Each accepts committed `text: TEXT` and emits one complete `summary: TEXT`.
Both real local inference paths are implemented and smoke-tested. The recorded
fixtures still expose factual errors and missed state changes; **Issue #130's
semantic acceptance criterion is not fully met**. See the evidence before
considering this implementation ready for Issue closure.
Connect `ASR.final`, `TextWindow.text` or `Text.value` to `text`, then `summary`
to a dedicated `LiveTextDisplay.replace`. Leave that display's append port
disconnected so Stop/Cancel retain the last successful note. Other TEXT
consumers are compatible. Translation, ASR and transcript displays can fan out
independently. There is no global model selection or preferred model.

The only setting is **language**: `ja` (Japanese) or `en` (English). The summary
language need not match the transcript. Each session freezes settings; saving
edits during a session changes the next session. Graph v9, existing saved data,
migrations, drafts and default graph are unchanged.

## Incremental behavior

The first pending committed fragment starts a 30-second timer. At 2,000 UTF-16
code units, or when the timer expires, the Node sends **only the previous
successful summary and the new batch**. Long inputs split without dividing a
surrogate pair. Fragments retain order and repeats; adjacent fragments get a
newline. Empty/whitespace-only inputs do nothing. Input is committed evidence:
successive input values are new fragments, not edits to a previously submitted
transcript. Do not connect a revising provisional stream to this port.

Each instance owns one Worker, one generation and bounded pending text. Update
triggers coalesce while inference runs, but unseen text is retained. Pending
plus active evidence is capped at 32,768 code units. Overflow explicitly rejects
the new fragment, closes acceptance and drains previously accepted text. Its
Live status reports this; independent branches keep running. Start a fresh
session after reducing input rate. No unbounded transcript or inference FIFO
is retained. Memory also includes the model's temporary tensors and caches.

During generation the previous snapshot remains visible. A successful nonempty
changed result replaces it atomically. Equal results emit nothing. Stop closes
acceptance, drains every accepted batch including the tail, then terminates the
Worker. Cancel/teardown terminates it immediately, clears pending context and
invalidates late replies. A new session starts with an empty note and no prior
context. Initialization/inference failure, empty/oversized output, GPU loss or
a timeout or exhausted output token budget leaves the last successful display intact and stops only this model
branch. There is no retry with a different checkpoint, CPU or cloud backend.
Start again after resolving the visible error. Load and generation each have
a three-minute deadline; Cancel can interrupt either.
The Live status identifies updated notes as AI drafts and asks users to verify
facts, decisions and owners against the transcript.

Prompts request discussion points, confirmed decisions, and open questions/action
items. They separate proposals from decisions and completed from open tasks,
preserve numbers, corrections and uncertainty, and prohibit invented owners,
facts or missing speech. Evidence uses quoted strings in a separate user message,
with escaped chat delimiters and explicit data boundaries. These instructions reduce risk; they do not guarantee model
obedience, factual accuracy or resistance to transcript prompt injection.

The previous summary is **lossy history compression**. Earlier facts can be
omitted or distorted and cannot be recovered from the model's note. Keep an
independent transcript display/record when exact evidence matters. This feature
does not claim to verify decisions or owners automatically.

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
metadata; Qwen thinking is disabled. Only the first heading and bullet marker
are prefilled to encourage plain notes; all meeting content comes from inference.
Prompts target 1,000 characters. Generation is greedy with a 1.05 repetition
penalty and up to 1,024 new tokens; exhausted output budgets are errors, never
successful truncated snapshots. Prompt plus output is checked against an
8,192-token application budget without silently truncating evidence. LFM's
published card specifies 32,768 context (its config says 128,000); Qwen config
specifies 262,144. The smaller application budget controls cache/resource use.

Before publishing, conservative lexical checks reject speaker-style labels absent
from the evidence, explicitly superseded numbers (including Arabic-number
Japanese-unit variants), and completion claims when the evidence contains no
completion statement. A rejected candidate can trigger at most two repair
generations using the original previous note and new transcript. Each generation
has the same token budget; retries share the existing 180-second request timeout
and bounded pending-text queue. Successful metrics include per-attempt token
counts and totals across attempts. If repair fails, no new snapshot is emitted,
the last successful display remains, and the processor reports an error.

These checks are **not semantic verification**: they can reject topic labels or
historical-number mentions conservatively and miss unsupported claims in other
forms, incorrect approval scope, or omitted facts. The actual pinned models still
fail the required sequential factual smoke; see the latest
[validation evidence](evidence/meeting-summary-130.md). Passing lexical checks
does not establish an accurate meeting note or Issue completion.

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
# Run the existing asset preparation steps; prepare:assets clears vendor/.
npm run prepare:assets
npm run prepare:translation-assets
npm run prepare:whisper-assets
npm run prepare:zipformer-assets
npm run prepare:optional-asr-assets
npm run prepare:tts-assets
npm run prepare:meeting-summary-assets
python3 scripts/review-meeting-summary-assets.py
npm run build:extension
npm test
npm run test:meeting-summary-real
# Installed Google Chrome instead of Playwright Chromium:
MEETING_SUMMARY_CHANNEL=chrome npm run test:meeting-summary-real
```

The review script downloads the exact selected files into `.cache`, checks
upstream LFS whole-file hashes and reproduces committed chunk manifests. Review
diffs before changing pins. The smoke serves these unchanged files over loopback
for Save, then makes Chrome offline before Start. Production graph, Worker,
runtime, cache and Live display are used; only the committed TEXT producer is
controllable. Fixtures in `tests/fixtures/meeting-summary.js` cover sequential
English/Japanese evidence, a proposal becoming a decision, corrected money,
completed invitations, repeated statements, pending venue approval and unknown
ownership. Deterministic tests validate state/lifecycle/port invariants separately
using Worker replies; those do not establish model quality.

See [Issue #130 evidence](evidence/meeting-summary-130.md) for actual measured
results and remaining validation boundaries. Subjective comparison and model
preference remain the user's later evaluation; there is no automatic winner.
