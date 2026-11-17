# PLaMo native context validation (#395)

Implemented optional `context: TEXT` on the existing `Plamo3Translate2B` Node
and standalone Playground, without context Settings or changes to model assets,
languages, automatic Japanese/English switching, cache identity or licenses.

Nonempty reference text occupies the official PFML3 context section between
dataset and input. Empty context preserves the previous prompt byte for byte.
The committed Jinja oracle now includes empty, Japanese, multiline, whitespace
and special-character contexts; the official template and its digest are unchanged.

PLaMo validates context independently of TranslateGemma. An 8,000 UTF-16-unit
transport bound supplements the actual prompt budget: the pinned Wllama/llama.cpp
runtime evaluates/cache-primes each complete prompt with `max_tokens: 0`, then
reports `usage.prompt_tokens` including BOS. Generation is admitted only at
1–1,792 prompt tokens, reserving 256 tokens within the unchanged 2,048-token
context. Context shifting is disabled; missing/inconsistent counts, overflows,
reserved controls, inference failures and output limits produce explicit errors.
The pinned runtime documents zero-token prompt evaluation in
[server-schema.cpp](https://github.com/ggml-org/llama.cpp/blob/7d7f0287530bc8981690f361d8c1627dbae1c99a/tools/server/server-schema.cpp#L46).
PLaMo request errors stay with the affected job and allow subsequent jobs to
recover on the same Worker; fatal Worker/load failures still stop that session.
TranslateGemma's existing invalid-update admission behavior is retained.

Automated checks on 2026-11-17:

- `npm test`: 926 passed.
- `npm run test:playground -- --workers=2`: 233 passed, 5 skipped (PLaMo's
  unsupported WebKit project); production Workers and tiny verified cache/runtime
  fixtures, with no model downloads.
- `npx playwright test --config playwright.extension.config.js tests/extension/plamo.spec.js tests/extension/translategemma.spec.js`:
  14 passed. Covers the context port, save/reload, Models, native Worker transport,
  reference/empty/context-only updates, token/injection errors and recovery,
  existing language switching, cache reuse and lifecycle behavior.
- `npm run build:extension`: 220 packaged files verified, zero model weights.
- Official-template fixtures regenerated with isolated `Jinja2==3.1.6`.

Unit coverage includes FIFO/loading/inference snapshots of context/languages/ID,
grouped text+metadata and omissions, updates/clears, preview replacement,
Stop draining and preview cleanup, Cancel/load/inference and late replies,
per-job error routing/recovery, all 53 languages and both default directions.
Runtime fixtures independently supply token counts, including the 1,792/1,793
boundary; these establish error/transport contracts, not translation quality.

Human real-model/device quality validation for #395 is **pending**, to be done
**after merge**, without making it a Draft removal, approval or merge condition.
Compare `かみを切りました。` with and without `折り紙を作っています。`, inspect
reference leakage and try multiline/special-character context on supported
Chromium. Record actual results and file a follow-up Issue for any defect.
No real-model quality improvement is claimed by these deterministic tests.
