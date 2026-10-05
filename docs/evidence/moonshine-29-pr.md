## Summary

Set `max_tokens_per_second=13` for Japanese Moonshine recognition, passed as `'13'` in the pinned runtime's options map. Show the active value in the model description and document the setting.

## Outcome

Japanese Small Streaming previously used the upstream token-rate default; it now explicitly passes `13` to `Transcriber.loadFromUrls`. English keeps the upstream default. Model files, runtime selection, VAD behavior, and other ASR backends are unchanged.

## Validation

Local pre-merge checks re-run during recovery on 2026-10-05 UTC:

- `npm test`: **4 passed**.
- `npm run test:browser -- --reporter=line`: **20 passed, 30 documented skips**. The new runtime interception test checks the default Japanese language, explicit Japanese with both existing VAD thresholds, and unchanged English defaults. It also checks model architecture and file URLs. WebKit skips two module-worker interception tests; 28 opt-in real model tests were skipped without recordings.
- `npm run prepare:assets`: **passed**, using the same pinned asset preparation script as the unchanged Pages workflow.
- `git diff --check`: **passed**.
- Scope review: the diff from the PR base is limited to configuration, runtime option forwarding, diagnostics, documentation/evidence, and browser tests. No unrelated ASR tuning or backend changes are included.

## Required post-merge verification

**None**, as specified by the current [Issue #29](https://github.com/takahirox/my-audio-to-text/issues/29).

The earlier deployment and published-revision/Japanese-model checks were not performed. They are superseded requirements, not pending acceptance work for #29; local validation does not establish those published-site results.

## Related issues

Closes #29

The implementation and current pre-merge acceptance criteria are satisfied. Ordinary PR review determines merge readiness.

## Scope check

- [x] This PR fully addresses each Issue it claims to resolve, under the current Issue #29 criteria.
- [x] This PR does not include unrelated work.
- [x] This PR does not add speculative abstractions, extensibility, frameworks, or subsystems that are not needed by the Issue.
- [x] Any intentionally partial implementation is clearly stated, and the parent Issue is not presented as fully resolved unless the remaining scope has been explicitly split out. No implementation scope is deferred.
- [x] Validation maps to the Issue's expected outcome / acceptance criteria.
