# Experimental PLaMo 3 Translate 2B (#385, #391, #395)

Add **Translation**, model subtitle **PLaMo 3 Translate 2B**, in
AI Models / Translation. Search by translation, PLaMo or the internal stable
type `Plamo3Translate2B`. This is an experimental Node; TranslateGemma and the default graph remain available with their existing models.

Connect text to `text: TEXT`. Optional ordinary Text constants configure:

| Port | Unconnected default | Accepted connected values |
| --- | --- | --- |
| `context: TEXT` | no reference context | reference TEXT; empty omits the section |
| `source_lang: TEXT` | automatic identification | `auto` or any of the 53 official codes |
| `target_lang: TEXT` | Japanese/English auto switch | `auto` or any of the 53 official codes |

Use exact lowercase codes from the [official supported-language table](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/blob/4f672106b847200bfdc0f6af6c321cd94eba1aed/README.md#supported-languages):

```text
ja en zh-hans zh-hant ko ar az be bg bn ca ceb de es et eu fa fr gu he hi hr
hu hy id it jv ka kk km lt lv ml mr ms my ne nl pa pl ru si sk sl sr sw ta te
th tl ur uz vi
```

Simplified Chinese (`zh-hans`) and Traditional Chinese (`zh-hant`) are distinct.
The Node accepts these 53 codes and `auto`, without trimming, case folding,
region-code conversion or aliases. This matches explicit GGUF template kwargs;
the template's system-message parser also supports lowercase normalization, but
this Node sends PFML3 directly and does not use that parser. Blank connected
values, unknown codes, `zh`, `zh-CN`, `en-US` and uppercase codes are errors.
The template's extra Easy Japanese alias is outside this Node's 53-code contract.

With both language ports unconnected, Japanese input translates into English and
English input into Japanese. Explicit `target_lang=auto` selects the same GGUF
behavior. For other input languages the default output language is **undefined**:
connect a concrete target (for example `fr → ja`, `ko → en`, `zh-hans → ja`).
The application adds no language detection or fallback. A concrete source language
requires a concrete target; source `auto` is equivalent to omission. To keep output
in English, connect `Text('en').value → target_lang`.

For example, `Text('en').value → source_lang` and
`Text('ja').value → target_lang` configure English → Japanese. Language and context events
never request translation. A text or provisional event accepts an immutable
snapshot of context, languages and ID; changing context or a language while a job
is loading, running or queued affects subsequent jobs. Grouped delivery applies configuration
before text regardless of key order, and omitted connected configuration siblings
restore defaults. Independent producers follow arrival order, without pretending
to be an atomic group. Blank, whitespace, uppercase or unsupported connected
values produce explicit configuration errors. Correcting the ports recovers
subsequent jobs. There are no context, language, direction or model Settings controls.

Optional `context` is reference information, kept separate from the source text.
For example, connect `Moonshine.final → PLaMo.text`, a separate
`Text.value → PLaMo.context`, and `PLaMo.text → Display.input1`. Try
`かみを切りました。` as text with `折り紙を作っています。` as context, then clear
context and compare. This can help disambiguation; improved translation quality
is not guaranteed. Multiline Japanese, quotes, `<xml>` and other ordinary special
characters are preserved verbatim. Unconnected or empty context uses exactly the
previous context-free prompt. Whitespace-only context is nonempty, matching the
official template's explicit context kwarg. Context does not select a language or
load another model. It is neither added to the source nor wrapped in custom instructions.

Context has an independent 8,000 UTF-16-unit transport bound. This is **not** a
token-budget guarantee: every full PFML3 prompt is evaluated by the embedded GGUF
runtime with [`max_tokens: 0`](https://github.com/ggml-org/llama.cpp/blob/7d7f0287530bc8981690f361d8c1627dbae1c99a/tools/server/server-schema.cpp#L46),
which generates no output and returns the actual
`usage.prompt_tokens`, including BOS. More than **1,792 prompt tokens** is an
explicit error, reserving **256 output tokens** within `n_ctx: 2048`. Generation
reuses that evaluated prompt cache; context shifting is disabled. Prompts exceeding
the runtime context itself are rejected by llama.cpp. Missing/inconsistent token
counts, output limits and inference failures produce errors, never successful
truncated output. Shorten context or source text to recover. Context containing
`<|plamo:` or `<|endoftext|>` is rejected rather than escaped or silently altered.
Invalid context snapshots report through `error` / `provisionalError` with their
source and ID; later corrected jobs recover. Context-only updates do not infer.

The shared translation scheduler owns the committed FIFO, replaceable provisional
job, IDs, output groups, Stop drain, Cancel cleanup and owned Worker. It emits the
existing `text`, `source`, `error`, `id` family and separate provisional family.
Configuration errors travel with the affected source/error; they do not masquerade
as translated text. Provisional inputs cause separate inference jobs. Generated
tokens are not live revisions of an input; this Node publishes complete strings.
Short snippets are limited to 1,000 UTF-16 units and 256 generated tokens. An output
token-limit error asks the user to split the text instead of accepting truncation.

## Runtime and assets

The official [2B GGUF distribution](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF)
is pinned at `4f672106b847200bfdc0f6af6c321cd94eba1aed`, including its tokenizer and
chat template. Only `plamo-3-translate-2b-Q4_K_M.gguf` is selected:
**1,807,203,040 bytes**, whole-file SHA-256
`1ffd9073afcc70e35ccc942428aa2b73d7aa2b9ea779bf504b775369e0276c13`.
The committed manifest contains every 1 MiB SHA-256 digest. The existing
`ModelAssetCache` verifies streams, caches bytes in the browser origin, tracks
progress, supports cancel/retry, detects corruption/eviction, and retains Worker
leases so cached files cannot be deleted during inference.

Save/Live preparation and the single Models card use the same manifest. Extension
inference is cache-only. Playground Run downloads missing verified bytes on demand;
merely opening a page or editing language/context fields does not download weights.
The GGUF Blob is read via Wllama's async file ABI without a whole-file JS
ArrayBuffer. No weights or preload data enter the extension artifact. Cache
eviction, restricted/private storage, quota and device memory can require retry.
Allow about 5 GB storage and 6 GB free RAM per active Node (conservative estimates).

**Wllama 3.13.0**, npm archive SHA-256
`a9eaac205ff9a1d6fdbea395a48652bd5febc56511a7b66b736d862bf726d2d5`, contains
llama.cpp `b12211-7d7f028` (`7d7f0287530bc8981690f361d8c1627dbae1c99a`).
`prepare-plamo-assets.py` converts its generated Blob Worker into a packaged static
module at build time and forwards nested Worker failures to pending RPCs. This
reviewed adaptation runs single-thread CPU WASM (`n_gpu_layers: 0`, context 2,048),
with the embedded GGUF tokenizer. Desktop Chromium with WebAssembly JSPI is required;
unsupported browsers fail before downloading. Both the extension CSP and the
Playground CSP keep `worker-src 'self'` and `wasm-unsafe-eval`; no Blob worker
permission, remote executable code, native host, inference server or remote AI API
is required. Cancel terminates the outer Worker and its WASM child. Runtime files
are individually pinned in the extension packaging allowlist.

Direct [official PFML3](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/blob/4f672106b847200bfdc0f6af6c321cd94eba1aed/README.md#pfml3-prompt-format)
supplies `dataset → context (when nonempty) → input → output` sections. With a
concrete target, automatic source identification omits input `lang`, an explicit source adds that exact code,
and output `lang` is the chosen target. With omitted/auto target, input carries
`lang=ja/en` and output has **no** `lang`, matching the official GGUF template.
This is a model instruction, not application-side language detection. llama.cpp
adds BOS, so the handwritten prompt omits it. Reserved model control tokens in
source and context are rejected.

The official GGUF default changed on **2026-11-08** from fixed Japanese output to
Japanese/English switching. The pinned revision already contains this behavior;
no revision, hash, manifest or cache migration is needed. The ordinary Transformers
API requires a target and is a different interface from this GGUF Node.
The unmodified official template is retained as `web/plamo-chat-template.jinja`,
SHA-256 `ad7eb87b161c6792be070d777a9f9da50c9e57a77e1fa5cca3a24b91b6bdb9e9`.
MLX is a separate native distribution and is not a dependency of this browser Node.

## Terms and attribution

**Built with PLaMo**, developed by Preferred Networks with the NICT base model.
Models and Playground link the full pinned [English](../web/licenses/plamo-community-en.txt)
and [Japanese](../web/licenses/plamo-community-ja.txt) PLaMo Community License,
revised November 9, 2026. They show a visible pre-use notice. Commercial use under
this license requires prior PFN registration and annual revenue/sales no greater
than one billion yen; otherwise a separate PFN license is required. Redistribution,
attribution, output, derived-model and use restrictions also apply. Free project
distribution does not remove those terms. This project does not register on a
user's behalf or redistribute weights.

Wllama and llama.cpp use MIT licenses. Full notices and additional upstream vendor
notices are retained in [runtime terms](../web/licenses/plamo-runtime.txt).
The model license has different conditions from the inference runtime licenses.

## Reproduction and checks

`npm run prepare:plamo-assets` stages only the pinned runtime and cache reader.
`npm run setup:extension` includes it. `npm run prepare:playground-assets` stages
all independent pages' runtimes; `npm run serve` serves the Playground. Open
`/nodes/plamo-3-translate-2b/` without installing the extension. Leave source and
target omitted for Japanese → English and English → Japanese. Enter source `fr`,
target `ja` for French → Japanese, or source `ko`, target `en` for Korean → English.
The optional context textarea runs through the same Node and PFML3 builder as
the graph; clear it and Run again to compare. Empty language fields mean omission;
whitespace is a connected invalid language value.

Default CI uses deterministic production scheduler/Worker/UI/cache tests with tiny
fixtures, without real weights. `npm test` covers language validation, grouped
delivery/omissions, queued snapshots during async loading, configuration-only
updates, context changes/clears, reserved-token rejection, actual token-budget
checks, Text.value connections, IDs, previews, error routing and lifecycle.
`npm run test:playground` includes PLaMo native Worker/cache tests. Extension tests
cover the palette, sparkles, inspector, save/reload, Models and production Worker.
Existing translation and graph regression tests remain in place.

Opt-in real checks, without approval prompts:

```sh
npm run prepare:playground-assets
npm run test:plamo-real
npm run build:extension
PLAMO_EXTENSION_SMOKE=1 npx playwright test --config playwright.extension.config.js tests/extension/plamo-smoke.spec.js
```

The first command stages code only. The real web test downloads 1.81 GB on first
Run, uses a dedicated disk-backed Chrome profile in ignored `.cache/`, exercises
both default directions, explicit auto and fixed targets, French/Korean/Simplified
and Traditional Chinese, cancels actual inference, checks both Workers disappear,
and retries from cache. The extension smoke automatically obtains the official
GGUF if needed, serves only its verified bytes from loopback to avoid a second WAN
download, and exercises the packaged graph/runtime under MV3 CSP and COOP/COEP.
Its test-only `sourceURL` override changes asset delivery, never inference or hashes.
`python3 scripts/review-plamo-assets.py` independently checks the upstream pinned
LFS hash, every committed chunk, the embedded GGUF template against the packaged
template, and both license files. Timings and exact
generated strings are recorded in real-model evidence.

To reuse that verified local GGUF in the standalone smoke without another WAN
download, run:

```sh
PLAMO_SMOKE_GGUF=.cache/plamo-review/plamo-3-translate-2b-Q4_K_M.gguf npm run test:plamo-real
```

The test serves static bytes on loopback and changes only the manifest's delivery
URL; the production hashes, immutable cache key, Worker and inference stay intact.

`tests/fixtures/plamo-template.json` records prompts rendered by the pinned official
Jinja template, including native context boundaries and multilingual/special-character
references (Jinja2 3.1.6, `trim_blocks`/`lstrip_blocks`, empty BOS). Tests compare
the template digest, representative prompts and a digest covering all 53 codes as
both source and target against the production PFML3 builder. To regenerate it,
install `Jinja2==3.1.6` in an isolated review environment and run
`python scripts/render-plamo-template-fixtures.py`; normal CI needs no Jinja package.
See [#391 validation evidence](evidence/plamo-391.md) for actual model results.

## Post-merge validation for #395

Human real-model/device quality checks for native context are **pending**. They
are post-merge validation, not a Draft removal, approval or merge requirement.
Normal automated checks use tiny deterministic runtime fixtures and require no
GGUF download. After merge, compare the ambiguity example above with and without
context, check that reference information is not copied into the translation,
and try multiline/special-character references on a supported Chromium device.
Record actual output and timing; create a follow-up Issue if a defect is found.
The earlier #385/#391 evidence does not establish #395 context quality.
