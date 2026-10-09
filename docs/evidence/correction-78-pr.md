## Summary

Add an optional browser-local `SpeechTranscriptCorrectionNode` for short Japanese and English final transcripts, backed by a dedicated Qwen3 0.6B Worker. Add an explicit final-transcript-to-TEXT adapter, disabled/error bypass, and a Node Playground linked from the index that uses the production Node/Pipeline and displays original and candidate text separately.

Pin the Qwen3 checkpoint/tokenizer revision, q4f16 assets and existing verified Transformers.js/ORT runtime versions; document sizes, licenses, WebGPU/shader-f16 requirements, on-demand loading and best-effort caching. Add conservative prompting, bounded decoding, format/numeric guards, lifecycle/progress/error/cancel/drain handling, tests and evidence.

## Outcome

- Correction is an explicit TEXT-to-TEXT Pipeline connection. Original ASR output remains accessible through independent connections; final-only extraction is a small adapter. ASR, translation, TTS and the extension's default graph are unchanged.
- The Playground offers text input, language selection, Generate, Cancel and bypass, with original/candidate views, a changed span, timing, errors and cache warnings. Text is processed locally; recorded traffic contains asset GETs and no network inference.
- The prompt requests minimal apparent ASR fixes and preserves meaning, language, names, figures, dates/times, negation and wording when uncertain. This is text-only candidate generation, with no acoustic verification or guarantee of semantic fidelity.
- **Draft: quality improvement is not demonstrated.** The final batch copied all 10 distinct correct fixtures and a repeated correct fixture, but missed all four intended corrections. A separate Japanese Playground run dropped “today” from a correct sentence. The original and deletion remained visible. Earlier prompt regressions are also recorded in the evidence.
- **Required post-merge Pages verification remains pending.** Keep #78 open until the deployment run URL, merged SHA, check time and fresh deployed-origin prefix/Worker/runtime/asset checks are recorded, including deployed real inference if asset access differs. This PR must not be treated as completion of those checks.

## Validation

[Implementation-stage evidence](docs/evidence/correction-78.md) and [actual model outputs/traffic](docs/evidence/correction-78.json) record:

- `npm test`: 220 passed.
- `npm run test:browser -- --workers=2`: 214 passed, 18 opt-in tests skipped; final correction-specific Chromium/WebKit checks: 30 passed.
- ASR, translation, TTS and correction asset preparation and extension build passed. `npm run test:extension`: 45 passed, four opt-in checks skipped. Unrelated real-model ASR/translation/TTS checks were not rerun.
- Deterministic tests exercise the native production Worker with heavy inference/capability mocked: typed ports, explicit adapter/bypass, ordering/drain, empty/long inputs, prompt/decoding bounds, cancellation, repeat, error recovery, cache persistence/quota warning, and repository-prefix navigation.
- Opt-in real Qwen3 inference ran through the production Worker/Pipeline in Chrome 154 on macOS with Apple WebGPU/shader-f16, using Japanese and English fixtures. Cold initialization was 69,150 ms; batch generation took 93–236 ms per input. Separate real Playground generation also ran. Runtime/privacy smoke passed; the quality misses and regression above remain material limitations.
- Small assets persisted and were reused by a fresh Worker. The 570 MB weight cache write failed visibly; a fresh Worker downloaded weights again. Offline weight availability is not established.
- PR preparation: clean worktree, `git diff --check` passed, and a merge-tree check against current `main` found no conflicts. Recorded implementation tests preceded the latest #77 merge into `main`; they are not a fresh combined-tree test run.

## Related issues

Refs #78

The Issue is **not fully verified or resolved**: post-merge Pages verification is pending, and no correction-quality improvement is claimed. Keep the PR in draft during review of these limitations and keep #78 open until its verification evidence is recorded.

## Scope check

- [ ] This PR fully addresses each Issue it claims to resolve.
- [x] This PR does not include unrelated work.
- [x] This PR does not add speculative abstractions, extensibility, frameworks, or subsystems that are not needed by the Issue.
- [x] Any intentionally partial implementation is clearly stated, and the parent Issue is not presented as fully resolved unless the remaining scope has been explicitly split out.
- [x] Validation maps to the Issue's expected outcome / acceptance criteria.
