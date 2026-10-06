# Historical Issue #18 publication and acceptance status

This document records the completed comparison experiment at its historical revisions. Its backend choices and testing instructions are superseded by the [current Japanese ReazonSpeech baseline instructions](asr-manual-testing.md). Removed experiments remain recoverable from Git history.

## Maintainer decision

On 2026-10-01T23:18:07.476082+00:00, the maintainer instructed us to proceed on the assumption that the playground works, and to file and fix subsequent problems as separate Issues. This explicitly removes the pending human/device-test merge gate for PR #20 and permits completion of #18/#21 based on the implemented, published comparison environment and available automated checks.

No physical-device ASR result is claimed. Desktop human microphone/Japanese recognition, physical iPhone Safari, and Pixel 7a Chrome ASR acceptance remain **not tested**. The Pixel check for #17 established only the earlier placeholder text. Production backend selection remains a separate decision after actual comparison results exist.

The verified pre-merge application deployment is commit `6888cca542e3d9131d727f9b40f0f2c96e65d6a1`, [Pages run 36933623325](https://github.com/takahirox/my-audio-to-text/actions/runs/36933623325). All three real models reached Ready in automated Chromium with no page/runtime errors; four audio and ten lifecycle tests passed. Six opt-in inference tests were skipped without a Japanese WAV. Merge to main triggers the normal Pages deployment. Missing human evidence must not be converted into a passing test result.

## Historical preparation and acceptance checkpoints

The following records describe the earlier publication and human-testing gate before the maintainer's decision above. Their instructions to keep the PR draft or wait for human evidence are superseded by that decision; their test observations remain unchanged.

## Current branch preparation (2026-10-01T22:10:11.892Z)

Latest `main` was merged into the PR branch, retaining all completed Issue #17 placeholder evidence. README and page conflicts were resolved in favor of the ASR interface with a separate historical #17 evidence section. The browser's instructions link points to this reviewed PR branch so it is available before merge.

Checks passed: four audio tests; ten Chromium/WebKit lifecycle tests. Six opt-in real-inference tests were skipped without a supplied Japanese WAV. Pinned Moonshine and sherpa asset checksums and staging passed.

A separate automated Chromium check loaded the **real** models through the actual page and reached Ready for all three backends:

| Backend | Model loading | Initialization in this run | Browser/runtime errors |
| --- | --- | --- | --- |
| moonshine | Ready | 8.83 s | None |
| sherpa | Ready | 1.10 s | None |
| whisper | Ready | 6.92 s | None |

These durations include this desktop environment's loading conditions and are not mobile performance measurements. Model loading does not verify real microphone capture, Japanese recognition, or physical-device compatibility. Pixel 7a / Chrome is available to the operator; ASR acceptance on it is still not recorded. Human desktop and physical iPhone results also remain pending. Keep PR #20 draft and Issues #18/#21 open; wait for human results instead of repeating an AI review/fix loop.

## Current verified publication

- [Pages run 36933623325](https://github.com/takahirox/my-audio-to-text/actions/runs/36933623325) succeeded for reviewed application commit `6888cca542e3d9131d727f9b40f0f2c96e65d6a1` on `codex/issue-18-browser-asr-pocs`.
- At 2026-10-01T22:14:04.213532Z, the live HTTPS page, seven runtime/style files, and `vendor/manifest.json` returned HTTP 200 and matched the reviewed local files by SHA-256. The successful build prepared the pinned staged assets.
- At 2026-10-01T22:14:37.481Z, a separate isolated Chromium check loaded each **real** model from the live page. All reached Ready with cross-origin isolation enabled and no page/runtime errors: Moonshine 10.75 s, sherpa 21.55 s, Whisper 7.01 s initialization. These are desktop loading observations, not mobile performance or human recognition results.
- This replaces the #17 placeholder. Later documentation-only commits do not change the deployed application SHA above. Physical microphone, Japanese recognition, and required human acceptance remain pending; do not infer them from model loading.


## Historical publication (2026-10-02 JST)

- At the historical check time, https://takahirox.github.io/my-audio-to-text/ served
  **Japanese Speech-to-Text playground** with Moonshine Voice, sherpa-onnx/ReazonSpeech,
  and Whisper in its selector.
- Pages run [36894283644](https://github.com/takahirox/my-audio-to-text/actions/runs/36894283644)
  completed successfully, including both build and deploy, for reviewed PR #20 commit
  `66fb43f82b5a29df7c3e96efc9e0dfe3bb33a444` on `codex/issue-18-browser-asr-pocs`.
  This replaces the placeholder deployment of `d3a600c76c8dc0bb11d91e440073ecec2e227bbb`.
- The `github-pages` environment now permits the exact PR branch and retains `main`.
  The existing environment protections were preserved. Remove the temporary branch
  permission after acceptance and normal merge; no push or merge was performed here.
- At **2026-10-01 16:46:48 UTC** (2026-10-02 01:46:48 JST), all **110** files under the
  prepared `web/` directory returned HTTP 200 from the live HTTPS site. All response bodies
  matched their local SHA-256 hashes: **196,661,721 bytes** in total. This includes
  `vendor/manifest.json`, all 98 staged Moonshine/sherpa files, the WASM binaries, sherpa's
  model data, and the page/worker scripts. Whisper and Moonshine's downloaded models are
  fetched at runtime; this check does not establish their loading or inference on devices.
- At 16:46:20–21 UTC, automated Chromium **153.0.8010.12** and WebKit **26.6** checks on
  the live site confirmed the title, all three selector options, cross-origin isolation,
  enabled Load controls, and switching while retaining the utterance. No page errors were
  observed. These checks did not load models or exercise a physical microphone.
- #21 already specifies publication and human acceptance **before** merge. Publication
  evidence from this revision is recorded in [this comment](https://github.com/takahirox/my-audio-to-text/issues/21#issuecomment-5936161932);
  the human acceptance gate remains open.

## Acceptance evidence

Fill in actual human results from the deployed reviewed commit. Leave missing evidence as
`not tested`. Include device and OS/browser versions, utterance, transcripts, timings, and
errors using the [manual results template](asr-manual-testing.md#manual-check-and-results-template).

| Required evidence | Status |
| --- | --- |
| Three-backend HTTPS deployment: run URL, commit SHA, check time, staged asset checks | Passed; current verified publication above |
| Desktop Chromium: all three real models, microphone, Japanese recognition, Stop, repeat, switching | Not tested by a human; results requested |
| Physical iPhone Safari: all three real models and the same capture/recognition lifecycle | Not tested; physical device and human tester unavailable to this node |
| Physical Android Chrome when available | Not tested; Pixel 7a / Chrome is available to the operator; ASR testing not yet recorded |

The required per-backend human evidence is still missing:

| Human test environment | Backend | Load / capture / Japanese output / Stop / repeat / switching |
| --- | --- | --- |
| Desktop Chromium | Moonshine Voice | Not tested |
| Desktop Chromium | sherpa-onnx/ReazonSpeech | Not tested |
| Desktop Chromium | Whisper | Not tested |
| Physical iPhone Safari | Moonshine Voice | Not tested |
| Physical iPhone Safari | sherpa-onnx/ReazonSpeech | Not tested |
| Physical iPhone Safari | Whisper | Not tested |

Automated lifecycle checks use substituted model workers and generated audio; real-model
smoke checks use a supplied WAV. Neither establishes human microphone or iPhone acceptance.
No human result has been inferred from either kind of automation.

## Checks run for this revision

- `npm ci`: completed; dependency audit reported no vulnerabilities.
- `npm test`: four audio tests passed.
- `npm run test:browser`: ten Chromium/WebKit lifecycle tests passed. Six opt-in real-model
  tests were skipped because no `ASR_TEST_WAV` was supplied.
- `python3 scripts/prepare-assets.py`: checksum verification and staging succeeded for
  Moonshine (13.7 MB) and sherpa (182.9 MB). These ignored files are not tracked in the
  checkpoint; the successful Pages build independently prepared and uploaded them.
- Live HTTPS content and browser bootstrap checks: passed as detailed above.
- `git diff --check`: passed.

## Handoff

### Review finding recheck (2026-10-02 02:19 JST / 2026-10-01 17:19 UTC)

Read-only GitHub checks for this fix attempt confirmed that PR #20 is open and draft at
`58134b0be48fce0ec5fe6796e400f126ceae4ff4`, and #18 and #21 remain open. #21's sole
comment records publication and explicitly reports missing human acceptance. #18 and PR #20
have no conversation comments; no new desktop Chromium or physical iPhone Safari results
were available in these records. Human evidence was requested again in this node, but none
was supplied at checkpoint time. No physical iPhone or Android device is available to this
node. Android remains not tested; the operator's device availability is unconfirmed.

The incoming review checkpoint `30f23a2517cf042cf95bee03b138a56edb6ac93a` reports the
same unresolved P1 finding. No demonstrated implementation defect or new human evidence
was supplied. All six required backend/device combinations above remain not tested.

`npm ci` succeeded with no reported vulnerabilities. Four audio tests and ten automated
Chromium/WebKit lifecycle tests passed again; six real-model tests were skipped because
`ASR_TEST_WAV` was not supplied. These checks do not resolve the P1 human acceptance finding.
The existing manual results template records deployment identity, partial transcripts, Stop
outcome, repeat, and switching so a tester can supply all required evidence. This checkpoint
refreshes the blocker record and verified PR head; it does not add human acceptance or fix
a demonstrated code defect. No push, merge, redeployment, or GitHub write was performed.

**The P1 finding remains unresolved.** This node has no human tester or physical iPhone
available. The next required action is human testing of the published deployment, followed
by recording evidence and fixing any observed comparison blockers. Further automated checks,
documentation commits, or redeployment cannot substitute for that evidence. Do not advance
this checkpoint as accepted or ready to merge.

Resume the fix when a human tester supplies results for all three backends on desktop
Chromium and physical iPhone Safari against the published deployment. Record those results
here and in #21 using the manual results template, and fix observed failures preventing
comparison. Test Android when available or explicitly record its unavailability. Preserve
the verified publication evidence above while acceptance remains pending.

This checkpoint changes documentation only; its later publication to PR #20 does not change
the deployed page, scripts, or staged assets. Keep the deployed SHA distinct from the later
documentation commit. Keep PR #20 in draft and #18/#21 open until the remaining acceptance
gate is met. Do not repeatedly redeploy to address missing human evidence, merge first, or
treat automated WebKit as a physical iPhone. No production backend is selected. Do not reset
usage limits, buy allowance, or switch models/providers to evade a limit.

The downstream result must retain this unresolved P1 blocker. Resume acceptance work when
human results or access to a human tester with the required devices becomes available;
another documentation publication or automated review cycle cannot complete it. This
checkpoint only refreshes the handoff and check results; no acceptance finding was fixed.
