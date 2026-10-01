# Issue #18 publication and device acceptance status

PR #20 remains partial work until the required human test results exist.
The reviewed PR commit is now published over HTTPS; publication and automated checks do
not establish physical-device compatibility or human recognition quality.

## Verified publication (2026-10-02 JST)

- HTTPS URL: https://takahirox.github.io/my-audio-to-text/ now serves
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
errors using the [manual results template](asr-manual-testing.md#results-to-carry-into-a-separate-backend-selection-issue).

| Required evidence | Status |
| --- | --- |
| Three-backend HTTPS deployment: run URL, commit SHA, check time, staged asset checks | Passed; evidence above |
| Desktop Chromium: all three real models, microphone, Japanese recognition, Stop, repeat, switching | Not tested by a human; results requested |
| Physical iPhone Safari: all three real models and the same capture/recognition lifecycle | Not tested; physical device and human tester unavailable to this node |
| Physical Android Chrome when available | Not tested; device availability unknown |

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

Publication finding: resolved for the reviewed PR commit above. Human acceptance finding:
**unresolved**. The operator was asked for desktop Chromium and physical iPhone results;
none were available at checkpoint time. A human tester must run each backend against the
live deployment, record the results here and in #21, and resolve failures that prevent
comparison. Test Android when available or record it as not tested.

This checkpoint changes documentation only; its later publication to PR #20 does not change
the deployed page, scripts, or staged assets. Keep the deployed SHA distinct from the later
documentation commit. Keep PR #20 in draft and #18/#21 open until the remaining acceptance
gate is met. Do not repeatedly redeploy to address missing human evidence, merge first, or
treat automated WebKit as a physical iPhone. No production backend is selected. Do not reset
usage limits, buy allowance, or switch models/providers to evade a limit.
