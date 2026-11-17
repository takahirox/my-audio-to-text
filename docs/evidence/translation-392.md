# Unified TranslateGemma 4B (#392)

Implemented one `TranslateGemma4B` graph type, visible as **Translation** with
**TranslateGemma 4B** beneath it. Source/target TEXT ports default explicitly to
`ja`/`en`. One loaded Worker accepts per-request languages; the model revision,
q4/WebGPU options, manifest, integrity verification and cache identity are unchanged.

Saved version-15 directional graphs upgrade on read/import. EN→JA gains ordinary
Text constants; JA→EN retains its defined defaults. IDs, positions, context,
existing edges and exposed subgraph ports survive. Normal edits persist the
canonical graph without keeping legacy runtime types.

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
  offline verified cache, errors, Cancel, recovery and legacy save/reload.
- MV3 graph-models and translation-ports suites: 14 passed. Includes existing
  ASR → translation → independently keyed history/Display behavior.
- Browser AI presentation/quick-add suites: 23 passed.
- Opt-in pinned tokenizer smoke: one passed; no inference or weight download.
- `git diff --check`: passed.

Real-model WebGPU inference was not run. The opt-in browser and MV3 smoke tests
now exercise ja→en, en→ja and fr→de using the same loaded checkpoint. Default CI
uses deterministic inference fixtures, including the new MV3 TranslateGemma suite.
