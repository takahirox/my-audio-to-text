## Summary

Set `max_tokens_per_second=13` for Japanese Moonshine recognition, passed as `'13'` in the pinned runtime's options map. Show the active value in the model description and document the setting.

## Outcome

Japanese Small Streaming previously used the upstream token-rate default; it now explicitly passes `13` to `Transcriber.loadFromUrls`. English keeps the upstream default. Model files, runtime selection, VAD behavior, and other ASR backends are unchanged.

## Validation

Validation reported by the implementation node for the published changes:

- Unit tests: **4 passed**.
- Browser tests: **20 passed, 30 documented skips**. The new runtime interception test checks the default Japanese language, explicit Japanese with both existing VAD thresholds, and unchanged English defaults. It also checks model architecture and file URLs. WebKit skips module-worker interception; real model smoke tests require explicit opt-in.
- Pages asset preparation: **passed**, using the existing preparation script.
- Publication check: `git diff --check` passed; the diff is limited to configuration, runtime option forwarding, diagnostics, documentation, and browser tests.

Required post-merge verification remains **pending**:

- Confirm the GitHub Pages deployment succeeds for the merged revision.
- Confirm the published playground serves that revision and successfully loads the Japanese Moonshine model.

These checks have not been performed and are not established by local validation. Keep Issue #29 open until they are performed and their results are recorded after merge.

## Related issues

Refs #29

Implementation and pre-merge scope are complete; the required post-merge verification above remains pending.

## Scope check

- [ ] This PR fully addresses each Issue it claims to resolve. Implementation is complete; full verification remains pending until the required post-merge checks are recorded.
- [x] This PR does not include unrelated work.
- [x] This PR does not add speculative abstractions, extensibility, frameworks, or subsystems that are not needed by the Issue.
- [x] Any intentionally partial implementation is clearly stated, and the parent Issue is not presented as fully resolved unless the remaining scope has been explicitly split out. No implementation scope is deferred; required post-merge verification is explicitly pending.
- [x] Validation maps to the Issue's expected outcome / acceptance criteria.
