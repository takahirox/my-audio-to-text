## Summary

Speech recognition and extension translation previously required processor-specific object payloads and extraction adapters for ordinary text consumers. Expose shared `TEXT` strings from SpeechToText, TranscriptOutput and TranslationScheduler, remove redundant adapters, and update their shared Pipeline, Playground and extension consumers.

Document the repository-wide contract audit in [docs/port-contracts.md](docs/port-contracts.md). Keep identity and ordering inside the responsible nodes, and retain a small optional `TEXT_RESULT` contract where the paired translation view needs atomic source/result/status alignment. Captured and synthesized audio keep their distinct contracts.

## Outcome

- Connect `SpeechToText.final → Translation.text → FocusedInputTextOutput.text` directly, with fan-out to TTS or other TEXT consumers. Provisional and final semantics remain explicit in port names.
- Text-only consumers need no metadata. Paired views use optional result ports without assuming independently emitted ports are synchronized.
- Validate edges by contract identity, retaining required-input, cardinality, cycle, settings and audio constraints. Remove producer-identity restrictions on otherwise compatible edges.
- Preserve same-string distinct utterances, ordered once-only finals, superseded provisional work, source/result alignment, pending/error/canceled reporting, Stop drain and Cancel stale-work suppression.
- Explicitly migrate persisted graph versions 1–3 to version 4, bypassing extraction adapters while preserving every outgoing route. Invalid legacy graphs show a recovery path without overwriting stored routes.
- Preserve newer ASR previews when independently connected delayed translation finals arrive; session-local completion bookkeeping clears only the completed preview.
- Clear scheduler-owned translated previews when final input invalidates provisional work, before inference, while preserving newer independent previews.
- Preserve the focused-field sink's verbatim insertion behavior required by #89, including explicit upstream whitespace.
- Update architecture, graph and Node documentation and deterministic shared, Playground and packaged MV3 regression coverage.

## Validation

Committed evidence: [implementation validation](docs/evidence/ports-91.md) and [review corrections](docs/evidence/ports-91-review-fixes.md).

Checks reported by the extension-session correction node:

- `npm test`: 249 passed, 0 failed/skipped.
- `npm run test:browser -- tests/browser/text-contracts.spec.js`: 2 passed across Chromium and WebKit, 0 failed/skipped.
- `npm run build:extension`: passed after pinned asset preparation.
- `npm run test:extension`: 83 passed, 5 optional real-model checks skipped, 0 failed.
- `git diff --check`: passed.

The subsequent documentation/metadata correction reran `npm test`: 249 passed, 0 failed/skipped, and passed documentation checks and `git diff --check`. Browser, extension/build and optional real-model checks were not rerun for that revision.

The latest scheduler preview correction ran `npm test`: 253 passed, 0 failed/skipped; the targeted browser text-contract tests: 2 passed (Chromium and WebKit); the extension build: passed; and the full packaged MV3 suite: 87 passed, 5 optional real-model checks skipped, 0 failed. All four new translated-preview regressions passed, with both translation directions and optional paired metadata connected or disconnected. `git diff --check` passed. The full browser suite and optional real-model inference smoke were not rerun for this correction.

The implementation node previously ran the full browser suite: 218 passed, 18 optional checks skipped, 0 failed. The full browser suite was not rerun after the extension-session correction. Optional real-model inference smoke was not run; deterministic inference fixtures do not establish model quality. The packaged suite initialized real pinned ASR/Silero workers under MV3 CSP. No test failures were accepted as flaky and retries were disabled.

Coverage includes direct TEXT connections across producers, fan-out, optional metadata, valid/invalid edges, translation ordering/errors, same-string distinct utterances, final-only field output, Stop/Cancel, migration/recovery, delayed-final preview handling and verbatim field insertion.

Publication checked the clean worktree, fast-forward ancestry from the existing PR head and current remote main, and the complete diff with `git diff --check`. Test suites were not rerun during publication.

**Required post-merge verification: None.** Issue #91 requires all acceptance criteria to be achievable and verifiable before merge. This supersedes the earlier pending deployment requirement and closure gate. Any desired deployment verification belongs in a separate follow-up Issue and must not gate this PR's merge or #91's closure. No deployment verification is claimed.

## Related issues

Closes #91

Implementation and pre-merge validation are complete. Issue #91 requires no post-merge verification.

## Scope check

- [x] This PR fully addresses Issue #91's implementation and pre-merge acceptance scope; no post-merge verification is required.
- [x] This PR does not include unrelated work.
- [x] This PR does not add speculative abstractions, extensibility, frameworks, or subsystems that are not needed by the Issue.
- [x] The implementation is complete; no required work is deferred until after merge.
- [x] Validation maps to the Issue's expected outcome / acceptance criteria.
