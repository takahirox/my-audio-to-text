# my-audio-to-text

A local-first speech input system that turns natural speech into useful text and learns to recognize each individual user better over time.

## Motivation and current status

Speech input should work well for the person using it, including their language, vocabulary, pronunciation, and speaking conditions. Corrections should help improve future recognition while keeping the original speech and transcript available.

This repository is a minimal product and vision baseline, ready for a new design from first principles. The previous macOS prototype, experiments, evaluation harnesses, and implementation documents have been removed from the active tree. All previous work remains recoverable from Git history.

The browser Speech-to-Text playground uses **ReazonSpeech ja-en simulated streaming as the current development baseline**, with sherpa-onnx and Silero VAD. This is a replaceable baseline for continued product work, not an irreversible production-backend decision. Previous Moonshine, two-pass, Japanese-only ReazonSpeech, and Whisper experiments remain recoverable from Git history. Backward compatibility with removed experiments is not required.

## Web playground

Published URL: [https://takahirox.github.io/my-audio-to-text/](https://takahirox.github.io/my-audio-to-text/).

The retained hayamimi-inspired path uses 0.8-second pre-roll, provisional recognition about every 0.5 seconds of active speech, a 0.35-second trailing-silence endpoint, and a 12-second maximum utterance duration. Stop finalizes active speech. Silero VAD and ASR run in separate workers; inference is serialized, superseded previews are coalesced, and pending audio is bounded at 30 seconds. ReazonSpeech uses the evidence-based one-thread default from [Issue #38](docs/evidence/reazon-38.md).

The microphone feeds normalized PCM into the documented [local ASR core boundary](docs/local-asr-core.md); capture/resampling stays outside recognition orchestration.

See [setup, testing, and limitations](docs/asr-manual-testing.md). Automated Chromium/WebKit checks cover loading, provisional/final output, Stop, Cancel, repeat, worker isolation, and stale-result rejection. The [Issue #45 validation record](docs/evidence/reazon-45.md) records the current local checks. The [historical acceptance record](docs/asr-acceptance.md) and [experiment evidence](docs/evidence/) preserve completed comparisons and publication observations; they are not instructions for the current baseline.

The [Pages workflow](.github/workflows/pages.yml) prepares only the pinned ReazonSpeech ja-en/Silero runtime assets and deploys `web/` automatically on pushes to `main`. A maintainer can manually dispatch it on the exact reviewed PR branch permitted by the `github-pages` environment, retaining existing protections. Inference runs in the browser; loading about 91 MB of model/runtime assets needs no ASR server.

For setup, select **Settings → Pages → Build and deployment → Source → GitHub Actions**. The workflow uses the `github-pages` environment and built-in `GITHUB_TOKEN`.

### Completed static-placeholder validation (#17)

[Issue #17](https://github.com/takahirox/my-audio-to-text/issues/17) is completed. Its static-placeholder validation is separate from ASR acceptance: Pixel 7a / Chrome displaying placeholder text does not establish model loading, microphone capture, or recognition for Issue #18. The table below preserves the verified placeholder results; publishing the ASR branch supersedes the placeholder content without invalidating that historical evidence.

Validation evidence recorded on October 2, 2026 (JST; evidence timestamps use UTC):

| Issue #17 acceptance check | Result and evidence |
| --- | --- |
| Initial Pages workflow on `main` | **Passed.** [Run 36886759434](https://github.com/takahirox/my-audio-to-text/actions/runs/36886759434), event `push`, succeeded at `2026-10-01T15:45:54Z` for commit `d3a600c76c8dc0bb11d91e440073ecec2e227bbb`. |
| Canonical public URL over HTTPS | **Passed.** HTTP 200 with normal TLS certificate verification. The initial check was at `2026-10-01T15:53:40Z`; [post-merge evidence](docs/evidence/pages-redeployment.md) confirms revision 2 at the same URL. |
| Published placeholder in a desktop browser | **Passed.** Chrome `154.0.8037.58` on macOS rendered the initial page at `2026-10-01T15:55:59Z` ([historical screenshot](docs/evidence/pages-desktop-initial.png)). A fresh isolated headless desktop check also rendered revision 2 ([evidence and screenshot](docs/evidence/pages-redeployment.md)). Neither check claims physical-mobile validation. |
| Actual mobile browser | **Passed — user-reported physical-device check.** Pixel 7a with Chrome rendered `my-audio-to-text` and `The Web playground is deployed. Placeholder revision 2.` at the canonical URL. The report was recorded at `2026-10-01T22:01:26.247000+00:00` (UTC; October 2, 2026 JST). Browser version was not supplied. See [mobile evidence](docs/evidence/pages-redeployment.md#actual-mobile-browser). |
| Subsequent reviewed change and automatic redeployment | **Passed.** PR #19 merged as `28f0badabb1834a1a8fe15dc248aaeebbb393412`. Automatic [push run 36931736950](https://github.com/takahirox/my-audio-to-text/actions/runs/36931736950) succeeded. The canonical URL rendered `The Web playground is deployed. Placeholder revision 2.`; see [the recorded browser check](docs/evidence/pages-redeployment.md). |


[PR #19](https://github.com/takahirox/my-audio-to-text/pull/19) supplied the reviewed placeholder revision; [PR #22](https://github.com/takahirox/my-audio-to-text/pull/22) recorded its successful automatic redeployment, desktop screenshot, and user-reported physical-mobile result. The [redeployment evidence](docs/evidence/pages-redeployment.md) and [original partial PR description](docs/evidence/pages-validation-pr.md) retain those historical checks.

## Vision

Build a speech input system that:

1. Turns natural speech into useful text.
2. Becomes better at recognizing the individual user over time.
3. Preserves source audio and original transcripts separately from derived or corrected output; derived output never overwrites its source.
4. Can eventually work across Web, desktop, and mobile, without being tied to macOS.

## Near-term priorities

### 1. Speech-to-Text

- Realtime, low-latency recognition.
- Good Japanese recognition.
- Usable from mobile and desktop browsers.

### 2. Personalized ASR

Personalized automatic speech recognition (ASR) should:

- Learn from user corrections.
- Improve recognition of personal vocabulary, pronunciation, recurring mistakes, and quiet speech, eventually extending to whisper speech.
- Demonstrate improvement on held-out real audio that was not used for personalization.

## Deferred priority

**Speech → Thought / synthesis** remains part of the broader vision. It comes after robust Web Speech-to-Text and Personalized ASR, rather than being the next implementation priority.

## Design principles

- Local-first where practical.
- Web-first for the next development cycle, with a path to desktop and mobile beyond the Web.
- Keep models and runtimes replaceable; the vision does not depend on Whisper, llama.cpp, Swift, or any specific model or runtime.
- Measure accuracy, latency, memory, CPU/GPU usage, battery impact, and personalization learning curves.
- Prefer a small, understandable baseline over historical implementation complexity.

## Follow-up work

Separate issues should define and implement:

- Web/PWA foundation.
- Browser microphone and audio pipeline.
- Web ASR technology evaluation, including sherpa-onnx/WASM and alternatives.
- Personalized ASR data and feedback loop.
- Cross-platform product contracts.

## Contributing

See the [development flow](docs/development-flow.md) for workflow and language policy, and the [review guidelines](docs/review-guidelines.md) for review and merge criteria.
