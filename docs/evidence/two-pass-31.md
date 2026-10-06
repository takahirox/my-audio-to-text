# Japanese two-pass experiment validation (#31)

Local automated validation on 2026-10-05 UTC for
[Issue #31](https://github.com/takahirox/my-audio-to-text/issues/31).
The experiment reuses the existing Japanese Moonshine configuration and ReazonSpeech
recognizer. No runtime assets, model versions, ASR tuning, or deployment workflow changed.

## Results

| Check | Result and evidence |
| --- | --- |
| Select and load Japanese-only two-pass mode | Passed in Chromium and WebKit. Switching from English forces Japanese and disables language selection. Start remains disabled until both workers report Ready. The Moonshine load requests Japanese and the existing default threshold; the description shows `max_tokens_per_second=13`. |
| Streaming text before Stop | Passed in both browsers using controlled workers and real browser microphone capture from a synthetic oscillator. The active Moonshine partial is visible; completed Moonshine lines remain visible while recording. The ReazonSpeech final area stays empty. |
| No second pass before Stop | Passed in both browsers. The second worker receives only its model load during recording, including when Moonshine emits a completed line. |
| Same retained recording after Stop | Passed in both browsers. Every sample transferred to Moonshine, including the microphone Stop flush, equals the single utterance transferred to ReazonSpeech. Its final result is displayed separately after controlled decode completion. |
| Repeat recordings | Passed in both browsers. Both text areas reset; the second utterance equals only the new recording. Delayed first-pass partial/final/error/Stop events and second-pass final/Stop events from the previous session are ignored. |
| Cancel, reload and switching | Passed in both browsers. Cancel while recording or while awaiting second-pass completion clears both results, stops the microphone track, and terminates both workers. Saved old worker callbacks cannot populate a replacement recording. Switching a loaded two-pass mode to Whisper terminates both workers and resets output. |
| Recognition stream cleanup | Passed in Chromium using actual worker scripts with upstream runtime fixtures. Moonshine closes each recording stream and preserves original session IDs on delayed callbacks/errors. ReazonSpeech reuses one recognizer, accepts the complete 16 kHz waveform, frees each stream even on decode failure, and completes empty audio without creating a stream. |
| Original backend regression checks | Passed in Chromium and WebKit for Moonshine-only, ReazonSpeech-only and Whisper: load, capture, Stop, repeat. Existing language/threshold, isolation, capture-denial, delayed-permission, Stop-flush cancellation and quiet-signal checks also pass. |
| Audio unit tests | Passed: 4 tests for resampling continuity, quiet audio retention, pause segmentation and long utterances. |
| Syntax and whitespace | Passed: `node --check` on changed application/worker scripts and `git diff --check`. |

Commands:

```sh
npm ci
npm test
npm run test:browser
node --check web/app.js
node --check web/model-worker.js
node --check web/sherpa-worker.js
git diff --check
```

Final browser suite: **38 passed, 34 skipped, 0 failed** (14.5 seconds).
The 34 skips comprise 30 opt-in real-model/WAV evaluations without supplied audio
and 4 WebKit runtime-import fixture checks (2 existing and 2 added here). WebKit
bypasses interception of these worker imports; the actual worker runtime fixture
checks run in Chromium, while the controlled two-pass UI/capture checks run in both.

## Limits and optional follow-up

Controlled transcripts establish ordering, audio identity and session/resource lifecycle;
they do not establish actual Japanese recognition accuracy or physical-device performance.
Real-model inference, human speech comparison, publication and physical-phone tests were
not performed. These are optional for #31. A new opt-in `two-pass: real Japanese inference
and finalization` test accepts `ASR_TEST_WAV`; see the
[run instructions](https://github.com/takahirox/my-audio-to-text/blob/a05dc1558318c9b3ca0ba6c7c5fc8fded1e18e64/docs/asr-manual-testing.md#japanese-two-pass-experiment-31).

Both loaded models coexist in memory, and recording audio is retained until Stop. This
experiment is intended for short utterances. No production architecture is selected.
Issue #31 specifies **no required post-merge verification**.
