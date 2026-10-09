# Optional Qwen3 transcript correction

`SpeechTranscriptCorrectionNode` is an independent text processor for short
Japanese and English **final** ASR transcripts. It owns one native module Worker
and a local Qwen3 model. Its input and output are plain `TEXT` strings compatible
with the existing Pipeline and translation Nodes. It never consumes audio,
changes the recognizer, translates, or creates implicit graph connections.
Outputs are **candidates**, not verified transcriptions. Names, negation and
meaning can change despite the prompt. Keep the original visible and omit or
bypass the Node if it does not help. Synthetic examples are not evidence of
improved real ASR error rate.

## Model, runtime and distribution

The [ONNX model card](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/tree/1e0a4a196ecabdf9a879664110574563d3f372d3)
provides a Transformers.js WebGPU `q4f16` example. We use that concrete **0.6B**
checkpoint, not 1.7B, a server API, or another fallback model:

- Model/tokenizer: `onnx-community/Qwen3-0.6B-ONNX` at immutable revision
  `1e0a4a196ecabdf9a879664110574563d3f372d3`.
- `Qwen3ForCausalLM`, Qwen2 tokenizer and the pinned Qwen3 chat template.
  Its `enable_thinking: false` branch is used explicitly.
- Quantization: `onnx/model_q4f16.onnx`; float16 KV cache, 4-bit weights.
- Transformers.js **4.0.0-next.3**, bundled tokenizer **0.1.1** and Jinja
  **0.5.5**. ONNX Runtime Web **1.25.0-dev.20260212-1a71a5f46e**.
  These are the repository's existing verified runtime versions, staged
  independently in `web/correction-assets/` so translation/ASR ownership and
  Chrome extension assets do not acquire a correction runtime dependency.
- Runtime archive SHA-256 values are pinned in
  `scripts/prepare-correction-assets.py`; both archives are checked before
  replacing staged files. Runtime JS/MJS/WASM plus license total 27,771,302 bytes.
- Model assets total **578,918,281 bytes** (decimal MB), downloaded on explicit
  Generate/start only. The index, page import and bypass cause no model downloads.

| Asset | Bytes |
| --- | ---: |
| `onnx/model_q4f16.onnx` | 569,789,750 |
| `tokenizer.json` | 9,117,040 |
| `tokenizer_config.json` | 10,360 |
| `config.json` | 912 |
| `generation_config.json` | 219 |

`scripts/correction-assets.json` records all sizes and hashes. Run
`python3 scripts/review-correction-assets.py` to recheck the immutable HF API
metadata/LFS weight hash and downloaded small-asset checksums. The real smoke
records actual browser requests as a separate compatibility/privacy check.

The [upstream Qwen3 source](https://huggingface.co/Qwen/Qwen3-0.6B/tree/c1899de289a04d12100db370d81485cdf75e47ca)
declares **Apache-2.0**. The conversion card identifies that source and does not
declare an additional license. Apache terms permit local use and derived ONNX
weights; preserve the license, attribution and applicable notices and identify
modifications when redistributing. We distribute runtime code and the source
license, **not** weights. See `web/licenses/qwen3.txt` and
`web/third-party-notices.txt`. Transformers.js is Apache-2.0; ORT is MIT, with
existing license copies under `web/licenses/`.

Requires HTTPS/localhost, module Workers, WebGPU available **inside the Worker**,
and an adapter supporting **shader-f16**, with sufficient device memory for
weights, context and runtime buffers. Availability in `window` alone is not
sufficient. Unsupported browsers fail before fetching the inference runtime or
weights; there is no WASM or remote inference fallback. Chrome 154 on macOS with
an Apple GPU was used for the recorded local smoke. Other devices must be tested
rather than inferred from that result. Cross-origin isolation is not required
for this single-thread runtime.

Asset GETs use the pinned revision and Hugging Face asset/CDN redirects. Text
never enters a URL or request body. A processor-specific CacheStorage adapter
stores only that revision's assets, across fresh Workers and page sessions.
Cache hits avoid asset GETs. Storage/quota failure emits a visible warning and
allows local inference with the fetched model; subsequent runs may download
again. Caching/offline availability is **best effort**, not guaranteed. Remove
`qwen3-correction-1e0a4a196ecabdf9a879664110574563d3f372d3` from browser storage
to clear this Node's cache. Cancel releases the Worker/model immediately and may
leave already cached complete files; partial responses are not usable entries.

## Explicit composition and bypass

```js
import { Pipeline } from './pipeline.js';
import { SpeechTranscriptCorrectionNode, FinalTranscriptTextNode } from './correction-nodes.js';

// speech, originalTranscriptView, correctedTextView and translation are
// consumers/processors supplied by the application. No default graph changes.
const correction = new SpeechTranscriptCorrectionNode({
  language: 'auto',          // 'ja' or 'en' also supported; not input metadata
  enabled: true,             // false copies originals and creates no Worker
  onFailure: 'error',        // optional 'bypass' copies originals with a warning
  onEvent: event => console.log(event),
});
const graph = new Pipeline({
  nodes: { speech, originalTranscriptView, finalText: new FinalTranscriptTextNode(),
    correction, correctedTextView, translation },
  connections: [
    { from: ['speech', 'final'], to: ['originalTranscriptView', 'final'] },
    { from: ['speech', 'final'], to: ['finalText', 'final'] },
    { from: ['finalText', 'text'], to: ['correction', 'text'] },
    { from: ['correction', 'text'], to: ['correctedTextView', 'text'] },
    { from: ['correction', 'text'], to: ['translation', 'text'] },
  ],
});
await graph.start();
// Later: await graph.stop(); await graph.dispose();
```

The adapter only extracts `transcript.text`; it never mutates `{text, id}`.
Connect **final**, not provisional. Both ASR ports have the same transcript
contract, so choosing the final port is an explicit consumer graph policy.
Utterance IDs/alignment stay with original consumers. The Pipeline serializes
inputs and drains candidate delivery in order; the processor carries no generic
metadata. Downstream applications decide how candidates are presented/accepted.

To omit correction, connect the final-text adapter directly to text consumers.
`enabled: false` offers a direct bypass. With `onFailure: 'bypass'`, loading
and communication failures release the Worker, emit a `bypass` diagnostic,
pass the original text, and bypass remaining inputs in that session. Inference
and candidate format failures pass the original for that input with a visible
`bypass` diagnostic, retaining the Worker to allow the next input to succeed. This is explicit consumer policy; the default is a visible
failure
rather than substituting originals as successful corrections. Invalid input
contracts/overlong input still fail. Default graph startup failure aborts startup;
keep the consumer's original snapshot (as the Playground does), or opt into
bypass if the graph must start without the model.

Each instance/graph is single-use. `stop()` waits for queued inputs, Worker drain
and downstream delivery; `dispose()` / Pipeline cancellation terminates the
Worker, rejects pending RPCs and discards late replies. Repeat/retry creates a
fresh instance. No shared model owner, ASR change or extension graph change.

## Conservative policy and bounds

The maintained full prompt is `web/correction-policy.js`. It permits only minimal
apparent transcription fixes, instructs exact copying when uncertain, and
explicitly preserves language, meaning, numbers/figures, dates/times, names,
negation and speaker wording. It forbids paraphrasing, translation, invented
facts, completion and stylistic rewriting. The transcript is data in a separate user message; the system prompt
explicitly forbids treating it as instructions. It is not JSON-wrapped: early
evaluation found that this small model echoed JSON structure instead of plain
text. Role separation/prompting cannot guarantee resistance to prompt injection.

Input is at most **500 UTF-16 characters** and the entire chat prompt at most
**1,024 tokens**; excess is rejected rather than truncated. Empty/whitespace
input yields exactly one unchanged string without generation. The page rejects
empty input before starting the graph. Generation uses greedy decoding
(`do_sample: false`, `num_beams: 1`), at most **256 new tokens**, and explicitly
disables thinking through the verified chat template. Only continuation tokens
are decoded. A missing end-of-sequence token is rejected, so a truncated fluent
sentence cannot masquerade as a completed candidate.

Output must be a nonempty plain string of at most **1,000 characters**. Thinking,
chat/tool delimiters, code fences, newly introduced JSON/quote wrappers and
common response labels are rejected.
Changes to ordered numeric digit groups (including common dates/times/figures)
are rejected. These checks cannot prove response compliance, semantic fidelity,
proper-name spelling, written-out numbers or negation. They are limited
structural safeguards; the original remains necessary.

## Playground and validation

`web/nodes/qwen3-correction/` uses the real Node/Pipeline, with independent
original and candidate sinks, language selection, Generate, Cancel and bypass.
It shows load/generation/drain times, errors/cache warnings and a contiguous
changed span. All displayed model/input strings use `textContent`.

```sh
npm ci
npm run prepare:correction-assets
npm run serve
npm test
npm run test:browser -- --workers=2
npm run test:correction-real
```

The opt-in real smoke needs installed Chrome with usable WebGPU/shader-f16 and
makes a 579 MB download. It evaluates Japanese/English correct and intentionally
incorrect text plus exact-copy dates, figures, names and negations, and repeats
a fixture, using one production Worker through the Pipeline. Fixture identity
and reference text live in the test consumer, never processor inputs. It
records actual candidates, reference matches, corrections/misses/regressions,
load/inference time, cache events and GET-only traffic. The smoke asserts
runtime/privacy/lifecycle success, **not** a quality improvement threshold.
Quality is reported separately in [Issue #78 evidence](evidence/correction-78.md).

Deterministic tests mock only heavyweight inference/GPU capability, while
exercising the native production Worker protocol, typed ports, FIFO, drain,
cancel, repeat, error recovery, limits, format/numeric guards, cache hit/miss,
quota failure and Pages-prefix navigation. Other processor and extension checks
remain part of acceptance. Pages stages correction runtime after other assets;
weights remain on-demand. No correction runtime/weights enter the extension
package; the plain TEXT contract is shared without loading a model.

## Required post-merge verification

**Pending for #78 until performed.** Keep the Issue open. After merge record
successful Pages run URL, merged SHA and verification time. In a fresh deployed
origin browser, follow the canonical index link and verify nested HTML/app,
root Node/policy/contract/cache modules, the dedicated Worker, runtime JS/MJS/WASM,
notices and pinned asset resolution under `/my-audio-to-text/`. Verify errors,
Cancel, bypass and original/candidate display. If published-origin model access
differs from local tests, run real inference there and retain its results and
network evidence. Local prefix tests do not establish deployed revision or
published-origin model access.
