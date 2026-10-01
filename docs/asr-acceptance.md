# Issue #18 publication and device acceptance status

PR #20 remains partial work until the required publication and human test results exist.
The manual deployment path in this checkpoint removes the workflow's `main`-only build
restriction; it does not establish a successful deployment or physical-device compatibility.

## Observed live state (2026-10-02)

- HTTPS URL: https://takahirox.github.io/my-audio-to-text/ responds successfully but serves
  **my-audio-to-text Web playground**, the old placeholder. It has no ASR selector.
- Latest Pages run: [36886759434](https://github.com/takahirox/my-audio-to-text/actions/runs/36886759434)
  succeeded for `d3a600c76c8dc0bb11d91e440073ecec2e227bbb`, the placeholder implementation.
- PR #20's published head at inspection: `db2ac54fde052ec783e8bddbfb7883adc2067d86`.
  It does not yet contain this checkpoint's manual deployment fix.
- The `github-pages` environment permits only `main`. A maintainer must permit the exact
  reviewed PR branch before dispatching its deployment; other protections remain in force.
- #21 has no recorded human acceptance results. Its after-merge publication instruction
  must be updated to the [pre-merge sequence](asr-manual-testing.md#publish-for-acceptance-before-merge).

## Acceptance evidence

Fill in actual results from the deployed reviewed commit. Leave missing evidence as `not tested`.
Include device and OS/browser versions, utterance, transcripts, timings, and errors using the
[manual results template](asr-manual-testing.md#results-to-carry-into-a-separate-backend-selection-issue).

| Required evidence | Status |
| --- | --- |
| Three-backend HTTPS deployment: run URL, commit SHA, check time, staged asset checks | Not published |
| Desktop Chromium: all three real models, microphone, Japanese recognition, Stop, repeat, switching | Not tested |
| Physical iPhone Safari: all three real models and the same capture/recognition lifecycle | Not tested |
| Physical Android Chrome when available | Not tested; device availability unknown |

Automated lifecycle checks use substituted model workers and generated audio; real-model smoke
checks use a supplied WAV. Neither establishes physical microphone or iPhone acceptance.

## Checks run for this revision

- `npm test`: four audio tests passed.
- `npm run test:browser`: ten Chromium/WebKit lifecycle tests passed. Six opt-in real-model
  tests were skipped because no `ASR_TEST_WAV` was supplied.
- `python3 scripts/prepare-assets.py`: checksum verification and staging succeeded for
  Moonshine (13.7 MB) and sherpa (182.9 MB). These ignored local files must be prepared again
  by the deployment workflow; they are not part of the checkpoint's tracked files.
- Workflow YAML parsed successfully, with build-before-deploy dependency intact. Its build
  condition permits a `main` push and manual PR-branch dispatch, and rejects an ordinary
  PR-branch push or pull-request event. Automatic triggers still cover only pushes to `main`.
- `git diff --check`: passed.

## Handoff

Publish this checkpoint to PR #20 through the Run's publication step; this fix node must not push
or merge. Update PR #20 and #21 to the documented pre-merge sequence, permit the exact PR branch
in the Pages environment, dispatch the revised workflow, and record deployment and physical-device
results. Keep PR #20 in draft and #18 open until its acceptance gate is met. No production backend
is selected. Do not retry by merging first or treating automated WebKit as a physical iPhone.
