# Local live meeting summaries

Issue #130 adds two independent processors under **Add node → Processors**:
**Meeting Summary · LFM2.5 1.2B JP** and **Meeting Summary · Qwen3.5 2B**.
Each accepts committed `text: TEXT` and emits one complete `summary: TEXT`.
Both use real local inference with bounded, extractive note reconciliation.
See the [current factual smoke and its boundaries](evidence/meeting-summary-130.md)
before relying on model output.
Connect `ASR.final`, `TextWindow.text` or `Text.value` to `text`, then `summary`
directly to `LiveTextDisplay.content`. Stop/Cancel retain the last successful note;
no accumulator is needed for complete summary snapshots. Other TEXT
consumers are compatible. Translation, ASR and transcript displays can fan out
independently. There is no global model selection or preferred model.

The only setting is **language**: `ja` (Japanese) or `en` (English). The summary
language need not match the transcript. Each session freezes settings; saving
edits during a session changes the next session. These processors use the same Graph v10 content contract as other snapshot producers;
saved v9 replace-only summary displays migrate directly without an accumulator.

## Incremental behavior

The first pending committed fragment starts a 30-second timer. At 2,000 UTF-16
code units, or when the timer expires, the Node sends **only the previous
successful summary and the new batch**. The 2,000-code-unit size is a trigger
and packing target: batches keep committed fragments whole so that negation or
conditions cannot be separated from their claims. A single oversized fragment
is processed intact within the 32,768-code-unit backlog cap; the Worker divides
it only at sentence/speaker boundaries, retaining continuation context. An
excerpt exceeding the prompt, output or note budget fails explicitly without
truncating evidence or publishing a partial snapshot. Fragments retain order
and repeats; adjacent fragments get a newline. Empty/whitespace-only inputs do
nothing. Input is committed evidence:
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

The Worker keeps the previous successful note as at most **32 evidence-linked
records**, with a **12,000-code-unit** total for source anchors, rendered text and
speaker labels, and a **6,000-code-unit** visible snapshot. It splits only the
new batch into short excerpts (at most 32 model calls before repairs). The local
model renders these excerpts in the requested language; it never rewrites the
whole old note. Source speaker labels are preserved separately from model text
and identify the speaker, not an inferred task owner. Explicit unknown ownership
and pending approval remain visible. Sections are assembled in code, including
completed work when reported. No fixture-specific content or canned summaries
are used.

Conservative English/Japanese source cues distinguish proposals, explicit
decisions, open work, questions and reported completion. Negation (including
English contractions and Japanese copular negatives such as `承認済みではありません`)
and conditional language prevent promotion to a confirmed
decision or completed task. Compatible records with unambiguous matching subject
words are updated; unrelated or tied matches are retained separately. Explicit
withdrawals and corrections can move a former decision or completion back to open
work. Clear same-subject approval/completion assertions also replace the previous
status without a correction keyword. Without an explicit correction, questions
and conditions stay separate; matching distinguishes approving a draft from
sending it. Subject matching checks both keyword sets, so a report and its
appendix remain separate. Shorter reaffirmations with omitted scope also stay
separate, retaining the earlier dated, budgeted decision. Different or missing
speaker labels retain separate records for reaffirmations, corrections and
status transitions, so one person's action cannot overwrite another's. Changed
unlabelled first-person statements also stay separate because their actor is
unknown; exact repetitions can still deduplicate.
Labels must match exactly across languages: `Mika` and `ミカ` are retained as
separate speakers because transliteration alone does not establish identity.

An explicit numerical correction patches only an identified quantity in both
the source and its rendering, preserving unrelated equal numbers and dates.
If the correction also changes approval/completion or makes it uncertain, the
new status evidence replaces the old sentence rather than inheriting its status.
Ambiguous targets retain the evidence with a visible **Correction target unclear**
label (Japanese: **訂正対象不明**); a matched record with an ambiguous correction
moves to discussion rather than remaining confirmed. A completed task replaces
its matching open item without overwriting a decision about the same object.
New records and replacements are committed only after the entire batch succeeds.

Evidence is a separate user message with escaped chat delimiters. Short rendering
instructions differ for the two models based on actual-model checks; Qwen uses
an English instruction for Japanese terminology. These are not instructions from
the transcript. They do not guarantee obedience or resistance to prompt injection.

This is **lossy history compression**, not semantic verification. Source-cue and
lexical matching can miss paraphrases, combine overly similar topics, leave stale
or duplicate items, misclassify unfamiliar phrasing, or lose a fact in translation.
When memory is full, older discussion/completed items are evicted first, then
older remaining items; the Live status reports the omission count. Earlier facts
cannot be recovered from this bounded note. Keep an independent transcript when
exact evidence matters and verify decisions and owners against it. Passing the
recorded fixtures is not a general factual-accuracy or quality guarantee.

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
prefill or a repetition penalty. Each excerpt allows up to 1,024 new tokens;
exhausted output budgets are errors, never successful truncated snapshots.
Prompt plus output is checked against an 8,192-token application budget without
silently truncating evidence. LFM's published card specifies 32,768 context
(its config says 128,000); Qwen config specifies 262,144. Temporary generation
caches are released after each excerpt; only the bounded note records persist.

Before accepting an excerpt, lexical checks reject unsupported speaker-style
labels, explicitly superseded numbers and unreported completion claims. Numeric
values and named weekdays must survive rendering without omission, introduction
or scale changes. Calendar translation hints preserve weekdays; equivalent
Japanese-unit spellings and English month names are recognized. These
checks can conservatively reject legitimate number-word or unit conversions.
A rejected excerpt permits at most two repair generations with unchanged evidence
and repair instructions in the system message. All excerpts and repairs share the
same 180-second request deadline and bounded pending-text queue. A failed excerpt
publishes no partial batch and leaves the previous note intact. Metrics record
per-call/total token counts, first decoded-token time, total inference time and
history omissions. The first-token progress event is internal Worker telemetry,
not a public graph Port.

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
