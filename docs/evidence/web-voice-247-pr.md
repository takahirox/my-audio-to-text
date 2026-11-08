## Summary

Add default-OFF Web voice typing in Graph Library, with consent stored separately from the stable `assignments.webVoice` graph ID and explicit optional website permission. Validate a typed, executable MicrophoneAudio → … → FocusedInputTextOutputNode path without falling back to Live.

## Outcome

When enabled and authorized, eligible top-frame inputs, textareas and basic contenteditable fields show an isolated mic control. Clicking it prepares verified cached models in a compact extension-owned recording window using the existing TabSession runtime; committed text is inserted once at the saved caret in the original document and field. The session runs a snapshot of the assigned field-output ancestors, leaving other graph sinks inactive.

OFF users receive no injected controls or feature model loading. Stop drains final output; cancellation, navigation, field removal, permission removal and disabling abort the session. A shared runtime lease prevents conflicts with Live and other tabs. Graph schema/version and Live assignment remain unchanged.

## Validation

- This documentation-only scope correction reuses the recorded implementation validation below; extension code and tests are unchanged from `17e1eda`. Markdown structure, links/anchors, consistency with the current Issue and `git diff --check` were checked. Unit, browser and real-model suites were not rerun for this wording change.
- The latest fix restores focus/selection listeners and reconnects controls after back-forward-cache restoration, rechecking consent without resuming the canceled recording. The installed-extension regression confirms `pageshow.persisted`, fresh-session caret insertion, no late writes or auto-submit, and OFF while cached. It reproduced the missing mic before the fix and passed afterward.
- Validation for implementation commit `17e1eda` passed **863 unit tests**, **21 affected installed-extension tests** (14 Web voice tests with controlled inference and 7 Graph Library tests), and `git diff --check`. Real-model and human permission checks were not rerun for this lifecycle fix.
- The earlier fix refreshes the idle mic target after a session completes, or removes it when focus is outside supported editors. Its repeated-session regression failed before the fix and passed afterward.
- Review of head `443f65b` reports **863 unit tests** and **21 installed-extension tests**, including **13 Web voice tests with mocked inference**, passed. Another **23 tests could not start** because `dist/chrome-extension` was absent. Real-model tests were not rerun during that review.
- Earlier publication verification recorded a passing `git diff --check` and verified the PR head against the complete worktree tree; it did not rerun tests.
- Upstream implementation evidence records successful extension packaging and **43 affected installed-extension tests**, including opt-in/permissions, saved selection, sensitive fields, replay/sender rejection, busy state and cleanup.
- Upstream real-model Chrome extension run used packaged ReazonSpeech/Silero, native getUserMedia and a fake microphone carrying the pinned speech fixture: three final utterances each into native input and textarea, matching final events exactly once, preserved caret, graceful Stop, no submit or remote requests.
- Details: [validation evidence](https://github.com/takahirox/my-audio-to-text/blob/443f65b22970c5fd451d0a130dc6119eb867c71a/docs/evidence/web-voice-247.md), [real-model results](https://github.com/takahirox/my-audio-to-text/blob/443f65b22970c5fd451d0a130dc6119eb867c71a/docs/evidence/web-voice-247-real.json), and [workflow/manual guidance](https://github.com/takahirox/my-audio-to-text/blob/443f65b22970c5fd451d0a130dc6119eb867c71a/docs/chrome-extension.md#opt-in-web-voice-typing-247).

Native host/microphone permission-dialog button clicks and physical microphone hardware were not exercised. Host grants were seeded through a disposable installation/upgrade fixture; microphone permission used CDP. Actual microphone-setting revocation and GPU-device loss remain unverified. Rich editors, Shadow DOM, frames and universal native undo remain documented limitations.

## Optional later owner checks

The [current Issue completion scope](https://github.com/takahirox/my-audio-to-text/issues/247) supersedes the earlier comment requiring these checks after merge. Manual installed-Chrome checks are optional later notes, not acceptance criteria or required post-merge verification. Their unperformed status does not block review, merge, Issue closure or Project Done, and does not require another Issue or human gate. No human test result is claimed.

When performed, record the Chrome version and observations for native website/microphone permission denial and grant, then real microphone dictation into native input and textarea. Check caret placement, single insertion, Stop and no automatic submission. During recording, try microphone revocation through Chrome settings and observe capture/session shutdown, the actionable error and suppression of late insertion. These manual checks have not been performed.

Applicable automated validation and fixes for demonstrated defects remain required before merge.

## Related issues

Closes #247.

## Scope check

- [x] This PR does not include unrelated work.
- [x] This PR does not add speculative abstractions, extensibility, frameworks, or subsystems that are not needed by the Issue.
- [x] Any intentionally partial implementation is clearly stated, and the parent Issue is not presented as fully resolved unless the remaining scope has been explicitly split out.
- [x] Validation maps to the Issue's expected outcome / acceptance criteria.
