## Summary

Record the historical initial live Pages deployment, HTTPS access, and desktop rendering for Issue #17 in the README, including the published URL and desktop screenshot. Document the superseding manual branch deployment and latest HTTPS content check. Prepare the small static placeholder change `The Web playground is deployed. Placeholder revision 2.` for the subsequent deployment check.

## Outcome

The initial placeholder was publicly available at https://takahirox.github.io/my-audio-to-text/ following the merge of PR #16, at the historical check times below. It has since been superseded by a manual deployment from `codex/issue-18-browser-asr-pocs`; the latest HTTPS check served `Japanese Speech-to-Text playground` with ASR controls. This is **intentional partial work for Issue #17**: three initial live checks have historical evidence; actual mobile-browser validation and the subsequent reviewed merge into `main` with automatic redeployment remain pending. The manual branch deployment does not satisfy that redeployment criterion.

Review this PR as intentional partial work under the repository's development flow. After this partial scope passes review, it can be marked ready and merged while Issue #17 stays open. Record the two pending live checks in a follow-up evidence update; claim completion only after all five acceptance checks have recorded evidence.

Use this checked-in description as PR #19's complete body for publication updates. Both pending checks must remain explicit, and the Issue #17 reference must remain non-closing. The README links this description for subsequent updates.

## Validation

- Historical initial deployment: [Pages run 36886759434](https://github.com/takahirox/my-audio-to-text/actions/runs/36886759434) succeeded on `main` for commit `d3a600c76c8dc0bb11d91e440073ecec2e227bbb` via the `push` event, completing at `2026-10-01T15:45:54Z`.
- Historical initial HTTPS check: the canonical URL returned HTTP 200 with TLS certificate verification successful at `2026-10-01T15:53:40Z`.
- Historical initial desktop check: Google Chrome `154.0.8037.58` on macOS, headless desktop mode at 1280 × 800, rendered the published initial heading and text at `2026-10-01T15:55:59Z`; the inspected screenshot is in `docs/evidence/pages-desktop-initial.png`. This screenshot predates the superseding deployment.
- Historical revision checks at `2026-10-01T16:31:37Z`: the canonical URL returned HTTPS 200 with TLS certificate verification successful and still served the initial text without revision 2. At that time, GitHub reported the initial commit on `main`, one successful Pages run, and no Issue #17 comments supplying mobile evidence.
- Superseding deployment: [Pages run 36894283644](https://github.com/takahirox/my-audio-to-text/actions/runs/36894283644) succeeded via `workflow_dispatch` on branch `codex/issue-18-browser-asr-pocs`, deploying commit `66fb43f82b5a29df7c3e96efc9e0dfe3bb33a444` and completing at `2026-10-01T16:45:43Z`. This manual branch deployment does **not** satisfy Issue #17's subsequent reviewed change merged into `main` and automatic redeployment criterion.
- Latest content checks: the review check at `2026-10-01T16:48:58Z` and a fresh HTTPS check at `2026-10-01T16:51:01Z` returned HTTP 200 with `Japanese Speech-to-Text playground` and ASR controls. The fresh check verified TLS successfully and found neither the initial placeholder text nor revision 2. GitHub still reported `main` at `d3a600c76c8dc0bb11d91e440073ecec2e227bbb` and PR #19 open and unmerged.
- Local revision checks passed: `git diff --check`, placeholder HTML structure and expected text, README relative links, and staged partial-work instructions. These local checks do not establish publication of revision 2.
- **Pending:** open the canonical published URL on an actual phone/tablet and record device model, browser/version, check time with timezone, and rendered text/result. Viewport emulation is insufficient.
- **Pending:** after the reviewed merge, record the subsequent deployed commit SHA, successful automatic Pages run URL (`push` event), and browser/version, check time, and visible revision 2 text at the same URL.

## Related issues

Related to #17 (intentional partial work).

Issue #17 must remain open after this partial PR merges. Actual mobile-browser evidence and the subsequent reviewed deployment with changed content confirmed in a browser remain pending.

Only after all five live checks have recorded evidence should the completion PR use this closing reference:

```text
Closes #17
```

PR #16 supplied the merged infrastructure. This continues the live validation scope split from #15.

## Scope check

- [ ] This PR fully addresses each Issue it claims to resolve. (No resolution of Issue #17 is claimed; two live checks remain pending.)
- [x] This PR does not include unrelated work.
- [x] This PR does not add speculative abstractions, extensibility, frameworks, or subsystems that are not needed by the Issue.
- [x] Any intentionally partial implementation is clearly stated, and the parent Issue is not presented as fully resolved unless the remaining scope has been explicitly split out.
- [x] Validation maps to the Issue's expected outcome / acceptance criteria.
