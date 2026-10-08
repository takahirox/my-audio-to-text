# Browser-local translation nodes (#65)

Checkpoint investigation preceded implementation. Each production processor has
a fixed direction and plain string input/output. The original OPUS-MT and
TranslateGemma nodes remain **Japanese → English**; #71 adds the independent
`EnglishToJapaneseOpusMtTranslationNode` and `opus-mt-en-ja-worker.js`. The
extension chooses one fixed Node before starting each session. TranslateGemma's underlying multilingual checkpoint
can represent other directions, but this node exposes only the verified direction.

| Node | Immutable checkpoint | Execution | Weight assets |
| --- | --- | --- | --- |
| OPUS-MT | `onnx-community/opus-mt-ja-en` at `05470cd69b62aa32e3ee64ccfd41279789ee4b1e` | Transformers.js translation/Marian, `q8`, WASM, one thread | `onnx/encoder_model_quantized.onnx` (50,681,158 bytes), `onnx/decoder_model_merged_quantized.onnx` (182,303,484 bytes) |
| OPUS-MT English → Japanese | `Kadonox/opus-tatoeba-en-ja-onnx` at `225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e` | Transformers.js translation/Marian, `q8`, WASM, one thread | `onnx/encoder_model_quantized.onnx` (52,875,078 bytes), `onnx/decoder_model_merged_quantized.onnx` (193,290,224 bytes) |
| TranslateGemma 4B | `onnx-community/translategemma-text-4b-it-ONNX` at `f7874a1ac60758872a4f78aac0df95b17b776994` | Transformers.js text-generation/Gemma3ForCausalLM, `q4`, WebGPU | `onnx/model_q4.onnx` (456,583 bytes), `onnx/model_q4.onnx_data` (2,097,115,648 bytes), `onnx/model_q4.onnx_data_1` (993,976,320 bytes) |

OPUS requires `config.json`, `generation_config.json`, `tokenizer_config.json`,
`tokenizer.json` (5,991,485 bytes), and `special_tokens_map.json` (optional
runtime lookup). SentencePiece/vocab source assets exist in the checkpoint,
but the converted tokenizer JSON is used by Transformers.js. TranslateGemma
requires config/generation config, tokenizer config (including its translation
chat template), and tokenizer JSON (20,323,013 bytes). Its external-data shard
count is declared in `config.json`. Approximate downloads are **239 MB** and
**3.112 GB**, respectively, plus the shared runtime. Memory requirements exceed
file size because sessions, tensors, GPU buffers and KV caches also occupy memory.

Runtime and tokenizer implementation are bundled in **Transformers.js
4.0.0-next.3** (bundled `@huggingface/tokenizers` 0.1.1 and
`@huggingface/jinja` 0.5.5, verified in the standalone bundle and reference
lockfile); **ONNX Runtime Web 1.25.0-dev.20260212-1a71a5f46e** is its exact
runtime dependency. `scripts/prepare-translation-assets.py` pins npm archive
SHA-256 hashes and stages the standalone bundled JS and matching asyncify MJS/WASM.
The selected ONNX Runtime build requires the **asyncify** loader for WebGPU;
its legacy JSEP loader lacks `webgpuInit` and must not be substituted.
There are no floating CDN runtime imports. This version follows the compatible
[browser proof of concept](https://github.com/webml-community/TranslateGemma-WebGPU/blob/main/src/ai/Translator.ts)
and its lockfile. The original `google/translategemma-4b-it` safetensors are not
browser ONNX assets; the chosen conversion removes the image tower. Only text is
accepted. The model-specific content object and pinned tokenizer chat template
supply `source_lang_code: 'ja'` and `target_lang_code: 'en'`.

## Attribution and distribution

[OPUS-MT ONNX model card](https://huggingface.co/onnx-community/opus-mt-ja-en)
and [Helsinki-NLP original](https://huggingface.co/Helsinki-NLP/opus-mt-ja-en)
identify **CC BY 4.0**. Credit Helsinki-NLP / OPUS-MT and ONNX Community for the
quantized conversion; retain attribution and the
[license](https://creativecommons.org/licenses/by/4.0/).

The English → Japanese Node uses the OPUS Tatoeba checkpoint, replacing the
older Bible-domain `Xenova/opus-mt-en-jap` model after ordinary-speech failures.
The [pinned conversion card](https://huggingface.co/Kadonox/opus-tatoeba-en-ja-onnx/blob/225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e/README.md)
identifies the Optimum ONNX export and Transformers.js compatibility. Its
[pinned Helsinki-NLP base card](https://huggingface.co/Helsinki-NLP/opus-tatoeba-en-ja/blob/3a282648cb991174f3c423e376aff3a13e5edaaf/README.md)
declares English (`eng`) input, Japanese (`jpn`) output and OPUS+backtranslation
training; the benchmark is Tatoeba English–Japanese. Both cards declare
**Apache 2.0**. Credit Helsinki-NLP / OPUS-MT and Kadonox's ONNX conversion.
Apache 2.0 permits use/modification/distribution under its conditions: retain
license/attribution and applicable notices and identify modifications when
redistributing derivatives. Public URLs are anonymous and ungated as reviewed;
no account agreement or token is needed. This project neither mirrors nor bundles
these weights. See the [Apache 2.0 terms](https://www.apache.org/licenses/LICENSE-2.0).

Its seven-file size and whole-file plus 1 MiB chunk SHA-256 list are committed in
[`extension/opus-mt-en-ja-assets.json`](../extension/opus-mt-en-ja-assets.json):
**252,634,769 bytes** (about 253 MB). Converted tokenizer JSON is 6,467,201 bytes;
config, generation config, tokenizer config and special tokens complete the set.
`scripts/review-opus-mt-en-ja-assets.py` explicitly downloads/reviews that pinned
revision, checks Hugging Face's file sizes/LFS hashes, then compares all bytes and
hashes against the committed manifest. It is not part of build/installation.
The Marian config/tokenizer declare English → Japanese; the quantized encoder
and merged decoder were verified with the unchanged pinned runtime before
selection, then tested through the production Node/Worker and extension cache
(see [#71 revision evidence](evidence/translation-direction-71-fixes.md)). New
model ID/revision keys cannot reuse the rejected checkpoint's cached bytes.
Neither direction is reversible, and no automatic language detection is performed.
The English → Japanese Worker recases fully uppercase Latin input from
ReazonSpeech to sentence case, including the pronoun I and weekday names;
mixed-case text and the displayed original are preserved. This case-sensitive
checkpoint mistranslates uppercase English without that preparation. The
opt-in smoke checks five ordinary English meanings in both normal and ASR
uppercase forms, including the greeting and meeting-time regressions, rather
than merely Japanese characters.
Machine translation can still make mistakes; these checks cover representative
snippets and do not claim universal accuracy.

[Google TranslateGemma](https://huggingface.co/google/translategemma-4b-it)
is subject to the [Gemma Terms of Use](https://ai.google.dev/gemma/terms) and
[Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy).
The [ONNX conversion](https://huggingface.co/onnx-community/translategemma-text-4b-it-ONNX)
has no license/model card of its own at the pinned revision; conversion does not
remove the upstream terms. Credit Google and ONNX Community. Google’s original
repository is gated; the selected public ONNX asset URLs currently allow anonymous
download. Availability is not a substitute for the upstream terms. This project
does not mirror Gemma weights, collect tokens, or accept account agreements.
If redistributing weights, follow the upstream notice, agreement and use
restriction requirements. Runtime licenses: Transformers.js **Apache-2.0**,
ONNX Runtime **MIT**; bundled upstream dependency notices continue to apply.

## Setup and capabilities

Run `npm ci`, `npm run prepare:assets` (speech), then
`npm run prepare:translation-assets`, then `npm run serve`.
Speech asset preparation recreates `web/vendor/`, so translation preparation must
follow it. Pages follows the same order. Translation weights are downloaded from
immutable Hugging Face `/resolve/<revision>/` URLs **only after Run**, with visible
progress. Requests contain model asset paths; input text remains in the dedicated
Worker and is never put in URLs, network bodies or a remote inference request.

OPUS needs Worker/module, WASM SIMD and BigInt support in a modern browser; it
uses one WASM thread and does not require cross-origin isolation. TranslateGemma
needs HTTPS/localhost, Worker WebGPU, a usable adapter and several GB of available
CPU/GPU memory. A browser exposing `navigator.gpu` does not establish device
compatibility: driver, limits, memory and runtime errors can still prevent loading.
There is no CPU fallback for TranslateGemma. Missing GPU/adapter errors occur
before its runtime or weight downloads. Model-load errors include guidance for
network, offline cache and device memory failures.

Browser Cache API caches downloaded model assets on a best-effort basis.
Quota failures or eviction require re-download. A fresh run owns a fresh Worker
and session; cached bytes may be reused, but models are initialized again. Cancel
terminates the Worker immediately, interrupting loading or GPU/WASM inference,
rejecting pending requests and discarding late results. No shared manager or
worker pool is involved. Closing/hiding via page teardown releases the graph.
Full offline use also requires local page/runtime assets; this page installs no
offline service worker and makes no unconditional offline guarantee.

Inputs are short snippets (up to 1,000 UTF-16 code units), with an additional
OPUS 512-token limit checked before inference. Generation is deterministic
(`do_sample: false`) with a 256-token output cap; longer translations may reach
that cap. This is a smoke/comparison surface for short text, not long-document
translation or a quality guarantee. Empty input emits zero outputs; nonempty
input emits one completed string. Playground requests are processed serially in
arrival
order through the Pipeline and worker queue. The extension wraps the same OPUS
node with a session-owned provisional/final scheduling adapter and verified
cache-only loading; see [the extension guide](chrome-extension.md). Worker responses
can contain zero
or multiple strings; the adapter emits each in order before completing receive.
Stop drains all receives and worker work before downstream sinks stop. Dispose
is immediate cancellation. Nodes/graphs are single-use, matching the runtime.

## Validation

`npm test` covers adapter ports/messages/order, multiple/zero outputs, load and
inference errors, drain, cancellation and Worker release. `npm run test:browser`
executes the production pages, nodes and worker protocol with only the model
runtime module replaced by deterministic fixtures, including repository-prefix
navigation. Those tests are **not real inference**.

Opt-in real inference (no mocks):

```sh
TRANSLATION_SMOKE=opus npm run test:browser -- tests/browser/translation-smoke.spec.js --project=chromium --workers=1
TRANSLATION_SMOKE=opus-en-ja npm run test:browser -- tests/browser/translation-smoke.spec.js --project=chromium --workers=1
TRANSLATION_SMOKE=gemma npm run test:browser -- tests/browser/translation-smoke.spec.js --project=chromium --workers=1
```

These download the specified model sizes. The Gemma smoke requires a working
WebGPU device; use `TRANSLATION_HEADED=1` if the local headless browser has no
hardware adapter, or `TRANSLATION_CHANNEL=chrome` to use installed Chrome
with its hardware WebGPU backend. No browser flags are required by the product.
Results record browser/capability, fixture, output and load/run
latencies. The English → Japanese smoke asserts expected meaning for five
ordinary English meanings in normal and uppercase forms on two fresh Workers each. Other nonempty-output
smokes verify execution only. Device skips, failed loads and unperformed checks must be reported;
see [Issue #65 evidence](evidence/translation-65.md).

## Required post-merge verification

**Pending.** After merge/deployment, record deployed SHA, successful Pages run URL
and time. Visit the index and both `/nodes/opus-mt/` and `/nodes/translategemma/`
pages on `https://takahirox.github.io/my-audio-to-text/`, verify navigation, all
modules/workers and `vendor/translation/` assets retain the repository prefix,
and run the real-model smokes on that origin if fetch restrictions differ.
Use `ASR_BASE_URL=<published URL>` with the commands above. Local checks do not
establish that this revision was deployed. Do not close #65 until required
verification is performed and recorded.


## Issue #71 post-merge verification

**Pending.** After merge, verify GitHub Pages deployed the merged SHA and record
successful workflow run URL, deployed SHA, UTC time and results in
[evidence/translation-direction-71.md](evidence/translation-direction-71.md).
Open the canonical new page
`https://takahirox.github.io/my-audio-to-text/nodes/opus-mt-en-ja/` from the index;
verify `app.js`, shared modules, `opus-mt-en-ja-worker.js`, packaged runtime URLs
and immutable model URLs. All page/worker/runtime URLs must preserve
`/my-audio-to-text/`. Run the opt-in `TRANSLATION_SMOKE=opus-en-ja` with
`ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/` on the deployed origin
if needed. Local prefix checks do not establish deployment. Do not close #71
until this verification is recorded. The unpacked extension has no deployment gate.
