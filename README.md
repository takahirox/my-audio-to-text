# my-audio-to-text

A local-first composable processing system that connects reusable input and processing capabilities into pipelines for useful derived information.

## Current implemented capabilities

Speech-to-text is the most-developed processing capability today. The Web playground and Chrome extension provide the **first concrete pipeline**:

```text
Microphone / browser-tab / Chrome-extension tab audio
        ↓
Local ASR Core
        ↓
ReazonSpeech ja-en + Silero/hayamimi
        ↓
provisional / final transcript
```

Capture helpers normalize audio to mono 16 kHz PCM before passing it to the [Local ASR Core](docs/local-asr-core.md). ReazonSpeech ja-en, sherpa-onnx, Silero VAD and the hayamimi-inspired simulated-streaming policy are the core's current implementation. This replaceable ASR baseline is one processing capability within the product vision.

The broader Node/port composition model is future architectural direction, described in the [processing pipeline architecture](docs/processing-pipeline.md). A general pipeline runtime and additional processors are not implemented. Previous macOS, Moonshine, two-pass, Japanese-only ReazonSpeech and Whisper experiments remain recoverable from Git history; backward compatibility with removed experiments is not required.

## Web playground

Published URL: [https://takahirox.github.io/my-audio-to-text/](https://takahirox.github.io/my-audio-to-text/).

The retained hayamimi-inspired path uses 0.8-second pre-roll, provisional recognition about every 0.5 seconds of active speech, a 0.35-second trailing-silence endpoint, and a 12-second maximum utterance duration. Stop finalizes active speech. Silero VAD and ASR run in separate workers; inference is serialized, superseded previews are coalesced, and pending audio is bounded at 30 seconds. ReazonSpeech uses the evidence-based one-thread default from [Issue #38](docs/evidence/reazon-38.md).

Microphone or browser-tab audio feeds normalized PCM into the documented [local ASR core boundary](docs/local-asr-core.md); capture/resampling stays outside recognition orchestration. For tab audio, use a desktop Chromium browser and choose a tab with “Share tab audio” enabled in the browser sharing picker.

See [setup, testing, and limitations](docs/asr-manual-testing.md). Automated Chromium/WebKit checks cover loading, provisional/final output, Stop, Cancel, repeat, worker isolation, and stale-result rejection. The [Issue #45 validation record](docs/evidence/reazon-45.md) records the current local checks. The [historical acceptance record](docs/asr-acceptance.md) and [experiment evidence](docs/evidence/) preserve completed comparisons and publication observations; they are not instructions for the current baseline.

A minimal [Chrome extension PoC](docs/chrome-extension.md) starts current-tab
transcription from the toolbar without the sharing picker. It reuses the Web
ASR core and audio helpers, restores audible tab playback, and shows transcripts
in a persistent window. See its guide for building/loading the unpacked extension,
permissions, lifecycle behavior and automated tests.

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

Following [Issue #7: Product vision](https://github.com/takahirox/my-audio-to-text/issues/7), build small reusable capabilities that compose into local processing pipelines:

```text
Input/source nodes
        ↓
reusable local processing nodes
        ↓
composable pipelines
        ↓
outputs / derived information
```

Future inputs may include files, Web/article text and platform-specific sources alongside today's microphone and tab audio. Future processing capabilities may include translation, summarization, topic extraction/analysis, storage and visualization. These are architectural examples, not implemented features.

Personalized ASR remains an important future capability/node within this system. It should learn from corrections to improve personal vocabulary, pronunciation, recurring mistakes and quiet speech, eventually including whisper speech. Success requires improvement on held-out real audio without unacceptable regression; personalization is not implemented today.

See the [architecture guide](docs/processing-pipeline.md) for conceptual nodes, typed ports and examples that distinguish existing behavior from future composition.

## Near-term direction

- Continue improving the reusable speech-to-text capability, including Japanese recognition, latency and browser usability.
- Prove a small number of real processors and useful pipelines. Candidates include speech-to-text → translation, committed transcript → incremental summary, or article/text → summary; each needs its own implementation Issue.
- Define the minimum Node/port contract only when a concrete next processor requires it, using the existing audio-source and Local ASR Core boundaries as a foundation.
- Develop personalized ASR data, correction and evaluation work as an independently evolving capability.

## Deferred work

A graphical node editor, plugin marketplace and general workflow framework are not current implementation priorities. A universal plugin SDK, workflow language or distributed/cross-platform runtime is neither implemented nor required now. Consider broader orchestration or a generic node UI only after real processors and pipelines demonstrate a need.

## Design principles

- Prefer execution and storage on the user's device where practical, without requiring a central processing server.
- Choose node boundaries around independently executable, configurable and replaceable processing units. Provisional/realtime and final output do not inherently require separate nodes.
- Compose through small typed input/output contracts; a node may expose multiple ports.
- Allow streaming updates, committed events and accumulated/long-form processing to coexist. Each processor decides how to consume its inputs.
- Keep models, implementations and runtimes replaceable across Web, browser extensions, desktop and mobile. Share useful contracts and behavior without requiring identical runtimes.
- Preserve source data and original transcripts separately from derived or corrected output; derived output should not silently overwrite its source. Persistent source/history storage remains future work.
- Measure accuracy, latency, memory, CPU/GPU usage, battery impact, long-session behavior and personalization improvement where relevant.
- Extract small abstractions from working pipelines before adding generic infrastructure.

## Follow-up work

Separate issues should define and implement:

- A concrete next processor and its useful pipeline, then the minimum composition contract it needs.
- Additional sources such as files or Web/article text when a real use case requires them.
- Transcript/history storage and accumulated processing for summaries or topic analysis/visualization.
- Personalized ASR data, feedback and held-out evaluation.
- Platform-specific implementations across Web, extensions, desktop and mobile that reuse appropriate processing contracts.

## Contributing

See the [development flow](docs/development-flow.md) for workflow and language policy, and the [review guidelines](docs/review-guidelines.md) for review and merge criteria.
