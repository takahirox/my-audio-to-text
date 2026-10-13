# Issue #91: review corrections

## Changes

TranscriptView no longer clears its provisional input whenever an independently
connected final input arrives. The session coordinator observes ASR completion
only when SpeechToText.provisional supplies the transcript preview. It waits
for already queued transcript deliveries and checks a session-local revision
before clearing that preview, preserving newer utterances even when their text
is identical. Other provisional streams retain their own state until an explicit
empty update, Stop or Cancel. No shared port contracts or edge validation change.

Deterministic unit regressions cover both translation directions, with and
without optional paired result ports, queued preview delivery, equal-string
distinct utterances, delayed translations, Stop and Cancel. Packaged MV3
regressions explicitly hold and release a translation so the ordering check
does not depend on inference timing.

PR [#92](https://github.com/takahirox/my-audio-to-text/pull/92) now references
`Refs #91` instead of an automatic closing directive. Its required post-merge
verification record remains pending. The GitHub head was not changed by this
revision node; publication of the local checkpoint remains downstream work.

## Separator finding: contradicted by the selected base

The separator finding is not a regression introduced by #91. Commit
`baeccc3850f4a823682717116f3a0b84747fc4a8` (`fix: append focused-field TEXT
verbatim (#89)`) deliberately removed automatic spaces and is an ancestor of
PR #92's base `4747ae2048b34ccd054b8547ba45476c9f030e59`.
`git diff 4747ae2 HEAD -- extension/page-agent.js` is empty at the incoming
checkpoint. Closed Issue [#89](https://github.com/takahirox/my-audio-to-text/issues/89)
requires exact incoming strings, including consecutive Japanese utterances
without separators and explicit upstream whitespace. Current extension
documentation and packaged field tests require the same behavior.

Restoring automatic spaces would reverse #89 and change behavior outside #91.
The page agent is preserved. Its existing four field tests now also cover the
review's `manual` + `Hello` + `world` example, asserting `manualHelloworld` and
the exact event data, alongside explicit upstream spaces and whitespace.
Re-review should dismiss this finding using the base/history evidence.

## Validation

| Command | Revision result |
| --- | --- |
| `npm test` | 249 passed, 0 failed/skipped |
| `npm run test:browser -- tests/browser/text-contracts.spec.js` | 2 passed, 0 failed/skipped (Chromium and WebKit) |
| `npm run build:extension` | Passed after pinned asset preparation |
| `npm run test:extension` | 83 passed, 5 optional real-model checks skipped, 0 failed (2.6 min) |
| `git diff --check` | Passed |

The initial build/check attempts lacked generated assets and a local Playwright
installation. ASR, translation and TTS asset preparation and `npm ci` completed
before the successful build and browser checks. The full browser suite was not
rerun for this extension-session revision; its upstream results remain in
[the implementation record](ports-91.md). Optional real-model inference was not
run, and deployment verification is not claimed.

Both new packaged translation regressions and all four verbatim insertion
regressions passed. The five skips are the existing opt-in real TTS (two),
ASR-to-field (one) and ASR-to-OPUS-MT (two) inference checks. The mandatory
packaged suite initialized the real pinned ASR/Silero workers under MV3 CSP.
No test failures were accepted as flaky, and retries were disabled.

## Runtime guide and PR reference corrections

The runtime guide now describes version 4 extension graphs, explicit legacy
migration and direct shared TEXT connections from ASR finals to correction and
other text consumers, including fan-out to preserve the original transcript.
It no longer instructs readers to use the removed final-text adapter.

PR #92's closing directive was replaced with `Refs #91` again, preserving its
pending deployment record. A read-back verified the corrected description and
unchanged head `e62527024d7bc4054466d7bc7cb6a8fb8abcbff7`.
The [saved PR description](ports-91-pr.md) records this correction for downstream
publication; retain the non-closing reference until required verification is
performed and recorded.

For this documentation/metadata revision, `npm test` passed all 249 tests with
no failures or skips. Documentation links, graph version and named TEXT ports
were checked against the current modules; `git diff --check` passed. Browser,
extension/build and optional real-model checks were not rerun for this revision.
No push or merge was performed.

## Required post-merge verification — pending

If merging triggers Playground publication, verify deployment completion, the
published revision, updated pages and core text flows on the published origin,
then record evidence before closing Issue #91. No push or merge was performed.
