# Issue #389 validation

The two Summary nodes are replaced by `TextProcessingLfm2` and
`TextProcessingQwen35`. They accept Settings `prompt` and `inputCount` (1–32),
numbered TEXT inputs and a single complete `result: TEXT`. Legacy types are
rejected with explicit repair instructions; original JSON remains available.
Historical module, playground URL and asset/cache paths are retained.

Validation in the assigned worktree:

- `npm ci`: succeeded.
- `npm test`: **996 passed, 0 skipped** after runtime staging. Includes atomic
  groups, duplicate events, missing inputs, FIFO snapshots under delayed inference,
  direct multi-input Hold feedback, Stop, Cancel/late replies, load/generation
  timeouts, failures, prompt roles/escaping, bounds, separate Worker ownership,
  persistence, removed-port validation and Subgraph exposures.
- Chromium browser checks: **94 distinct tests passed** across
  `model-playground.spec.js`, `playground-assets.spec.js`,
  `graph-ai-presentation.spec.js`, and `graph-quick-add.spec.js`.
  The broad run passed 93; its remaining palette search fixture was changed from
  “summary” to “processing” and passed the focused rerun. These include all four
  task examples and atomic two-input Playground requests for both models.
- Chromium MV3 checks: **28 distinct tests passed** across
  `graph-text-summary.spec.js`, `graph-hold-feedback.spec.js`,
  `graph-model-failures.spec.js`, `graph-actions.spec.js`,
  `live-model-preparation.spec.js`, `live-text.spec.js`, and
  `graph-translation-feedback.spec.js`. The broad run passed 27; its remaining
  Live TEXT observer fixture was updated to retain the new `inputs` RPC payload
  and passed the focused rerun. Tests cover the production Worker with a
  controlled tokenizer/model, exact system prompts, numbered escaped user data,
  token/output errors, shader-f16 errors, cache reuse, UI Undo/Redo/Auto Save,
  explicit stale-wire removal and recovery/import of all four historical types.
- All five checked-in processing example graphs pass `assertGraph`.
- `npm run prepare:playground-assets`: succeeded; stages pinned runtimes and
  manifests only, without model weights.
- `npm run build:extension`: succeeded; **227 packaged files, no model weights**.
- `git diff --check`: passed.

No real-model GPU inference or model quality/speed evaluation was performed.
The opt-in `TEXT_SUMMARY_SMOKE=1` suite now also records proofreading, extraction
and two-input comparison using the pinned models, in addition to summary and
feedback cases. Deterministic outputs verify transport/lifecycle, not accuracy.
WebKit was not run. Historical #130/#202/#210 evidence is not new validation.

Model IDs, immutable revisions, q4f16/device choices, model asset manifests,
chunk hashes, cache URLs and packaged licenses remain unchanged. Runtime
staging and `dist/` are generated ignored artifacts; a fresh checkout must stage
runtimes before building. No model weights were downloaded for these checks.
