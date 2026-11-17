# Unified TranslateGemma 4B (#392)

Implemented one `TranslateGemma4B` graph type, visible as **Translation** with
**TranslateGemma 4B** beneath it. Source/target TEXT ports default explicitly to
`ja`/`en`. One loaded Worker accepts per-request languages; the model revision,
q4/WebGPU options, manifest, integrity verification and cache identity are unchanged.

Old directional Node types are unsupported and receive no migration. Users
recreate graphs with the unified Node and explicit language ports as needed.
Unified-node save/reload retains language connections, context, IDs and wiring.

## Upstream verification

The pinned `chat_template.jinja` was fetched and checked against the existing
manifest: SHA-256 `5e85514635b80a62b64c9982810bfdfbdd482be9a59ed12c25ded2bf3aabddaf`.
Its exact 581-code language-name map is used for validation and context prompts.
This is a tokenizer vocabulary, not a claim that every pair has been evaluated;
Google describes the model as designed for 55 languages. Both source and target
are required, so the product retains explicit ja→en defaults without detection.

Only the five non-weight tokenizer/config assets were downloaded for the optional
tokenizer smoke, with byte lengths and hashes verified against the manifest.
That smoke passed using the actual pinned Transformers.js tokenizer: the full
language map and context-free/context prompt equivalence were checked for ja→en,
en→ja, fr→de and en_GB→zh_Hant, alongside the existing token/safety probes.

## Validation

- `npm test`: 919 passed.
- `npm run build:extension`: 220 packaged files verified, zero model weights.
- `npm run test:playground`: Chromium 118 passed; WebKit 114 passed and four
  PLaMo tests skipped as intended for its Chromium-only runtime. WebKit was
  installed after the initial attempt reported its missing test executable.
- Final translation/PLaMo browser rerun after the Playground ownership fix:
  20 passed, four intended WebKit skips.
- MV3 TranslateGemma plus graph port-order suites: 14 passed. Includes three
  language pairs on one loaded production Worker, immutable queued contexts,
  offline verified cache, errors, Cancel, recovery and unified-node save/reload.
- MV3 graph-models and translation-ports suites: 14 passed. Includes existing
  ASR → translation → independently keyed history/Display behavior.
- Browser AI presentation/quick-add suites: 23 passed.
- Opt-in pinned tokenizer smoke: one passed; no inference or weight download.
- `git diff --check`: passed.

Real-model WebGPU inference was not run. The opt-in browser and MV3 smoke tests
now exercise ja→en, en→ja and fr→de using the same loaded checkpoint. Default CI
uses deterministic inference fixtures, including the new MV3 TranslateGemma suite.

## Review fixes and revalidation

Removed the directional TranslateGemma graph conversion and its compatibility
fixtures/tests. Unified-node persistence is covered by saving/reloading a graph
with connected language, context and ID ports, then executing that reloaded graph;
exposed subgraph ports also round-trip. Old directional types use ordinary unknown
Node validation and require graph recreation.

Integrated main `73d58a5d931e55c768880794011fbf9a2a206582`, resolving conflicts in
translation documentation, graph definitions, model cards, presentation tests and
the Playground index. Main's multilingual PLaMo behavior and its separate model
card remain intact alongside the unified TranslateGemma Node.

Checks after these fixes:

- `npm test`: 919 passed, one skipped, zero failures.
- Chromium browser suites `translation.spec.js`, `plamo.spec.js`,
  `graph-ai-presentation.spec.js`, `graph-quick-add.spec.js`: 35 passed. The first
  run passed 31 tests but failed four PLaMo tests because runtime cache helpers
  had not been staged in this fresh worktree. After
  `npm run prepare:playground-assets` (runtimes only), all four PLaMo tests passed.
- MV3 suites `translategemma.spec.js`, `plamo.spec.js`, `graph-models.spec.js`,
  `translation-ports.spec.js`, `graph-port-order.spec.js`: 29 passed.
- `npm run build:extension`: 220 packaged files verified, zero model weights.
- `node --test tests/model-distribution.test.js`: three passed.
- `git diff --check`: passed.

Real-model WebGPU inference remains unperformed. The review question requesting
browser/GPU details and ja→en, en→ja and fr→de logs from one loaded pinned
checkpoint remains open for human review after publication.
