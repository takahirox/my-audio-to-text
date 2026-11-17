# Experimental PLaMo 3 Translate 2B (#385)

Add **Translation · JA ↔ EN**, model subtitle **PLaMo 3 Translate 2B**, in
AI Models / Translation. Search by translation, PLaMo or the internal stable
type `Plamo3Translate2B`. This is one additional experimental Node; OPUS-MT,
TranslateGemma and the default graph remain available with their existing models.

Connect text to `text: TEXT`. Optional ordinary Text constants configure:

| Port | Unconnected default | Accepted connected values |
| --- | --- | --- |
| `source_lang: TEXT` | automatic identification | `auto`, `ja`, `en` |
| `target_lang: TEXT` | English | `en`, `ja` |

For example, `Text('en').value → source_lang` and
`Text('ja').value → target_lang` configure English → Japanese. Language events
never request translation. A text or provisional event accepts an immutable
snapshot of the current languages; changing a language while a job is loading,
running or queued affects subsequent jobs. Grouped delivery applies configuration
before text regardless of key order, and omitted connected configuration siblings
restore defaults. Independent producers follow arrival order, without pretending
to be an atomic group. Blank, whitespace, uppercase or unsupported connected
values produce explicit configuration errors. Correcting the ports recovers
subsequent jobs. There are no language, direction or model Settings controls.

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
merely opening a page or editing language fields does not download weights.
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

Direct [official PFML3](https://huggingface.co/pfnet/plamo-3-translate-2b#pfml3-prompt-format)
supplies the dataset, input and output sections. Automatic source identification
omits the input `lang` key. The output **always** includes the chosen/default `lang`
key, so the upstream GGUF target-default change on 2026-11-08 cannot change this
Node's behavior. Reserved model control tokens in source text are rejected.
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
target omitted for Japanese → English; enter source `en`, target `ja` for the
reverse, or source `auto`, target `ja` for automatic identification.

Default CI uses deterministic production scheduler/Worker/UI/cache tests with tiny
fixtures, without real weights. `npm test` covers language validation, grouped
delivery/omissions, queued snapshots during async loading, configuration-only
updates, Text.value connections, IDs, previews, error routing and lifecycle.
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
all three language cases, cancels actual inference, checks both Workers disappear,
and retries from cache. The extension smoke automatically obtains the official
GGUF if needed, serves only its verified bytes from loopback to avoid a second WAN
download, and exercises the packaged graph/runtime under MV3 CSP and COOP/COEP.
Its test-only `sourceURL` override changes asset delivery, never inference or hashes.
`python3 scripts/review-plamo-assets.py` independently checks the upstream pinned
LFS hash, every committed chunk, template and both license files. Timings and exact
generated strings are recorded in [real-model evidence](evidence/plamo-385.md).
